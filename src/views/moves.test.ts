import { describe, expect, it } from 'vitest'
import { evalText, score } from './moves'

// The text beside each move and under the last one, written the way
// Lichess's move list writes it.

describe('evalText', () => {
  it('writes pawns to one decimal with a plus only when White is better', () => {
    expect([evalText({ cp: 34 }), evalText({ cp: -150 }), evalText({ cp: 0 }), evalText({ cp: 4 })]).toEqual(['+0.3', '−1.5', '0.0', '0.0'])
  })

  it('clamps big evals to 99 and writes mates as #n', () => {
    expect([evalText({ cp: 9345 }), evalText({ mate: 3 }), evalText({ mate: -2 })]).toEqual(['+93.5', '#3', '#−2'])
    expect(evalText({ cp: -9950 })).toBe('−99.0')
  })

  it('leaves a checkmated position blank', () => {
    expect([evalText({ cp: 10000 }), evalText({ cp: -10000 })]).toEqual(['', ''])
  })
})

describe('score', () => {
  it('writes the result from White’s side whichever colour the player had', () => {
    expect([score('win', 'white'), score('win', 'black'), score('loss', 'black'), score('draw', 'black')]).toEqual(['1-0', '0-1', '1-0', '½-½'])
  })
})
