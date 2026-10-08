import { createEmptyCard } from 'ts-fsrs'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, type Puzzle, type PuzzleTag, type PuzzleType } from './db'
import { buildQueue, DAILY_CAP, dueQueue, dueToday, interleave, RECOVERY_CAP, recordAttempt } from './train'

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

describe('due count', () => {
  beforeEach(async () => {
    await db.puzzles.clear()
    await db.reviews.clear()
  })

  // Regression: the home "Due today" number derives from stored cards via
  // dueQueue, so grading a puzzle mid-session must drop it immediately and
  // for the rest of the day. ts-fsrs's default short-term mode instead kept a
  // graded puzzle due 1–10 minutes later, and the count climbed back to the
  // full queue (the next session re-served the same puzzles, forever stuck in
  // the learning steps).
  it('drops by one per graded puzzle, straight from the stored cards', async () => {
    const ps = Array.from({ length: DAILY_CAP }, () => puzzle('hang'))
    await db.puzzles.bulkPut(ps)
    expect((await dueQueue(now)).puzzles.length).toBe(DAILY_CAP)

    // Grade 5 of 12; there is no session-end step and none is needed
    for (const p of ps.slice(0, 5)) await recordAttempt(p, true, now)
    expect((await dueQueue(now)).puzzles.length).toBe(DAILY_CAP - 5)

    // A graded puzzle stays out of today's queue for hours, not minutes
    const stored = (await db.puzzles.get(ps[0].id))!
    expect(+stored.card.due).toBeGreaterThan(+now + 6 * 3600e3)
  })

  it('a missed puzzle comes back tomorrow, not in minutes', async () => {
    const p = puzzle('hang')
    await db.puzzles.put(p)
    await recordAttempt(p, false, now)
    expect((await dueQueue(now)).puzzles.length).toBe(0)
    expect((await dueQueue(new Date(+now + 2 * 86400e3))).puzzles.length).toBe(1)
  })
})

describe('dueToday (home count)', () => {
  beforeEach(async () => {
    await db.puzzles.clear()
    await db.reviews.clear()
  })

  // Regression: fresh cards are due the moment they're created, so the due
  // pool behind the daily queue is bottomless for anyone syncing new games.
  // The old count (the queue length) backfilled to the cap as graded puzzles
  // left - do 6 of 12, leave, come back, and it said 12 again, ignoring the
  // work. The count must be the day's scheduled work minus done-today.
  it('counts remaining-after-done instead of backfilling to the cap', async () => {
    // 12 scheduled plus a bottomless supply of brand-new cards, all due now
    const ps = Array.from({ length: DAILY_CAP + 20 }, () => puzzle('hang'))
    await db.puzzles.bulkPut(ps)
    expect((await dueToday(now)).remaining).toBe(DAILY_CAP)

    // Grade 6 and leave mid-session; coming back home the count must drop
    for (const p of ps.slice(0, 6)) await recordAttempt(p, true, now)
    const after = await dueToday(now)
    expect(after.doneToday).toBe(6)
    expect(after.remaining).toBe(DAILY_CAP - 6)

    // There is no session-end step: re-reading the count later drops nothing
    expect((await dueToday(new Date(+now + 6 * 3600e3))).remaining).toBe(DAILY_CAP - 6)
  })

  it('does not double-count when the pool has no backfill supply', async () => {
    const ps = Array.from({ length: DAILY_CAP }, () => puzzle('hang'))
    await db.puzzles.bulkPut(ps)
    for (const p of ps.slice(0, 5)) await recordAttempt(p, true, now)
    // 5 graded, 7 still sitting due; the graded ones must not subtract twice
    expect((await dueToday(now)).remaining).toBe(DAILY_CAP - 5)
  })

  it('floors at zero and reports the day done', async () => {
    const ps = Array.from({ length: DAILY_CAP }, () => puzzle('hang'))
    await db.puzzles.bulkPut(ps)
    for (const p of ps) await recordAttempt(p, true, now)
    const late = await dueToday(new Date(+now + 6 * 3600e3))
    expect(late.remaining).toBe(0)
    expect(late.doneToday).toBe(DAILY_CAP)
  })

  it('next day, yesterday’s work no longer subtracts', async () => {
    const ps = Array.from({ length: DAILY_CAP + 10 }, () => puzzle('hang'))
    await db.puzzles.bulkPut(ps)
    for (const p of ps.slice(0, 4)) await recordAttempt(p, true, now)
    const tomorrow = new Date(+now + 86400e3)
    const { remaining, doneToday } = await dueToday(tomorrow)
    expect(doneToday).toBe(0)
    // Yesterday’s 4 are not subtracted today; the fresh supply means the
    // count resets to the full daily target either way
    expect(remaining).toBe(DAILY_CAP)
  })
})
