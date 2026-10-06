import { describe, expect, it } from 'vitest'
import { judge, winningChances } from './judge'

describe('winning chances', () => {
  it('matches lila at the anchors', () => {
    expect(winningChances({ cp: 0 })).toBe(0)
    expect(winningChances({ cp: 5000 })).toBeCloseTo(winningChances({ cp: 1000 }))
    expect(winningChances({ mate: 1 })).toBeGreaterThan(winningChances({ cp: 1000 }))
  })
})

describe('judge', () => {
  it('uses the 0.1 / 0.2 / 0.3 winning-chance drops', () => {
    expect(judge({ cp: 0 }, { cp: -30 }, 'white')).toBeUndefined()
    expect(judge({ cp: 0 }, { cp: -60 }, 'white')).toBe('inaccuracy')
    expect(judge({ cp: 0 }, { cp: -120 }, 'white')).toBe('mistake')
    expect(judge({ cp: 0 }, { cp: -200 }, 'white')).toBe('blunder')
  })

  it('reads evals from the mover\'s side', () => {
    expect(judge({ cp: 0 }, { cp: 200 }, 'black')).toBe('blunder')
    expect(judge({ cp: 0 }, { cp: 200 }, 'white')).toBeUndefined()
  })

  it('judges created and lost mates like lila', () => {
    expect(judge({ cp: 50 }, { mate: -3 }, 'white')).toBe('blunder')
    expect(judge({ cp: -800 }, { mate: -3 }, 'white')).toBe('mistake')
    expect(judge({ cp: -1200 }, { mate: -3 }, 'white')).toBe('inaccuracy')
    expect(judge({ mate: 2 }, { cp: 300 }, 'white')).toBe('blunder')
    expect(judge({ mate: 2 }, { mate: 4 }, 'white')).toBeUndefined()
  })
})
