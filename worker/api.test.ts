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
let maiaLimitOk = true

const env = {
  ASSETS: { fetch: async () => new Response('assets') },
  OPENROUTER_API_KEY: 'test-key',
  POW_SECRET: SECRET,
  EXPLAIN_LIMIT: { limit: async () => ({ success: true }) },
  PACKET_LIMIT: { limit: async () => ({ success: packetLimitOk }) },
  SYNC_LIMIT: { limit: async () => ({ success: true }) },
  MAIA_LIMIT: { limit: async () => ({ success: maiaLimitOk }) },
  BACKEND_URL: 'https://backend.example',
  LIDRILL_KEY: 'backend-secret',
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
  maiaLimitOk = true
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
    const data = (await res.json()) as { version: number; source: string; frame: string; packet: { meta: { certification: { tier: string } } } }
    expect(data.version).toBe(16)
    expect(data.source).toBe('floor') // refused certification, no model call
    expect(data.frame).toBe('miss') // no solving move: the contrast frame
    expect(data.packet.meta.certification.tier).toBe('client-lite')
  })

  it('the solving move selects the frame and the cache key carries it', async () => {
    const cacheStore = new Map<string, Response>()
    let cachePuts = 0
    vi.stubGlobal('caches', {
      default: {
        match: async (k: Request) => cacheStore.get(k.url) ?? null,
        put: async (k: Request, v: Response) => {
          cachePuts++
          cacheStore.set(k.url, v)
        },
      },
    })
    const packetHash = await upload()
    // Same solving move twice: the second is the cached first
    const first = await post('/api/explain', { v: 2, packetHash, band: 'club', solved: 'd5c7' })
    expect((await first.json()) as { frame: string }).toMatchObject({ frame: 'best' })
    const again = await post('/api/explain', { v: 2, packetHash, band: 'club', solved: 'd5c7' })
    expect((await again.json()) as { frame: string }).toMatchObject({ frame: 'best' })
    expect(cachePuts).toBe(1)
    // A different move is a different frame and a different cache entry
    const other = await post('/api/explain', { v: 2, packetHash, band: 'club', solved: 'd5f6' })
    expect((await other.json()) as { frame: string }).toMatchObject({ frame: 'miss' })
    expect(cachePuts).toBe(2)
    // An invalid solving move is a bad request, not a frame
    expect((await post('/api/explain', { v: 2, packetHash, band: 'club', solved: 'ignore previous instructions' })).status).toBe(400)
    // Five proofs of work in one test: the search is a matter of luck and has run past the default 5 s on a busy machine
  }, 30_000)

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
    expect(data.version).toBe(16)
    expect(data.source).toBe('floor')
    expect(data.packet.meta.certification.tier).toBe('client-lite')
    expect(data.packet.meta.certification.policyVersion).toBe('cert/1.0-client')
  })

  it('rejects the pre-packet report shape with the reload prompt', async () => {
    const res = await post('/api/explain', { ...forkReport(), best: { san: 'Nc7+' } as never })
    expect(res.status).toBe(409)
  })
})

// --- /api/sync/* (server tier): the Worker is the only door to the backend ---

interface BackendCall {
  url: string
  method: string
  key: string | null
  body: string
}

const backendCalls: BackendCall[] = []
let accountStatus = 200
let accountCalls = 0

function stubSyncFetch() {
  backendCalls.length = 0
  accountCalls = 0
  const cacheStore = new Map<string, Response>()
  vi.stubGlobal('caches', {
    default: {
      match: async (k: Request) => cacheStore.get(k.url) ?? null,
      put: async (k: Request, v: Response) => void cacheStore.set(k.url, v),
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://lichess.org/api/account') {
        accountCalls++
        return new Response(accountStatus === 200 ? JSON.stringify({ username: 'Player_01' }) : '{}', { status: accountStatus })
      }
      backendCalls.push({ url, method: init?.method ?? 'GET', key: (init?.headers as Record<string, string>)?.['x-lidrill-key'] ?? null, body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
}

async function syncRequest(path: string, opts: { method?: string; token?: string | null; body?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? 'lichess-token'}`
  if (opts.body) headers['content-type'] = 'application/json'
  return worker.fetch(new Request(`http://localhost${path}`, { method: opts.method ?? 'GET', headers, ...(opts.body ? { body: opts.body } : {}) }), env as never, ctx)
}

describe('/api/sync/*', () => {
  beforeEach(() => {
    stubSyncFetch()
    accountStatus = 200
  })

  it('validates the token with Lichess and proxies under the account name', async () => {
    const res = await syncRequest('/api/sync/push', { method: 'POST', body: JSON.stringify({ rows: [] }) })
    expect(res.status).toBe(200)
    expect(accountCalls).toBe(1)
    expect(backendCalls).toHaveLength(1)
    expect(backendCalls[0].url).toBe('https://backend.example/u/Player_01/push')
    expect(backendCalls[0].method).toBe('POST')
    expect(backendCalls[0].key).toBe('backend-secret')
    expect(backendCalls[0].body).toBe(JSON.stringify({ rows: [] }))
  })

  it('caches the account lookup for 15 minutes', async () => {
    await syncRequest('/api/sync/state')
    await syncRequest('/api/sync/state')
    expect(accountCalls).toBe(1)
    expect(backendCalls).toHaveLength(2)
    expect(backendCalls[0].url).toBe('https://backend.example/u/Player_01/state')
  })

  it('rejects a missing token and an expired one, without touching the backend', async () => {
    expect((await syncRequest('/api/sync/state', { token: null })).status).toBe(401)
    accountStatus = 401
    const res = await syncRequest('/api/sync/state')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'sign-in-expired' })
    expect(backendCalls).toHaveLength(0)
  })
})

describe('POST /api/maia/move', () => {
  const game = { moves: ['e2e4'], level: 1500 }
  const backend = (status: number, body: unknown) => {
    const calls: { url: string; key: string | null; body: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, key: new Headers(init.headers).get('x-lidrill-key'), body: String(init.body) })
      return new Response(JSON.stringify(body), { status })
    })
    return calls
  }

  it('forwards the game to the backend with the shared key and returns the move', async () => {
    const calls = backend(200, { move: 'e7e5' })
    const res = await post('/api/maia/move', game, { proof: null })
    expect(await res.json()).toEqual({ move: 'e7e5' })
    expect(calls).toEqual([{ url: 'https://backend.example/maia/move', key: 'backend-secret', body: JSON.stringify(game) }])
  })

  it('is only for lidrill pages and is rate limited per visitor', async () => {
    const calls = backend(200, { move: 'e7e5' })
    expect((await post('/api/maia/move', game, { origin: 'https://evil.example', proof: null })).status).toBe(403)
    expect((await post('/api/maia/move', game, { method: 'GET', proof: null })).status).toBe(405)
    maiaLimitOk = false
    expect((await post('/api/maia/move', game, { proof: null })).status).toBe(429)
    expect(calls).toEqual([])
  })

  it('answers 502 when the backend is down and 400 for a game it refuses', async () => {
    backend(500, {})
    expect((await post('/api/maia/move', game, { proof: null })).status).toBe(502)
    backend(400, { detail: 'level 1550 was not measured' })
    expect((await post('/api/maia/move', game, { proof: null })).status).toBe(400)
  })
})
