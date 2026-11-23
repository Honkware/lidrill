import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import { createEmptyCard, Rating, type Grade } from 'ts-fsrs'
import type { Engine } from '../analysis/engine'
import { db, type Eval, type OpeningCard } from '../db'
import { nextCard } from '../train'
import { fromFen, norm, posKey } from './repertoire'
import { WRONG_BOOST, type TreeNode } from './tree'

// Opening cards, one per position with the player to move, on the same FSRS
// schedule as the puzzles. A card is recall when the repertoire has a move
// there and "they played this instead" when it doesn't, so answering a gap
// and adding the move turns its card into a recall card.

// One move each, so a set stays short next to the 12 daily puzzles
export const SET_SIZE = 10

// Recall: a different move Stockfish puts within 30 cp of the repertoire
// move is playable, Hard rather than Again. A gap: an answer within half a
// pawn of Stockfish's best is a good one.
export const PLAYABLE_CP = 30
export const GOOD_CP = 50
// The interactive engine at the depths the practice drills and the puzzle
// view use, so an answer comes back while the player waits
export const RECALL_DEPTH = 10
const GAP_DEPTH = 14

const worth = (c: OpeningCard) => c.reach * (c.wrong ? WRONG_BOOST : 1)

// New positions get a card; known ones keep their schedule and take the
// tree's current chance of being reached
export async function saveTreeCards(nodes: TreeNode[], opening: string, wrong: Set<string>, now = new Date()): Promise<void> {
  const byId = new Map<string, TreeNode>()
  for (const n of nodes) if ((byId.get(posKey(n.fen))?.reach ?? -1) < n.reach) byId.set(posKey(n.fen), n)
  const old = new Map((await db.openingCards.bulkGet([...byId.keys()])).filter(c => c !== undefined).map(c => [c.id, c]))
  const rows: OpeningCard[] = []
  for (const [id, n] of byId) {
    const c = old.get(id)
    const bad = wrong.has(id) || undefined
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
  return due.filter(c => openings.includes(c.opening)).sort((a, b) => worth(b) - worth(a)).slice(0, SET_SIZE)
}

export async function grade(c: OpeningCard, rating: Grade, now = new Date()): Promise<void> {
  await db.openingCards.update(c.id, { card: nextCard(c.card, now, rating) })
}

export interface Verdict {
  rating: Grade
  text: string
  offer?: string // a move to add to the repertoire
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
export async function judgeMove(fen: string, uci: string, answer: string | undefined, engine: Search): Promise<Verdict> {
  const pos = fromFen(fen)
  const played = norm(pos, uci)
  const san = (u: string) => makeSan(pos, parseUci(u)!)
  if (answer) {
    if (played === answer) return { rating: Rating.Good, text: 'Your repertoire move.' }
    const mine = await after(engine, fen, played, RECALL_DEPTH)
    const theirs = await after(engine, fen, answer, RECALL_DEPTH)
    return mine >= theirs - PLAYABLE_CP
      ? { rating: Rating.Hard, text: `${san(played)} is playable, but your repertoire plays ${san(answer)}.` }
      : { rating: Rating.Again, text: `Your repertoire plays ${san(answer)}.` }
  }
  const best = await engine.search(fen, GAP_DEPTH)
  const top = best.pv[0] ? norm(pos, best.pv[0]) : played
  if (top === played) return { rating: Rating.Good, text: `${san(played)} is Stockfish's move too.`, offer: played }
  const loss = cpOf(best.eval) - (await after(engine, fen, played, GAP_DEPTH))
  return loss <= GOOD_CP
    ? { rating: Rating.Good, text: `${san(played)} is within half a pawn of Stockfish's ${san(top)}.`, offer: played }
    : { rating: Rating.Again, text: `Stockfish prefers ${san(top)}. ${san(played)} is ${(loss / 100).toFixed(1)} pawns worse.`, offer: top }
}
