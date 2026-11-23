import { Rating, type Grade } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Verdict } from './cards'
import { LinePlay, type LineOpts, type Resolved } from './line'

// An asked move is never failed by one slip: wrong tries snap back, the
// hint ladder opens after the second, and the grade follows how the move
// was found. The judge is scripted: d2d4 is a playable other move, anything
// else is not.

const line = 'e2e4 e7e5 g1f3 b8c6 f1c4'.split(' ')
let got: Resolved[]

const judge = async (_fen: string, uci: string): Promise<Verdict> => (uci === 'd2d4' ? { rating: Rating.Hard, offer: 'd2d4' } : { rating: Rating.Again })

function play(o: Partial<LineOpts> = {}) {
  const p = new LinePlay({ turn: () => 'ask', wait: 100, resolved: r => void got.push(r), end: () => {}, redraw: () => {}, ...o })
  p.start(line, 'white')
  return p
}
const grades = () => got.map(r => r.grade as Grade)
// Past the opponent's reply to the player's next turn
const reply = () => vi.advanceTimersByTimeAsync(100)

beforeEach(() => {
  got = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => vi.useRealTimers())

describe('LinePlay', () => {
  it('grades a first try Good and a move found after wrong tries Hard, and keeps the line going', async () => {
    const p = play()
    await p.move('e2e4')
    await reply()
    for (const m of ['a2a3', 'h2h3', 'b2b3']) await p.move(m)
    expect([p.state, p.ply, p.tried]).toEqual(['your-move', 2, 'b3'])
    await p.move('g1f3')
    expect(grades()).toEqual([Rating.Good, Rating.Hard])
  })

  it('offers the hint only from the second wrong try, marks the piece, then shows the arrow', async () => {
    const p = play()
    await p.move('a2a3')
    expect(p.offered).toBe(false)
    await p.move('h2h3')
    expect(p.offered).toBe(true)
    p.hint()
    expect([p.help, p.grade]).toEqual([1, Rating.Hard])
    p.hint()
    expect([p.help, p.grade]).toEqual([2, Rating.Again])
    await p.move('e2e4')
    expect(grades()).toEqual([Rating.Again])
  })

  it('plays the solution out, takes it back for the player to play, and grades it Again', async () => {
    const p = play()
    await p.move('a2a3')
    await p.move('h2h3')
    for (let i = 0; i < 3; i++) p.hint()
    expect(p.state).toBe('solution')
    await p.move('e2e4')
    expect(got).toEqual([])
    await vi.advanceTimersByTimeAsync(800)
    expect([p.state, p.canHelp, p.offered]).toEqual(['your-move', false, true])
    await p.move('e2e4')
    expect(grades()).toEqual([Rating.Again])
  })

  it('skips to the next move with an Again', async () => {
    const p = play()
    await p.move('a2a3')
    await p.move('h2h3')
    p.skip()
    await reply()
    expect([p.ply, got[0].skipped, got[0].grade]).toEqual([2, true, Rating.Again])
  })

  it('counts first tries in a row and starts again after a wrong try', async () => {
    const p = play()
    await p.move('e2e4')
    await reply()
    expect(p.streak).toBe(1)
    await p.move('a2a3')
    expect(p.streak).toBe(0)
  })

  it('takes a playable other move as Hard with the offer, and snaps back a bad one', async () => {
    const p = play({ judge })
    await p.move('a2a3')
    expect([p.state, p.wrong]).toEqual(['your-move', 1])
    await p.move('d2d4')
    expect(p.state).toBe('offer')
    expect(got).toEqual([{ key: expect.any(String), moves: [], san: 'd4', grade: Rating.Hard, offer: 'd2d4' }])
    p.next()
    expect(p.played).toEqual(['e2e4'])
  })

  it('lets a shown move be missed without a grade', async () => {
    const p = play({ turn: () => 'show' })
    await p.move('a2a3')
    await p.move('h2h3')
    expect([p.offered, p.tried]).toEqual([false, 'h3'])
    await p.move('e2e4')
    expect([got, p.ply]).toEqual([[], 1])
  })
})
