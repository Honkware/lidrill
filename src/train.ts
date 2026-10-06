import { fsrs, Rating } from 'ts-fsrs'
import { db, type Puzzle } from './db'

const scheduler = fsrs()

// About 15 minutes a day: at ~75 s a puzzle that's 12.
export const DAILY_CAP = 12

// Due puzzles, shortest solutions first so beginners meet 1-3 movers before
// long lines.
export async function dueQueue(now = new Date()): Promise<Puzzle[]> {
  const due = await db.puzzles.where('card.due').belowOrEqual(now).toArray()
  due.sort((a, b) => a.solutionLen - b.solutionLen || +a.card.due - +b.card.due)
  return due.slice(0, DAILY_CAP)
}

// First-try solve is Good, anything else is Again; there's no hint button
// to make Hard/Easy meaningful.
export async function recordAttempt(puzzle: Puzzle, solved: boolean, now = new Date()): Promise<number> {
  const { card } = scheduler.next(puzzle.card, now, solved ? Rating.Good : Rating.Again)
  await db.puzzles.update(puzzle.id, { card })
  // ++id is always set on add
  return (await db.reviews.add({ puzzleId: puzzle.id, at: +now, solved }))!
}

export async function saveWhyMissed(reviewId: number, text: string): Promise<void> {
  await db.reviews.update(reviewId, { whyMissed: text.trim() || undefined })
}
