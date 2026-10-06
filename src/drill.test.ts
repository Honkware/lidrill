import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Puzzle } from './db'
import { Drill, type Outcome } from './drill'

// Legal's mate: 6. Bxf7+ Ke7 7. Nd5#
const legal: Puzzle = {
  id: 'p:legal', gameId: '', ply: 11, fen: 'rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6',
  played: 'e1d1', solution: ['c4f7', 'e8e7', 'c3d5'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 900, card: createEmptyCard(),
}

let outcomes: Outcome[]
const drill = (p = legal) => {
  const d = new Drill(p, () => {}, { record: true, onFinish: o => outcomes.push(o) })
  return d
}
const lastReview = async () => (await db.reviews.orderBy('at').last())!
const flush = async () => {
  await vi.advanceTimersByTimeAsync(1000)
  await new Promise(r => setImmediate(r))
}

beforeEach(async () => {
  outcomes = []
  await db.reviews.clear()
  await db.puzzles.put(legal)
  // Only the drill's own timers; IndexedDB (fake-indexeddb) keeps real ones
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => vi.useRealTimers())

describe('puzzle flow', () => {
  it('a clean solve plays the reply and records a solve', async () => {
    const d = drill()
    await flush()
    expect(d.typeMove('Bxf7+')).toBe(true)
    expect(d.feedback).toBe('good')
    await flush() // opponent's Ke7
    expect(d.typeMove('Nd5#')).toBe(true)
    await flush()
    await vi.waitFor(() => expect(outcomes).toEqual(['clean']))
    expect((await lastReview()).solved).toBe(true)
  })

  it('a wrong move is taken back, the player can retry, and the miss counts', async () => {
    const d = drill()
    await flush()
    d.typeMove('Kxd1')
    expect(d.feedback).toBe('fail')
    expect(d.typeMove('Bxf7+')).toBe(false) // still showing the wrong move
    await flush()
    expect(d.typeMove('Bxf7+')).toBe(true)
    await flush()
    d.typeMove('Nd5#')
    await flush()
    await vi.waitFor(() => expect(outcomes).toEqual(['missed']))
    expect(await db.reviews.count()).toBe(1)
    expect((await lastReview()).solved).toBe(false)
    expect(d.misses).toEqual(['Kxd1'])
  })

  it('accepts any mate, not only the listed move', async () => {
    // Back-rank: Ra8# is the listed move, Rb8# mates too
    const twoMates: Puzzle = { ...legal, id: 'p:two', fen: '6k1/5ppp/8/8/8/8/5PPP/RR4K1 w - - 0 1', solution: ['a1a8'], solutionLen: 1 }
    await db.puzzles.put(twoMates)
    const d = drill(twoMates)
    await flush()
    d.typeMove('Rb8#')
    await flush()
    await vi.waitFor(() => expect(outcomes).toEqual(['clean']))
  })

  it('a hinted solve is hard, not a miss', async () => {
    const d = drill()
    await flush()
    d.hint()
    d.typeMove('Bxf7+')
    await flush()
    d.typeMove('Nd5#')
    await flush()
    await vi.waitFor(() => expect(outcomes).toEqual(['hinted']))
    expect(await lastReview()).toMatchObject({ solved: true, hinted: true })
  })

  it('viewing the solution counts as a miss and shows the whole line', async () => {
    const d = drill()
    await flush()
    d.viewSolution()
    await flush()
    await vi.waitFor(() => expect(outcomes).toEqual(['shown']))
    expect(d.nodes.filter(n => n.solution).map(n => n.san)).toEqual(['Bxf7+', 'Ke7', 'Nd5#'])
    expect((await lastReview()).solved).toBe(false)
    // free play afterwards
    expect(d.state).toBe('view')
  })
})

describe('check highlight', () => {
  // A stand-in board that keeps the last value set for each key
  const fakeBoard = () => {
    const state: Record<string, unknown> = {}
    const cg = { set: (c: Record<string, unknown>) => Object.assign(state, c), setAutoShapes: () => {}, selectSquare: () => {}, destroy: () => {} }
    return { cg: cg as unknown as Parameters<Drill['useBoard']>[0], state }
  }

  it('names the king in check when a wrong move gives check', async () => {
    const d = drill()
    const { cg, state } = fakeBoard()
    d.useBoard(cg)
    await flush()
    d.typeMove('Bb5+')
    expect(state.check).toBe('black')
    expect(state.turnColor).toBe('black')
  })

  it("a previewed checking move lights up the checked king, not the mover's", async () => {
    const d = drill()
    const { cg, state } = fakeBoard()
    d.useBoard(cg)
    await flush()
    d.viewSolution()
    await flush()
    const after = 'rn1qkbnr/ppp2Bp1/3p3p/4N3/4P3/2N5/PPPP1PPP/R1BbK2R b KQkq - 0 6'
    d.preview({ index: 0, text: 'Bxf7+', from: 'c4', to: 'f7', fen: legal.fen, after })
    expect(state.check).toBe(false)
    expect(state.turnColor).toBe('white')
    await vi.advanceTimersByTimeAsync(200)
    expect(state.check).toBe('black')
    expect(state.turnColor).toBe('black')
  })
})
