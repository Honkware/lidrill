import { describe, expect, it } from 'vitest'
import type { Game, Judgment } from './db'
import { GameView, stepKey } from './gameview'

// Stepping through a reviewed game from the keyboard, with Lichess's keys,
// and from the advice summary's counts.

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, ...init })

describe('stepKey', () => {
  it('steps with the arrows and with j and k', () => {
    expect([key('ArrowLeft'), key('k'), key('ArrowRight'), key('j')].map(e => stepKey(e, 5, 40))).toEqual([4, 4, 6, 6])
  })

  it('jumps to the start with up, 0 or home and to the end with down, $ or end', () => {
    expect([key('ArrowUp'), key('0'), key('Home'), key('ArrowDown'), key('$'), key('End')].map(e => stepKey(e, 5, 40))).toEqual([0, 0, 0, 40, 40, 40])
  })

  it('leaves other keys and the browser’s shortcuts alone', () => {
    expect([key('x'), key('0', { ctrlKey: true }), key('k', { metaKey: true })].map(e => stepKey(e, 5, 40))).toEqual([undefined, undefined, undefined])
  })

  it('leaves keys typed into a text box alone', () => {
    const box = document.createElement('textarea')
    document.body.append(box)
    const e = key('j', { bubbles: true })
    let seen: number | undefined = -1
    box.addEventListener('keydown', ev => (seen = stepKey(ev, 5, 40)))
    box.dispatchEvent(e)
    expect(seen).toBeUndefined()
    box.remove()
  })
})

// 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#, with White's 2nd and 3rd moves
// marked as mistakes and Black's Nf6 as the blunder it is
function game(color: 'white' | 'black'): Game {
  const line: [string, string, Judgment?][] = [
    ['e4', 'e2e4'], ['e5', 'e7e5'], ['Bc4', 'f1c4', 'mistake'], ['Nc6', 'b8c6'],
    ['Qh5', 'd1h5', 'mistake'], ['Nf6', 'g8f6', 'blunder'], ['Qxf7#', 'h5f7'],
  ]
  const moves = line.map(([san, uci, judg]) => ({ san, uci, judg }))
  return { id: 'maia:1', color, result: color === 'white' ? 'win' : 'loss', moves, analyzedAt: 1 } as Game
}

describe('GameView advice', () => {
  it('counts only the player’s own moves', () => {
    const v = new GameView(game('white'), () => {})
    expect([v.judged('mistake'), v.judged('blunder')]).toEqual([[3, 5], []])
    expect(new GameView(game('black'), () => {}).judged('blunder')).toEqual([6])
  })

  it('steps to the next move with that judgment and wraps round to the first', () => {
    const v = new GameView(game('white'), () => {})
    const seen = [1, 2, 3].map(() => (v.nextJudged('mistake'), v.ply))
    expect(seen).toEqual([3, 5, 3])
  })

  it('stays put when the player has none', () => {
    const v = new GameView(game('white'), () => {}, 4)
    v.nextJudged('inaccuracy')
    expect(v.ply).toBe(4)
  })
})
