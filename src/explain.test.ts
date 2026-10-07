import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CertifyOptions, Engine } from './analysis/engine'
import { db, type Puzzle } from './db'
import { certifyReport, explain, EXPLAIN_VERSION, isCurrent, kindOf, rowId } from './explain'
import { buildPacket, REPORT_SCHEMA, validReport, type EngineReport } from './server/packet'
import { templateFloor } from './server/floor'

const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const puzzle: Puzzle = { id: 'g:9', gameId: 'g', ply: 9, fen, played: 'e1e2', solution: ['d5c7', 'e8d7', 'c7a8'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 500, card: createEmptyCard() }

// The report fakeEngine certifies, as a literal (for building stub responses)
const reportOf = (): EngineReport => ({
  schema: REPORT_SCHEMA,
  fen,
  solution: ['d5c7', 'e8d7', 'c7a8'],
  kind: 'missed-win',
  band: 'club',
  best: [
    { lines: [{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: { type: 'cp', value: 500 } }, { pv: ['e1e2'], eval: { type: 'cp', value: 0 } }], depth: 24, nodes: 900_000, capped: false, check: { depth: 22, pv: ['d5c7', 'e8d7', 'c7a8'], eval: { type: 'cp', value: 500 } } },
    { lines: [{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: { type: 'cp', value: 510 } }, { pv: ['e1e2'], eval: { type: 'cp', value: 5 } }], depth: 24, nodes: 900_000, capped: false },
  ],
  threat: [
    { lines: [{ pv: ['a8a1'], eval: { type: 'cp', value: -500 } }, { pv: ['a8b8'], eval: { type: 'cp', value: -510 } }], depth: 24, nodes: 900_000, capped: false },
    { lines: [{ pv: ['a8a1'], eval: { type: 'cp', value: -505 } }, { pv: ['a8b8'], eval: { type: 'cp', value: -515 } }], depth: 24, nodes: 900_000, capped: false },
  ],
  played: { uci: 'e1e2', runs: [
    { lines: [{ pv: ['a8a2'], eval: { type: 'cp', value: 0 } }], depth: 24, nodes: 900_000, capped: false },
    { lines: [{ pv: ['a8a2'], eval: { type: 'cp', value: 10 } }], depth: 24, nodes: 900_000, capped: false },
  ] },
  habit: { recent: [] },
})

const packetFor = () => {
  const built = buildPacket(validReport(JSON.parse(JSON.stringify(reportOf())))!)
  if (!built.ok) throw new Error(built.error)
  return built.packet
}

// A stand-in Stockfish: the fork at the start, quiet elsewhere
const fakeEngine = (calls: [string, CertifyOptions][] = []) =>
  ({
    certify: async (f: string, o: CertifyOptions) => {
      calls.push([f, o])
      const lines =
        f === fen
          ? [{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: { type: 'cp' as const, value: 500 } }, { pv: ['e1e2'], eval: { type: 'cp' as const, value: 0 } }]
          : f.includes(' b ') && f.startsWith('r3k3/8/8/3N4')
            ? [{ pv: ['a8a1'], eval: { type: 'cp' as const, value: -500 } }, { pv: ['a8b8'], eval: { type: 'cp' as const, value: -505 } }]
            : [{ pv: ['a8a2'], eval: { type: 'cp' as const, value: 0 } }]
      return { lines: lines.slice(0, o.multipv), depth: 24, nodes: 900_000, capped: false, check: { depth: 22, ...lines[0] } }
    },
  }) as unknown as Engine

beforeEach(async () => {
  await db.certs.clear()
  await db.explanations.clear()
})
afterEach(() => vi.unstubAllGlobals())

describe('certification report', () => {
  it('runs each position once, within the time budget, and caches the runs for next time', async () => {
    const calls: [string, CertifyOptions][] = []
    const report = await certifyReport(puzzle, [fakeEngine(calls)], { band: 'club' }, undefined, [])
    expect(calls).toHaveLength(3) // answer, threat, game move
    expect(calls.every(([, o]) => o.depth === 24 && o.movetime! > 0 && o.clearHash)).toBe(true)
    expect(calls.map(([, o]) => o.multipv)).toEqual([2, 3, 1])
    calls.length = 0
    await certifyReport(puzzle, [fakeEngine(calls)], { band: 'club' }, 'd5f6', [])
    expect(calls.map(([f]) => f)).toHaveLength(1) // only the wrong try is new
    const ok = validReport(JSON.parse(JSON.stringify(report)))
    expect(ok).toBeTruthy()
    const built = buildPacket(ok!)
    expect(built.ok && built.packet.meta.certification.status).toBe('certified')
  })

  it('adds the wrong try, unless it is the game move or an answer', async () => {
    expect((await certifyReport(puzzle, [fakeEngine()], { band: 'club' }, 'd5f6', [])).tried?.uci).toBe('d5f6')
    expect((await certifyReport(puzzle, [fakeEngine()], { band: 'club' }, 'e1e2', [])).tried).toBeUndefined()
  })

  it('maps puzzles to their kind', () => {
    expect(kindOf(puzzle)).toBe('missed-win')
    expect(kindOf({ ...puzzle, alternatives: ['a', 'b'] })).toBe('hold')
    expect(kindOf({ ...puzzle, source: 'lichess' })).toBe('lichess')
    expect(kindOf({ ...puzzle, type: 'hang' })).toBe('hang')
  })
})

describe('explain', () => {
  it('certifies, proves the request, stores ref form with the packet, and serves the cache after', async () => {
    const sent: { url: string; headers?: Record<string, string>; body?: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      sent.push({ url, ...init })
      if (url === '/api/challenge') return new Response(JSON.stringify({ nonce: 'abc', exp: Date.now() + 60000, bits: 4, sig: 's' }))
      if (url === '/api/packet') return new Response(JSON.stringify({ packetHash: 'sha256:uploaded' }), { status: 201 })
      const body = JSON.parse(init!.body!)
      if (body.v === 2) return new Response(JSON.stringify({ error: 'packet-miss' }), { status: 404 })
      const report = validReport(body)!
      const built = buildPacket(report)
      if (!built.ok) throw new Error(built.error)
      return new Response(JSON.stringify({ slots: templateFloor(built.packet), packet: built.packet, source: 'floor', version: EXPLAIN_VERSION }))
    })
    const e = await explain(puzzle, [fakeEngine()], { band: 'club' })
    expect(e.floor).toBe(true)
    expect(sent[1].headers!['x-lidrill-proof']).toMatch(/^abc\.\d+\.4\.s\.\d+$/)
    const row = await db.explanations.get(rowId(puzzle.id))
    expect(row?.slots.map(s => s.slot)).toEqual(['whatHappened', 'why', 'pattern', 'nextTime'])
    expect(isCurrent(row, 'club')).toBe(true)
    expect(isCurrent(row, 'advanced')).toBe(false) // another band asks again
    sent.length = 0
    await explain(puzzle, [fakeEngine()], { band: 'club' })
    expect(sent).toEqual([])
  })

  it('slim v2 first: a packet hit needs no engine and persists certTier', async () => {
    const engineCalls: [string, CertifyOptions][] = []
    const slimBodies: unknown[] = []
    const packet = packetFor()
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      if (url === '/api/challenge') return new Response(JSON.stringify({ nonce: 'abc', exp: Date.now() + 60000, bits: 4, sig: 's' }))
      const body = JSON.parse(init!.body!)
      if (body.v === 2) {
        slimBodies.push(body)
        return new Response(JSON.stringify({ slots: templateFloor(packet), packet, source: 'floor', version: EXPLAIN_VERSION }))
      }
      throw new Error('legacy path should not run on a hit')
    })
    const e = await explain(puzzle, [fakeEngine(engineCalls)], { band: 'club' })
    expect(e.floor).toBe(true)
    expect(engineCalls).toEqual([]) // the engine never ran
    expect(slimBodies).toEqual([{ v: 2, packetHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), band: 'club' }])
    const row = await db.explanations.get(rowId(puzzle.id))
    expect(row?.certTier).toBe('client-lite')
    expect(row?.version).toBe(EXPLAIN_VERSION)
    expect(isCurrent(row, 'club')).toBe(true)
  })

  it('packet-miss falls back to certify-and-POST and uploads the packet fire-and-forget', async () => {
    const engineCalls: [string, CertifyOptions][] = []
    const uploads: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      if (url === '/api/challenge') return new Response(JSON.stringify({ nonce: 'abc', exp: Date.now() + 60000, bits: 4, sig: 's' }))
      if (url === '/api/packet') {
        uploads.push(init!.body!)
        return new Response(JSON.stringify({ packetHash: 'sha256:uploaded' }), { status: 201 })
      }
      const body = JSON.parse(init!.body!)
      if (body.v === 2) return new Response(JSON.stringify({ error: 'packet-miss' }), { status: 404 })
      const report = validReport(body)!
      const built = buildPacket(report)
      if (!built.ok) throw new Error(built.error)
      return new Response(JSON.stringify({ slots: templateFloor(built.packet), packet: built.packet, source: 'floor', version: EXPLAIN_VERSION }))
    })
    const e = await explain(puzzle, [fakeEngine(engineCalls)], { band: 'club' })
    expect(e.floor).toBe(true)
    expect(engineCalls.length).toBeGreaterThan(0) // the fallback ran the engine
    await vi.waitFor(() => expect(uploads).toHaveLength(1))
    expect(JSON.parse(uploads[0])).toMatchObject({ tier: 'client-lite', schema: 'lidrill-report/1' })
    expect((await db.explanations.get(rowId(puzzle.id)))?.certTier).toBe('client-lite')
  })

  it('any slim failure (network error, upload failure) fails closed to the same fallback', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      if (url === '/api/challenge') return new Response(JSON.stringify({ nonce: 'abc', exp: Date.now() + 60000, bits: 4, sig: 's' }))
      if (url === '/api/packet') return new Response(JSON.stringify({ error: 'nope' }), { status: 500 }) // uploads are lazy
      const body = JSON.parse(init!.body!)
      if (body.v === 2) throw new Error('network down')
      const report = validReport(body)!
      const built = buildPacket(report)
      if (!built.ok) throw new Error(built.error)
      return new Response(JSON.stringify({ slots: templateFloor(built.packet), packet: built.packet, source: 'floor', version: EXPLAIN_VERSION }))
    })
    const e = await explain(puzzle, [fakeEngine()], { band: 'club' })
    expect(e.floor).toBe(true)
    expect((await db.explanations.get(rowId(puzzle.id)))?.certTier).toBe('client-lite')
  })
})
