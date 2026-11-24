import { fsrs, Rating, type Card, type Grade } from 'ts-fsrs'
import { db, queueSyncRow, type Puzzle, type Review } from './db'
import { moreFindable } from './puzzles/findable'

// Puzzles are reviewed once a day, so schedule in whole days: a graded
// puzzle must leave today's due list. ts-fsrs's default short-term mode
// (FSRS-6 learning steps of 1 m/10 m) would keep a freshly graded puzzle due
// minutes later, so the home count and the next queue would never shrink.
const scheduler = fsrs({ enable_short_term: false })

// About 15 minutes a day: at ~75 s a puzzle that's 12.
export const DAILY_CAP = 12

// After two days away the queue shrinks to this (S10 lapse planning): a short
// set to restart with, never a pile-up.
export const RECOVERY_CAP = 6
const EXTERNAL_SHARE = 0.3
const TOP_LEAK_SHARE = 0.6

export interface DayQueue {
  puzzles: Puzzle[]
  recovery: boolean
  topLeak?: string
}

// Round-robin over tags so the same kind doesn't come twice in a row when
// there's a choice (S3 interleaving)
export function interleave(puzzles: Puzzle[]): Puzzle[] {
  const byTag = new Map<string, Puzzle[]>()
  for (const p of puzzles) byTag.set(p.tag, [...(byTag.get(p.tag) ?? []), p])
  const out: Puzzle[] = []
  while (out.length < puzzles.length)
    for (const list of byTag.values()) {
      const next = list.shift()
      if (next) out.push(next)
    }
  return out
}

// The day's queue: own-game puzzles first, shortest solutions first and,
// at the same length, the one Maia finds likelier; at least 60% from the
// player's most common puzzle type
// when there are enough, interleaved by tag; Lichess puzzles fill at most 30%.
export function buildQueue(due: Puzzle[], all: Puzzle[], lastReviewAt: number | undefined, now: Date): DayQueue {
  const recovery = lastReviewAt !== undefined && +now - lastReviewAt > 2 * 24 * 3600 * 1000
  const cap = recovery ? RECOVERY_CAP : DAILY_CAP
  const byLength = (a: Puzzle, b: Puzzle) => a.solutionLen - b.solutionLen || moreFindable(a, b) || +a.card.due - +b.card.due
  const own = due.filter(p => p.source !== 'lichess').sort(byLength)
  const external = due.filter(p => p.source === 'lichess').sort(byLength)

  const counts = new Map<string, number>()
  for (const p of all) if (p.source !== 'lichess') counts.set(p.type, (counts.get(p.type) ?? 0) + 1)
  const topLeak = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]

  const maxExternal = Math.floor(cap * EXTERNAL_SHARE)
  const ownSlots = Math.min(own.length, cap - Math.min(maxExternal, external.length))
  const leak = own.filter(p => p.type === topLeak)
  const rest = own.filter(p => p.type !== topLeak)
  const leakSlots = Math.min(leak.length, Math.max(Math.ceil(ownSlots * TOP_LEAK_SHARE), ownSlots - rest.length))
  const chosen = [...leak.slice(0, leakSlots), ...rest.slice(0, ownSlots - leakSlots)]
  const ext = external.slice(0, Math.min(maxExternal, cap - chosen.length))
  return { puzzles: [...interleave(chosen.sort(byLength)), ...ext], recovery, topLeak }
}

// A buried puzzle is out of the deck for good: it is never queued or
// counted as due, and savePuzzles keeps the generator from replacing it
export const inDeck = (p: Puzzle) => !p.buried

export const bury = (id: string) => db.puzzles.update(id, { buried: true })
export const unbury = (id: string) => db.puzzles.update(id, { buried: undefined })

// Stores what the generator found for a game. A first analysis replaces
// the game's puzzles; a recheck of an analyzed game only adds new ones, so
// those it has keep their schedule. Neither touches a buried puzzle.
export async function savePuzzles(found: Puzzle[], replace: boolean): Promise<void> {
  const old = await db.puzzles.bulkGet(found.map(p => p.id))
  await db.puzzles.bulkPut(found.filter((_, i) => !old[i] || (replace && !old[i].buried)))
}

export async function dueQueue(now = new Date()): Promise<DayQueue> {
  const due = (await db.puzzles.where('card.due').belowOrEqual(now).toArray()).filter(inDeck)
  const all = (await db.puzzles.toArray()).filter(inDeck)
  const last = await db.reviews.orderBy('at').last()
  return buildQueue(due, all, last?.at, now)
}

// The home "Due today" count: today's scheduled work minus what's already
// done today. Graded puzzles leave the due index (their next due is
// tomorrow), but the queue backfills to the daily cap from everything still
// due - a freshly generated card is due the moment it exists - so a raw
// queue length stays pinned at the cap no matter how many were done. Adding
// today's reviews back restores the day as it was scheduled, so the number
// reads "of the N scheduled today, this many remain"; completed puzzles
// never re-count the same day.
export async function dueToday(now = new Date()): Promise<{ remaining: number; doneToday: number }> {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dueNow = await db.puzzles.where('card.due').belowOrEqual(now).filter(inDeck).count()
  const doneToday = await db.reviews.where('at').aboveOrEqual(startOfDay).count()
  const last = await db.reviews.orderBy('at').last()
  const cap = last !== undefined && +now - last.at > 2 * 24 * 3600 * 1000 ? RECOVERY_CAP : DAILY_CAP
  return { remaining: Math.max(0, Math.min(cap, dueNow + doneToday) - doneToday), doneToday }
}

// The same day-based scheduling for the opening cards
export const nextCard = (card: Card, now: Date, rating: Grade): Card => scheduler.next(card, now, rating).card

// First-try solve is Good, a solve after the hint is Hard, a miss is Again.
// A hinted solve doesn't count as solved in the stats or for calibration,
// the way a hint makes a Lichess puzzle unrated.
export function ratingFor(solved: boolean, hinted: boolean): Rating.Good | Rating.Hard | Rating.Again {
  return !solved ? Rating.Again : hinted ? Rating.Hard : Rating.Good
}

export async function recordAttempt(puzzle: Puzzle, solved: boolean, now = new Date(), hinted = false, source: 'queue' | 'replay' = 'queue'): Promise<number> {
  const { card } = scheduler.next(puzzle.card, now, ratingFor(solved, hinted))
  await db.puzzles.update(puzzle.id, { card })
  // ++id is always set on add
  const id = (await db.reviews.add({ puzzleId: puzzle.id, at: +now, solved, hinted: hinted || undefined, source }))!
  await queueSyncRow('reviews', id)
  return id
}

// What the stats count as solved
export const cleanSolve = (r: Review) => r.solved && !r.hinted

export async function saveWhyMissed(reviewId: number, text: string): Promise<void> {
  await db.reviews.update(reviewId, { whyMissed: text.trim() || undefined })
  await queueSyncRow('reviews', reviewId)
}
