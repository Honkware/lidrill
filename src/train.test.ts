import { createEmptyCard } from 'ts-fsrs'
import { describe, expect, it } from 'vitest'
import type { Puzzle, PuzzleTag, PuzzleType } from './db'
import { buildQueue, DAILY_CAP, interleave, RECOVERY_CAP } from './train'

let n = 0
const puzzle = (type: PuzzleType, tag: PuzzleTag = 'hang', solutionLen = 1, source: Puzzle['source'] = 'own'): Puzzle => ({
  id: `p${n++}`,
  gameId: source === 'lichess' ? '' : 'g',
  source,
  ply: 20,
  fen: '',
  played: '',
  solution: [],
  solutionLen,
  type,
  tag,
  swingCp: 300,
  card: createEmptyCard(new Date(0)),
})

const now = new Date('2026-10-06T12:00:00Z')

describe('buildQueue', () => {
  it('caps the day and keeps Lichess puzzles to 30%, after own puzzles', () => {
    const own = Array.from({ length: 20 }, () => puzzle('hang'))
    const ext = Array.from({ length: 10 }, () => puzzle('external', 'hang', 1, 'lichess'))
    const q = buildQueue([...ext, ...own], [...own, ...ext], +now - 3600e3, now)
    expect(q.puzzles.length).toBe(DAILY_CAP)
    const firstExt = q.puzzles.findIndex(p => p.source === 'lichess')
    expect(q.puzzles.filter(p => p.source === 'lichess').length).toBe(Math.floor(DAILY_CAP * 0.3))
    expect(q.puzzles.slice(firstExt).every(p => p.source === 'lichess')).toBe(true)
  })

  it('fills with Lichess puzzles only up to the share when own puzzles run out', () => {
    const own = [puzzle('hang')]
    const ext = Array.from({ length: 10 }, () => puzzle('external', 'hang', 1, 'lichess'))
    expect(buildQueue([...own, ...ext], own, undefined, now).puzzles.length).toBe(1 + Math.floor(DAILY_CAP * 0.3))
  })

  it('gives at least 60% to the most common type', () => {
    const all = [...Array.from({ length: 10 }, () => puzzle('hang', 'hang', 2)), ...Array.from({ length: 10 }, () => puzzle('missed-win', 'mate', 1)), puzzle('hang')]
    const q = buildQueue(all, all, undefined, now)
    expect(q.topLeak).toBe('hang')
    expect(q.puzzles.filter(p => p.type === 'hang').length).toBeGreaterThanOrEqual(Math.ceil(DAILY_CAP * 0.6))
  })

  it('shrinks after two days away', () => {
    const all = Array.from({ length: 20 }, () => puzzle('hang'))
    const q = buildQueue(all, all, +now - 3 * 24 * 3600e3, now)
    expect(q.recovery).toBe(true)
    expect(q.puzzles.length).toBe(RECOVERY_CAP)
  })
})

describe('interleave', () => {
  it('alternates tags while it can', () => {
    const q = interleave([puzzle('hang', 'hang'), puzzle('hang', 'hang'), puzzle('hang', 'mate'), puzzle('hang', 'mate')])
    expect(q.map(p => p.tag)).toEqual(['hang', 'mate', 'hang', 'mate'])
  })
})
