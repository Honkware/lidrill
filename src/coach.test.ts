import { describe, expect, it } from 'vitest'
import { coachLine } from './coach'

// The line over the day's puzzles says only what there are numbers for.

describe('coachLine', () => {
  it('joins the due count, the week and the clock into one line', () => {
    const line = coachLine({ due: 7, week: { games: 5, clean: 3 }, time: { speed: 'blitz', games: 30, trouble: 9 } })
    expect(line).toBe('7 due · a hang in 2 of 5 games this week · time trouble in 9 of 30 blitz games')
  })

  it('says nothing with nothing due, no games this week and no time profile', () => {
    expect(coachLine({ due: 0 })).toBeUndefined()
    expect(coachLine({ due: 0, week: { games: 0, clean: 0 } })).toBeUndefined()
  })

  it('reports a week without a hang', () => {
    expect(coachLine({ due: 0, week: { games: 4, clean: 4 } })).toBe('a hang in 0 of 4 games this week')
  })

  it('leaves the clock out when it never ran low', () => {
    expect(coachLine({ due: 3, time: { speed: 'rapid', games: 12, trouble: 0 } })).toBe('3 due')
  })
})
