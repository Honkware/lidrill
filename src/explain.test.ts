import { createEmptyCard } from 'ts-fsrs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CertifyOptions, Engine } from './analysis/engine'
import { db, type Puzzle } from './db'
import { certifyReport, explain, isCurrent, kindOf, rowId } from './explain'
import { buildPacket, validReport } from './server/packet'
import { templateFloor } from './server/floor'

const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const puzzle: Puzzle = { id: 'g:9', gameId: 'g', ply: 9, fen, played: 'e1e2', solution: ['d5c7', 'e8d7', 'c7a8'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 500, card: createEmptyCard() }

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
      return { lines: lines.slice(0, o.multipv), depth: 24, nodes: 900_000, capped: false }
    },
  }) as unknown as Engine

afterEach(() => vi.unstubAllGlobals())

describe('certification report', () => {
  it('runs every position twice with a cleared hash and the policy caps', async () => {
    const calls: [string, CertifyOptions][] = []
    const report = await certifyReport(puzzle, fakeEngine(calls), { band: 'club' }, undefined, [])
    expect(calls).toHaveLength(6) // answer, threat, game move × 2
    expect(calls.every(([, o]) => o.depth === 24 && o.nodes === 2_000_000 && o.clearHash)).toBe(true)
    expect(calls[0][1].multipv).toBe(2)
    expect(calls[2][1].multipv).toBe(3)
    const ok = validReport(JSON.parse(JSON.stringify(report)))
    expect(ok).toBeTruthy()
    const built = buildPacket(ok!)
    expect(built.ok && built.packet.meta.certification.status).toBe('certified')
  })

  it('adds the wrong try, unless it is the game move or an answer', async () => {
    expect((await certifyReport(puzzle, fakeEngine(), { band: 'club' }, 'd5f6', [])).tried?.uci).toBe('d5f6')
    expect((await certifyReport(puzzle, fakeEngine(), { band: 'club' }, 'e1e2', [])).tried).toBeUndefined()
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
    await db.explanations.clear()
    const sent: { url: string; headers?: Record<string, string>; body?: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      sent.push({ url, ...init })
      if (url === '/api/challenge') return new Response(JSON.stringify({ nonce: 'abc', exp: Date.now() + 60000, bits: 4, sig: 's' }))
      const report = validReport(JSON.parse(init!.body!))!
      const built = buildPacket(report)
      if (!built.ok) throw new Error(built.error)
      return new Response(JSON.stringify({ slots: templateFloor(built.packet), packet: built.packet, source: 'floor', version: 9 }))
    })
    const e = await explain(puzzle, fakeEngine(), { band: 'club' })
    expect(e.floor).toBe(true)
    expect(sent[1].headers!['x-lidrill-proof']).toMatch(/^abc\.\d+\.4\.s\.\d+$/)
    const row = await db.explanations.get(rowId(puzzle.id))
    expect(row?.slots.map(s => s.slot)).toEqual(['whatHappened', 'why', 'pattern', 'nextTime'])
    expect(isCurrent(row, 'club')).toBe(true)
    expect(isCurrent(row, 'advanced')).toBe(false) // another band asks again
    sent.length = 0
    await explain(puzzle, fakeEngine(), { band: 'club' })
    expect(sent).toEqual([])
  })
})
