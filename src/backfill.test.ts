import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backfillPackets } from './backfill'
import { db, type ExplanationRow, type Puzzle } from './db'
import { CERT_RUN_VERSION } from './explain'
import * as pipeline from './pipeline'
import type { EngineRun } from './server/packet'

const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const puzzle: Puzzle = { id: 'g:9', gameId: 'g', ply: 9, fen, played: 'e1e2', solution: ['d5c7', 'e8d7', 'c7a8'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 500, card: createEmptyCard() }

const cp = (value: number) => ({ type: 'cp' as const, value })
const search = (lines: EngineRun['lines']): EngineRun => ({ lines, depth: 24, nodes: 900_000, capped: false })

// What precertify would have stored: the answer, the null-move threat, the game move
const certRuns: Record<string, EngineRun[]> = {
  best: [search([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(500) }, { pv: ['e1e2'], eval: cp(0) }]), search([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(510) }, { pv: ['e1e2'], eval: cp(5) }])],
  threat: [search([{ pv: ['a8a1'], eval: cp(-500) }, { pv: ['a8b8'], eval: cp(-510) }]), search([{ pv: ['a8a1'], eval: cp(-505) }, { pv: ['a8b8'], eval: cp(-515) }])],
  played: [search([{ pv: ['a8a2'], eval: cp(0) }]), search([{ pv: ['a8a2'], eval: cp(10) }])],
}

const oldRow = (): ExplanationRow => ({
  id: 'g:9|',
  puzzleId: 'g:9',
  dedupeKey: 'k',
  packetHash: 'sha256:old',
  band: 'beginner',
  slots: [],
  floor: true,
  promptVersion: 'p2.1',
  version: 10,
  habitId: 'habit:cct-scan',
  createdAt: 1,
  packet: {} as never,
})

let uploads = 0
let uploadOk = true

beforeEach(async () => {
  await db.puzzles.clear()
  await db.certs.clear()
  await db.explanations.clear()
  localStorage.clear()
  uploads = 0
  uploadOk = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // getCertEngines() builds Stockfish workers eagerly. Stub it with engines
  // that reject immediately so the backfill logic is tested without wasm
  // noise or async worker-error flakes.
  vi.spyOn(pipeline, 'getCertEngines').mockReturnValue([
    { certify: vi.fn().mockRejectedValue(new Error('stub engine')) } as never,
    { certify: vi.fn().mockRejectedValue(new Error('stub engine')) } as never,
    { certify: vi.fn().mockRejectedValue(new Error('stub engine')) } as never,
  ])
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/challenge') return new Response(JSON.stringify({ nonce: 'abc', exp: Date.now() + 60000, bits: 4, sig: 's' }))
    if (url === '/api/packet') {
      uploads++
      return new Response(JSON.stringify({ packetHash: 'sha256:up' }), { status: uploadOk ? 201 : 500 })
    }
    throw new Error(`unexpected ${url}`)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const seed = async () => {
  await db.puzzles.put(puzzle)
  await db.certs.put({ puzzleId: puzzle.id, version: CERT_RUN_VERSION, runs: certRuns, createdAt: 1 })
  await db.explanations.put(oldRow())
}

describe('backfillPackets', () => {
  it('stamps client-lite certs on old rows and uploads their packets', async () => {
    await seed()
    const statuses: string[] = []
    await backfillPackets(s => statuses.push(s), new AbortController().signal, 0)
    expect(uploads).toBe(1)
    expect(statuses.at(-1)).toBe('')
    const row = await db.explanations.get('g:9|')
    expect(row?.certTier).toBe('client-lite') // the pre-row is stamped
    // resumable + idempotent: the marker remembers the upload, KV dedupe the rest
    expect(JSON.parse(localStorage.getItem('lidrill.packetBackfill')!)).toEqual({ uploaded: ['g:9'] })
    await backfillPackets(() => {}, new AbortController().signal, 0)
    expect(uploads).toBe(1) // no second upload
  })

  it('a failed upload is not marked done: the next pass retries it', async () => {
    await seed()
    uploadOk = false
    await backfillPackets(() => {}, new AbortController().signal, 0)
    expect(uploads).toBe(1)
    expect(localStorage.getItem('lidrill.packetBackfill')).toBeNull()
    uploadOk = true
    await backfillPackets(() => {}, new AbortController().signal, 0)
    expect(uploads).toBe(2)
    expect(JSON.parse(localStorage.getItem('lidrill.packetBackfill')!)).toEqual({ uploaded: ['g:9'] })
  })

  it('puzzles without certification runs are skipped for now, not marked', async () => {
    await db.puzzles.put(puzzle)
    await backfillPackets(() => {}, new AbortController().signal, 0)
    expect(uploads).toBe(0)
    expect(localStorage.getItem('lidrill.packetBackfill')).toBeNull()
  })
})
