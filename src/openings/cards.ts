import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { createEmptyCard, Rating, State, type Grade } from 'ts-fsrs'
import type { Engine } from '../analysis/engine'
import { db, type Eval, type OpeningCard } from '../db'
import { nextCard } from '../train'
import { fromFen, norm, posKey } from './repertoire'
import { WRONG_BOOST, type TreeNode } from './tree'

// Opening cards, one per position with the player to move, on the same FSRS
// schedule as the puzzles. A card is taught first, in a learn line, and
// reviewed after; review asks for the repertoire move without a hint.

// One move each, so a set stays short next to the 12 daily puzzles
export const SET_SIZE = 10

// New positions taught a day, across openings: one review set's worth, so
// what a day teaches comes back as about a set of reviews rather than the
// hundreds of positions in a whole tree
export const NEW_PER_DAY = 10

// A different move Stockfish puts within 30 cp of the repertoire move is
// playable, Hard rather than Again
export const PLAYABLE_CP = 30
// The interactive engine at the depths the practice drills and the puzzle
// view use, so an answer comes back while the player waits
export const RECALL_DEPTH = 10

// A position is learned once its move has been played in a learn line,
// which gives its card a first grade; FSRS takes it from there
export const isLearned = (c: OpeningCard) => c.card.state !== State.New

export async function learnedKeys(ids: string[]): Promise<Set<string>> {
  const cards = await db.openingCards.bulkGet(ids)
  return new Set(cards.filter(c => c !== undefined && isLearned(c)).map(c => c!.id))
}

// Teaching a position is its first grade
export async function learnCard(c: OpeningCard, now = new Date()): Promise<void> {
  await db.openingCards.update(c.id, { card: nextCard(c.card, now, Rating.Good), learnedAt: now.getTime() })
}

// What is left of today's NEW_PER_DAY
export async function freshLeft(now = new Date()): Promise<number> {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const taught = await db.openingCards.filter(c => (c.learnedAt ?? 0) >= from).count()
  return Math.max(0, NEW_PER_DAY - taught)
}

// In the chosen openings: the cards due for review now, and the new
// positions on offer today. A card with no reach is a position from a game
// that no tree goes through, which no learn line teaches.
export async function openingsDue(now = new Date()): Promise<{ due: number; fresh: number }> {
  const names = ((await db.profile.get('me'))?.openings ?? []).map(o => o.name)
  const cards = await db.openingCards.where('opening').anyOf(names).toArray()
  const due = cards.filter(c => isLearned(c) && c.card.due <= now).length
  const left = cards.filter(c => !isLearned(c) && c.reach > 0).length
  return { due, fresh: Math.min(left, await freshLeft(now)) }
}

const worth = (c: OpeningCard) => c.reach * (c.wrong ? WRONG_BOOST : 1)

// New positions get a card; known ones keep their schedule and take the
// tree's current chance of being reached. Without wrong, known cards keep
// their flag.
export async function saveTreeCards(nodes: TreeNode[], opening: string, wrong?: Set<string>, now = new Date()): Promise<void> {
  const byId = new Map<string, TreeNode>()
  for (const n of nodes) if ((byId.get(posKey(n.fen))?.reach ?? -1) < n.reach) byId.set(posKey(n.fen), n)
  const old = new Map((await db.openingCards.bulkGet([...byId.keys()])).filter(c => c !== undefined).map(c => [c.id, c]))
  const rows: OpeningCard[] = []
  for (const [id, n] of byId) {
    const c = old.get(id)
    const bad = wrong ? wrong.has(id) || undefined : c?.wrong
    if (!c) rows.push({ id, opening, moves: n.moves, reach: n.reach, wrong: bad, card: createEmptyCard(now) })
    else if (c.reach !== n.reach || c.wrong !== bad) rows.push({ ...c, reach: n.reach, wrong: bad })
  }
  await db.openingCards.bulkPut(rows)
}

// Positions from real games and from sparring: a card if there isn't one
export async function addCards(found: { fen: string; moves: string[]; opening: string }[], now = new Date()): Promise<void> {
  const ids = found.map(f => posKey(f.fen))
  const known = new Set(await db.openingCards.where('id').anyOf(ids).primaryKeys())
  const rows = new Map<string, OpeningCard>()
  for (const f of found) {
    const id = posKey(f.fen)
    if (!known.has(id)) rows.set(id, { id, opening: f.opening, moves: f.moves, reach: 0, wrong: true, card: createEmptyCard(now) })
  }
  await db.openingCards.bulkPut([...rows.values()])
}

export async function dueCards(openings: string[], now = new Date()): Promise<OpeningCard[]> {
  const due = await db.openingCards.where('card.due').belowOrEqual(now).toArray()
  return due.filter(c => openings.includes(c.opening) && isLearned(c)).sort((a, b) => worth(b) - worth(a)).slice(0, SET_SIZE)
}

export async function grade(c: OpeningCard, rating: Grade, now = new Date()): Promise<void> {
  await db.openingCards.update(c.id, { card: nextCard(c.card, now, rating) })
}

export interface Verdict {
  rating: Grade
  offer?: string // the player's playable move, to make their repertoire move
}

export type Search = Pick<Engine, 'search'>

export const cpOf = (e: Eval) => (e.mate !== undefined ? (e.mate > 0 ? 10000 : -10000) : (e.cp ?? 0))

// The position after uci, for the player who played it
export async function after(engine: Search, fen: string, uci: string, depth: number): Promise<number> {
  const pos = fromFen(fen)
  pos.play(parseUci(uci)!)
  if (pos.isCheckmate()) return 10000
  if (pos.isEnd()) return 0
  return -cpOf((await engine.search(makeFen(pos.toSetup()), depth)).eval)
}

// The player's move at a card's position. answer is the repertoire move.
export async function judgeMove(fen: string, uci: string, answer: string, engine: Search): Promise<Verdict> {
  const played = norm(fromFen(fen), uci)
  if (played === answer) return { rating: Rating.Good }
  const mine = await after(engine, fen, played, RECALL_DEPTH)
  const theirs = await after(engine, fen, answer, RECALL_DEPTH)
  return mine >= theirs - PLAYABLE_CP ? { rating: Rating.Hard, offer: played } : { rating: Rating.Again }
}
