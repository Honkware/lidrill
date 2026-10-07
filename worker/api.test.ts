// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { issue } from '../src/server/guard'
import { sha256Hex, solve } from '../src/server/sha256'
import type { EngineReport, EngineRun } from '../src/server/packet'

// The Worker end to end against a fake env: in-memory KV, always-ok rate
// limits, a cache that never hits. The guard paths are exercised over HTTP
// shapes (Origin header, proof header), like guard.test.ts does for verify.
// Keep the version/TTL literals in sync with worker/index.ts (workerd
// rejects non-handler named exports, so they can't be imported).

const SECRET = 'test-secret'

const run = (lines: EngineRun['lines'], depth = 24): EngineRun => ({ lines, depth, nodes: 1_000_000, capped: false })
const cp = (value: number) => ({ type: 'cp' as const, value })

// A knight fork wins the rook; the game move Ke2 let it go; no threat
const forkFen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const forkReport = (over: Partial<EngineReport> = {}): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: forkFen,
  solution: ['d5c7', 'e8d7', 'c7a8'],
  kind: 'missed-win',
  band: 'club',
  best: [run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(500) }, { pv: ['e1e2'], eval: cp(0) }]), run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(510) }, { pv: ['e1e2'], eval: cp(5) }])],
  threat: [run([{ pv: ['a8a1'], eval: cp(-500) }, { pv: ['a8b8'], eval: cp(-510) }]), run([{ pv: ['a8a1'], eval: cp(-505) }, { pv: ['a8b8'], eval: cp(-515) }])],
  played: { uci: 'e1e2', runs: [run([{ pv: ['a8a2'], eval: cp(0) }]), run([{ pv: ['a8a2'], eval: cp(10) }])] },
  habit: { recent: [] },
  ...over,
})

const kv = new Map<string, string>()
const puts: { key: string; ttl?: number }[] = []
let packetLimitOk = true

const env = {
  ASSETS: { fetch: async () => new Response('assets') },
  OPENROUTER_API_KEY: 'test-key',
  POW_SECRET: SECRET,
  EXPLAIN_LIMIT: { limit: async () => ({ success: true }) },
  PACKET_LIMIT: { limit: async () => ({ success: packetLimitOk }) },
  PACKETS: {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      puts.push({ key, ttl: options?.expirationTtl })
      kv.set(key, value)
    },
  },
}

const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) }

async function prove(body: string, ip = '1.2.3.4'): Promise<string> {
  const c = await issue(SECRET, ip)
  const n = solve(c.nonce, sha256Hex(body), c.bits)!
  return `${c.nonce}.${c.exp}.${c.bits}.${c.sig}.${n}`
}

async function post(path: string, body: unknown, opts: { origin?: string; proof?: string | null; method?: string } = {}): Promise<Response> {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: opts.origin ?? 'http://localhost:5173',
    'cf-connecting-ip': '1.2.3.4',
  }
  if (opts.proof !== null) headers['x-lidrill-proof'] = opts.proof ?? (await prove(text))
  return worker.fetch(new Request(`http://localhost${path}`, { method: opts.method ?? 'POST', headers, ...(opts.method && opts.method !== 'POST' ? {} : { body: text }) }), env as never, ctx)
}

