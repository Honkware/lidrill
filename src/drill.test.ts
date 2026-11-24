import { readFileSync } from 'node:fs'
import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Puzzle } from './db'
import { Drill, runProgress, SessionReview, type Outcome } from './drill'
import { CERT_RUN_VERSION } from './explain'
import { ORANGE } from './puzzles/whyShapes'
import type { EngineReport } from './server/packet'

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
  await db.certs.clear()
  await db.puzzles.put(legal)
  // Only the drill's own timers; IndexedDB (fake-indexeddb) keeps real ones
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => vi.useRealTimers())

describe('puzzle flow', () => {
  it('a clean solve plays the reply and records a solve', async () => {
    const d = drill()
    await flush()
    expect(d.move('c4', 'f7')).toBe(true)
    expect(d.feedback).toBe('good')
    await flush() // opponent's Ke7
    expect(d.move('c3', 'd5')).toBe(true)
    await flush()
    await vi.waitFor(() => expect(outcomes).toEqual(['clean']))
    expect((await lastReview()).solved).toBe(true)
  })

  it('a wrong move is taken back, the player can retry, and the miss counts', async () => {
    const d = drill()
    await flush()
    d.move('e1', 'd1')
    expect(d.feedback).toBe('fail')
    expect(d.move('c4', 'f7')).toBe(false) // still showing the wrong move
    await flush()
    expect(d.move('c4', 'f7')).toBe(true)
    await flush()
    d.move('c3', 'd5')
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
    d.move('b1', 'b8')
    await flush()
    await vi.waitFor(() => expect(outcomes).toEqual(['clean']))
  })

  it('a hinted solve is hard, not a miss', async () => {
    const d = drill()
    await flush()
    d.hint()
    d.move('c4', 'f7')
    await flush()
    d.move('c3', 'd5')
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
    d.move('c4', 'b5')
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
    d.preview({ from: 'c4', to: 'f7', fen: legal.fen, after })
    expect(state.check).toBe(false)
    expect(state.turnColor).toBe('white')
    await vi.advanceTimersByTimeAsync(200)
    expect(state.check).toBe('black')
    expect(state.turnColor).toBe('black')
  })
})

describe('SessionReview', () => {
  it('stays put with nothing completed and while live', () => {
    const r = new SessionReview()
    expect(r.back()).toBeUndefined()
    expect(r.canBack).toBe(false)
    expect(r.canForward).toBe(false)
    r.onComplete()
    expect(r.canBack).toBe(true)
    expect(r.canForward).toBe(false)
    expect(r.forward()).toBeUndefined() // live already: forward is a no-op
    expect(r.viewing).toBeUndefined()
  })

  it('steps back one at a time through the completed puzzles, capped at the first', () => {
    const r = new SessionReview()
    for (let i = 0; i < 3; i++) r.onComplete()
    expect(r.back()).toBe(2)
    expect(r.viewing).toBe(2)
    expect(r.back()).toBe(1)
    expect(r.back()).toBe(0)
    expect(r.back()).toBe(0) // capped: never before the first puzzle
    expect(r.viewing).toBe(0)
  })

  it('returns to the live puzzle stepping forward past the last completed', () => {
    const r = new SessionReview()
    for (let i = 0; i < 2; i++) r.onComplete()
    r.back()
    r.back()
    expect(r.forward()).toBe(1)
    expect(r.forward()).toBeUndefined() // past the last: back to the live puzzle
    expect(r.viewing).toBeUndefined()
    expect(r.canForward).toBe(false)
  })

  it('keeps indexes stable as new puzzles complete mid-review', () => {
    const r = new SessionReview()
    r.onComplete()
    r.onComplete()
    expect(r.back()).toBe(1)
    r.onComplete() // the live one finished while a review is on screen
    expect(r.viewing).toBe(1)
    expect(r.back()).toBe(0)
    expect(r.forward()).toBe(1)
    expect(r.forward()).toBe(2)
    expect(r.forward()).toBeUndefined()
  })

  it('reset clears the history for a new session', () => {
    const r = new SessionReview()
    r.onComplete()
    r.back()
    r.reset()
    expect(r.viewing).toBeUndefined()
    expect(r.canBack).toBe(false)
  })
})

