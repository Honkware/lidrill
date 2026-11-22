import { describe, expect, it } from 'vitest'
import { gameAccuracy, moveAccuracy, winPercent } from './accuracy'

// The port checked against lila's own vectors, copied from
// modules/analyse/src/test/AccuracyPercentTest.scala: each game starts from
// lila's legacy initial eval of 15 cp, and each figure must land within the
// same tolerance lila's test allows.

const start = { cp: 15 }
const compute = (cps: number[], color: 'white' | 'black' = 'white') => gameAccuracy(color, [start, ...cps.map(cp => ({ cp }))])
const repeat = (n: number, cps: number[]) => Array.from({ length: n }, () => cps).flat()

function near(a: { white: number; black: number } | undefined, white: [number, number], black: [number, number]) {
  expect(a).toBeDefined()
  expect(Math.abs(a!.white - white[0])).toBeLessThanOrEqual(white[1])
  expect(Math.abs(a!.black - black[0])).toBeLessThanOrEqual(black[1])
}

describe('move accuracy', () => {
  it('is 100 when the win percent holds or rises', () => {
    expect(moveAccuracy(50, 50)).toBe(100)
    expect(moveAccuracy(50, 70)).toBe(100)
  })

  it('counts a mate as the 1000 cp ceiling', () => {
    expect(winPercent({ mate: 3 })).toBe(winPercent({ cp: 1000 }))
    expect(winPercent({ mate: -3 })).toBe(winPercent({ cp: -5000 }))
  })
})

describe('game accuracy, lila vectors', () => {
  it('has no figure for an empty game or a single move', () => {
    expect(compute([])).toBeUndefined()
    expect(compute([15])).toBeUndefined()
  })

  it('gives two good moves 100 each', () => near(compute([15, 15]), [100, 1], [100, 1]))

  it('gives a first-move blunder about 10', () => {
    near(compute([-900, -900]), [10, 5], [100, 1])
    near(compute([15, 900]), [100, 1], [10, 5])
    near(compute([-900, 0]), [10, 5], [10, 5])
  })

  it('gives 20 perfect moves 100', () => near(compute(repeat(20, [15])), [100, 1], [100, 1]))

  it('halves a side’s figure for one blunder after 20 perfect moves', () => {
    near(compute([...repeat(20, [15]), -900]), [50, 5], [100, 1])
    near(compute([...repeat(21, [15]), 900]), [100, 1], [50, 5])
  })

  it('gives 65, 150 and 500 cp losses about 76, 54 and 20', () => {
    near(compute(repeat(5, [-50, 15])), [76, 8], [76, 8])
    near(compute(repeat(50, [-50, 15])), [76, 8], [76, 8])
    near(compute(repeat(50, [-135, 15])), [54, 8], [54, 8])
    near(compute(repeat(50, [-435, 15])), [20, 8], [20, 8])
  })

  it('reads the first move as black’s when black starts', () => {
    expect(compute([], 'black')).toBeUndefined()
    expect(compute([15], 'black')).toBeUndefined()
    near(compute([15, 15], 'black'), [100, 1], [100, 1])
    near(compute([900, 900], 'black'), [100, 1], [10, 5])
    near(compute([15, -900], 'black'), [10, 5], [100, 1])
    near(compute([900, 0], 'black'), [10, 5], [10, 5])
  })
})