beforeEach(() => {
  kv.clear()
  puts.length = 0
  packetLimitOk = true
  vi.stubGlobal('caches', { default: { match: async () => null, put: async () => {} } })
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/packet', () => {
  it('guards like /api/explain: POST + Origin + proof of work', async () => {
    const body = JSON.stringify(forkReport())
    expect((await post('/api/packet', body, { proof: null })).status).toBe(401)
    expect((await post('/api/packet', body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('/api/packet', body, { origin: 'https://evil.example', proof: null })).status).toBe(403)
    expect((await post('/api/packet', body, { method: 'GET' })).status).toBe(405)
  })

  it('builds and stores the packet once, stamped client-lite, with a 30-day TTL', async () => {
    const res = await post('/api/packet', forkReport())
    expect(res.status).toBe(201)
    const { packetHash } = (await res.json()) as { packetHash: string }
    expect(packetHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(puts).toEqual([{ key: packetHash, ttl: 30 * 86400 }])
    const stored = JSON.parse(kv.get(packetHash)!) as { meta: { certification: { tier: string; policyVersion: string } } }
    expect(stored.meta.certification.tier).toBe('client-lite')
    expect(stored.meta.certification.policyVersion).toBe('cert/1.0-client')
  })

  it('dedupes on a get hit: the second upload is a read, not a write', async () => {
    expect((await post('/api/packet', forkReport())).status).toBe(201)
    const again = await post('/api/packet', forkReport())
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ packetHash: expect.stringMatching(/^sha256:/), existing: true })
    expect(puts).toHaveLength(1)
  })

  it('has its own rate-limit namespace: PACKET_LIMIT 429s while explain still answers', async () => {
    packetLimitOk = false
    expect((await post('/api/packet', forkReport())).status).toBe(429)
  })

  it('rejects unknown tiers; server is reserved for in-Worker builds', async () => {
    expect((await post('/api/packet', { ...forkReport(), tier: 'server' })).status).toBe(400)
    expect((await post('/api/packet', { ...forkReport(), tier: 'client-lite' })).status).toBe(201)
  })

  it('refuses reports that do not validate or fail the packet self-check', async () => {
    expect((await post('/api/packet', { ...forkReport(), schema: 'nope' })).status).toBe(400)
    expect((await post('/api/packet', 'not json')).status).toBe(400)
  })
})

describe('POST /api/explain v2 (slim)', () => {
  // A packet whose certification was refused floors without touching a model
  const refused = forkReport({ best: forkReport().best.map(r => ({ ...r, depth: 18 })) })
  const upload = async () => {
    const res = await post('/api/packet', refused)
    expect(res.status).toBe(201)
    return ((await res.json()) as { packetHash: string }).packetHash
  }

  it('miss → 404 packet-miss, the client fallback signal', async () => {
    const res = await post('/api/explain', { v: 2, packetHash: 'sha256:' + '0'.repeat(64), band: 'club' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'packet-miss' })
  })

  it('hit → one narration over the stored packet, version bumped', async () => {
    const packetHash = await upload()
    const res = await post('/api/explain', { v: 2, packetHash, band: 'club' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { version: number; source: string; packet: { meta: { certification: { tier: string } } } }
    expect(data.version).toBe(11)
    expect(data.source).toBe('floor') // refused certification, no model call
    expect(data.packet.meta.certification.tier).toBe('client-lite')
  })

  it('band is a consistency assert: mismatch → 409', async () => {
    const packetHash = await upload()
    expect((await post('/api/explain', { v: 2, packetHash, band: 'advanced' })).status).toBe(409)
    expect((await post('/api/explain', { v: 2, packetHash, band: 'club' })).status).toBe(200)
  })

  it('a tried the packet does not cover → 404, same as a miss', async () => {
    const packetHash = await upload()
    const res = await post('/api/explain', { v: 2, packetHash, band: 'club', tried: 'd5f6' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'packet-miss' })
  })

  it('malformed references → 400, not a miss', async () => {
    expect((await post('/api/explain', { v: 2, packetHash: 42, band: 'club' })).status).toBe(400)
    expect((await post('/api/explain', { v: 2, band: 'club' })).status).toBe(400)
    expect((await post('/api/explain', { v: 2, packetHash: 'sha256:' + '0'.repeat(64), band: 'grandmaster' })).status).toBe(400)
  })

  it('a stored entry that fails packet validation behaves like a miss', async () => {
    const packetHash = await upload()
    kv.set(packetHash, JSON.stringify({ schema: 'lidrill-packet/2.1', garbage: true }))
    const res = await post('/api/explain', { v: 2, packetHash, band: 'club' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'packet-miss' })
  })
})

describe('POST /api/explain v1 (legacy report-in)', () => {
  it('still builds from the report and stamps the browser tier', async () => {
    const res = await post('/api/explain', forkReport({ best: forkReport().best.map(r => ({ ...r, depth: 18 })) }))
    expect(res.status).toBe(200)
    const data = (await res.json()) as { version: number; source: string; packet: { meta: { certification: { tier: string; policyVersion: string } } } }
    expect(data.version).toBe(11)
    expect(data.source).toBe('floor')
    expect(data.packet.meta.certification.tier).toBe('client-lite')
    expect(data.packet.meta.certification.policyVersion).toBe('cert/1.0-client')
  })

  it('rejects the pre-packet report shape with the reload prompt', async () => {
    const res = await post('/api/explain', { ...forkReport(), best: { san: 'Nc7+' } as never })
    expect(res.status).toBe(409)
  })
})