describe('a puzzle with its own explanation', () => {
  it('opens Why? on the puzzle position with the stored text, and closes it again', async () => {
    const d = new Drill(legal, () => {}, { record: false, note: 'Bxf7+ drives the king out.', arrows: [{ orig: 'c4', dest: 'f7', brush: 'green' }] })
    await flush()
    d.viewSolution()
    await flush()
    d.go(1)
    d.toggleWhy()
    expect([d.showWhy, d.cursor]).toEqual([true, d.start])
    expect(d.shapes).toEqual([{ orig: 'c4', dest: 'f7', brush: 'green' }])
    expect(d.why).toEqual({ slots: [{ slot: 'why', segments: [{ text: 'Bxf7+ drives the king out.' }] }] })
    d.toggleWhy()
    expect(d.showWhy).toBe(false)
    expect(d.why?.slots).toHaveLength(1)
  })

  it('reports a shown explanation once, with its position and text, and never the text of a sample', async () => {
    const sent: unknown[] = []
    const fetchFn = (async (_: string, init: RequestInit) => (sent.push(JSON.parse(init.body as string)), new Response('{}'))) as unknown as typeof fetch
    const sample = new Drill(legal, () => {}, { record: false, note: 'Bxf7+ drives the king out.' })
    await flush()
    sample.viewSolution()
    await flush()
    sample.toggleWhy()
    expect(sample.canFlagWhy).toBe(false)
    sample.flagWhy(fetchFn)

    const d = new Drill(legal, () => {}, { record: false })
    await flush()
    expect(d.canFlagWhy).toBe(false)
    d.why = { slots: [{ slot: 'whatHappened', segments: [{ text: 'You played ' }, { text: 'Ke2' }, { text: '.' }] }, { slot: 'why', segments: [{ text: 'It let the rook go.' }] }], floor: true }
    d.flagWhy(fetchFn)
    d.flagWhy(fetchFn)
    expect(d.whyFlagged).toBe(true)
    expect(sent).toEqual([expect.objectContaining({ fen: legal.fen, best: legal.solution[0], floor: true, text: 'You played Ke2.\nIt let the rook go.' })])
  })

  it('has no explanation to open while the puzzle is being played', async () => {
    const d = new Drill(legal, () => {}, { record: false, note: 'Bxf7+ drives the king out.' })
    await flush()
    d.toggleWhy()
    expect([d.showWhy, d.why]).toEqual([false, undefined])
  })
})

// The arrows of "Why?" on a position the offline gate keeps a certification
// report for: ...Rae8 left the queen on a5 to the queen on d2, and ...Qxd2+
// was the move. The report's runs are what the browser stores in db.certs.
describe('the arrows of Why?', () => {
  const report = (JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8')) as EngineReport[]).find(r => r.fen.startsWith('r4rk1/pp4pp/1np2p1n/q1bpp2b'))!
  const queen: Puzzle = { ...legal, id: 'p:queen', fen: report.fen, played: report.played!.uci, solution: report.solution, solutionLen: 1 }
  const certify = () => db.certs.put({ puzzleId: queen.id, version: CERT_RUN_VERSION, runs: { best: report.best, threat: report.threat ?? [], played: report.played!.runs }, createdAt: 0 })
  const red = { orig: 'a8', dest: 'e8', brush: 'red' }
  const orange = { orig: 'd2', dest: 'a5', brush: ORANGE }
  const green = { orig: 'a5', dest: 'd2', brush: 'green' }

  let requests: ReturnType<typeof vi.fn>
  beforeEach(() => {
    requests = vi.fn(() => Promise.reject(new Error('offline')))
    vi.stubGlobal('fetch', requests)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('are on the puzzle position of a missed puzzle from what is stored, with no request made', async () => {
    await certify()
    const d = new Drill(queen, () => {}, { record: false })
    await flush()
    d.move('a8', 'e8')
    await flush()
    expect(d.shapes).toEqual([])
    d.move('a5', 'd2')
    await flush()
    expect([d.outcome, d.shapes]).toEqual(['missed', []])
    d.go(d.start)
    expect(d.shapes).toEqual([red, orange, green])
    expect(requests).not.toHaveBeenCalled()
  })

  it('are up as soon as the solution is viewed, clear on a step into the line and return on the step back', async () => {
    await certify()
    const d = new Drill(queen, () => {}, { record: false })
    await flush()
    d.viewSolution()
    expect([d.cursor, d.shapes]).toEqual([d.start, [red, orange, green]])
    d.go(d.cursor + 1)
    expect(d.shapes).toEqual([])
    d.go(d.start)
    expect(d.shapes).toEqual([red, orange, green])
  })

  it('are the move played and the best move when no threat is stored', async () => {
    const d = new Drill(queen, () => {}, { record: false })
    await flush()
    d.viewSolution()
    expect(d.shapes).toEqual([red, green])
  })

  it('reach the board when Why? is opened, before a request starts, and stay when the answer fails', async () => {
    await certify()
    const drawn: unknown[] = []
    const cg = { set: () => {}, setAutoShapes: (s: unknown) => drawn.push(s), selectSquare: () => {}, destroy: () => {} }
    const d = new Drill(queen, () => {}, { record: false, certEngines: [] })
    d.useBoard(cg as unknown as Parameters<Drill['useBoard']>[0])
    await flush()
    d.move('a5', 'd2')
    await flush()
    expect([d.outcome, d.shapes]).toEqual(['clean', []])
    d.toggleWhy()
    expect(drawn.at(-1)).toEqual([red, orange, green])
    expect(requests).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(d.why?.error).toBeDefined())
    expect(requests).toHaveBeenCalled()
    expect(d.shapes).toEqual([red, orange, green])
    d.toggleWhy()
    expect(drawn.at(-1)).toEqual([])
  })
})

describe('runProgress', () => {
  it('counts the puzzle on the board as one more until it is answered', () => {
    expect(runProgress(2, 4, false)).toEqual({ at: 3, total: 7 })
    expect(runProgress(3, 4, true)).toEqual({ at: 3, total: 7 })
  })

  it('ends on the last puzzle, not one past it', () => {
    expect(runProgress(7, 0, true)).toEqual({ at: 7, total: 7 })
  })

  it('points at an earlier puzzle while it is looked at again', () => {
    expect(runProgress(3, 4, false, 0)).toEqual({ at: 1, total: 8 })
  })
})
