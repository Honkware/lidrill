import type { Game, Profile } from './db'
import { povCp } from './puzzles/generate'

// Games against Maia-3, a model that plays like a person of a given rating.
// The opponent's level follows the player: an Elo-style estimate of how the
// player does against Maia is updated after every game, and the next
// opponent is 50 above it.

// The range the server will play (MIN_LEVEL and MAX_LEVEL in
// server/maia.py), as an approximate Lichess blitz rating. Maia-3's strength
// was measured about every 100 points, each to within some 40 Elo. A level
// in between mixes the two measured settings around it, so a step of 1 is a
// real but very small change, well inside that margin.
export const MIN_LEVEL = 600
export const MAX_LEVEL = 2300

// Playing 50 above the estimate is an expected score of about 43%: the
// player loses a little more often than they win.
const EDGE = 50
const K = 64
// The starting guess can be hundreds of points off, so the first games move
// the estimate twice as far. In simulation a player 300 below the guess is
// within 100 after 9 games instead of 14, and by game 30 the error is the same.
const K_NEW = 128
const NEW_GAMES = 5

export const clampLevel = (level: number): number => Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(level)))

export const levelFor = (estimate: number): number => clampLevel(estimate + EDGE)

export const expectedScore = (rating: number, level: number): number => 1 / (1 + 10 ** ((level - rating) / 400))

// score is 1 for a win, 0.5 for a draw, 0 for a loss, and games is how many
// were played before this one. The estimate stays within 100 of the range
// so a long run can't carry it out of reach.
export function updateEstimate(rating: number, level: number, score: number, games: number): number {
  const next = rating + (games < NEW_GAMES ? K_NEW : K) * (score - expectedScore(rating, level))
  return Math.round(Math.max(MIN_LEVEL - 100, Math.min(MAX_LEVEL + 100, next)))
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

// clock is in seconds, with `left` Maia's own time, and is left out of an
// untimed game. think is how long a person would have taken over the move,
// in seconds; a server that doesn't say counts as 0.
export async function fetchMove(
  moves: string[],
  level: number,
  clock: { base: number; inc: number; left: number } | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<{ move: string; think: number }> {
  const res = await fetchFn('/api/maia/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves, level, clock }) })
  const body = (await res.json().catch(() => ({}))) as { move?: string; think?: number; error?: string }
  if (!res.ok || !body.move) throw new Error(body.error ?? 'Maia isn’t available right now.')
  return { move: body.move, think: body.think ?? 0 }
}
