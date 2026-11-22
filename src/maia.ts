import type { Game, Profile } from './db'
import { povCp } from './puzzles/generate'

// Games against Maia-3, a model that plays like a person of a given rating.
// The opponent's level follows the player: an Elo-style estimate of how the
// player does against Maia is updated after every game, and the next
// opponent is the level just above it.

// The levels the server will play (LEVELS in server/maia.py). Each is a
// rating at which Maia-3's strength was measured, as an approximate Lichess
// blitz rating, so there is nothing between two of them.
export const LEVELS = [600, 700, 800, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300]

// Playing 50 above the estimate is an expected score of about 43%: the
// player loses a little more often than they win.
const EDGE = 50
const K = 64

// Halfway between two levels goes to the higher one
export const nearestLevel = (rating: number): number => LEVELS.reduce((best, l) => (Math.abs(l - rating) <= Math.abs(best - rating) ? l : best))

export const levelFor = (estimate: number): number => nearestLevel(estimate + EDGE)

export const expectedScore = (rating: number, level: number): number => 1 / (1 + 10 ** ((level - rating) / 400))

// score is 1 for a win, 0.5 for a draw, 0 for a loss. The estimate stays
// within a level of the ladder so a long run can't carry it out of reach.
export function updateEstimate(rating: number, level: number, score: number): number {
  const next = rating + K * (score - expectedScore(rating, level))
  return Math.round(Math.max(LEVELS[0] - 100, Math.min(LEVELS[LEVELS.length - 1] + 100, next)))
}

// Where the estimate starts: the Lichess blitz rating when there is one,
// since the levels are blitz ratings, else the median rating of the last 50
// imported games, else 1000.
export function startEstimate(ratings: Profile['ratings'], games: Game[]): number {
  if (ratings?.blitz?.games) return ratings.blitz.rating
  const recent = games
    .filter(g => g.site !== 'maia' && g.rating > 0)
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, 50)
    .map(g => g.rating)
    .sort((a, b) => a - b)
  return recent.length ? recent[Math.floor(recent.length / 2)] : 1000
}

export interface Start {
  gameId: string
  color: 'white' | 'black'
  opening: string
  moves: { san: string; uci: string }[]
}

// Positions to start a game from: the first move after the opening in each
// of the player's last 30 analyzed games where it was their turn and neither
// side was more than a pawn ahead.
export function ownStarts(games: Game[]): Start[] {
  const recent = games
    .filter(g => g.site !== 'maia' && g.analyzedAt !== undefined)
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, 30)
  const out: Start[] = []
  for (const g of recent) {
    let plies = g.moves.findIndex(m => !m.book) + 1
    if ((plies % 2 === 0) !== (g.color === 'white')) plies++
    const last = g.moves[plies - 1]
    if (plies < 2 || plies > g.moves.length - 10 || !last?.eval || last.eval.mate !== undefined) continue
    if (Math.abs(povCp(last.eval, 'white')) > 100) continue
    out.push({ gameId: g.id, color: g.color, opening: g.opening, moves: g.moves.slice(0, plies).map(m => ({ san: m.san, uci: m.uci })) })
  }
  return out
}

export async function fetchMove(moves: string[], level: number, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn('/api/maia/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves, level }) })
  const body = (await res.json().catch(() => ({}))) as { move?: string; error?: string }
  if (!res.ok || !body.move) throw new Error(body.error ?? 'Maia isn’t available right now.')
  return body.move
}
