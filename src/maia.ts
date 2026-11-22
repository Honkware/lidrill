import type { Estimate, Game, MaiaSpeed, Profile } from './db'
import { povCp } from './puzzles/generate'

// Games against Maia-3, a model that plays like a person of a given rating.
// The opponent's level follows the player: an Elo-style estimate of how the
// player does against Maia is updated after every game, and the next
// opponent is 50 above it. A player isn't equally strong at every time
// control, so there is one estimate for each of blitz, rapid and untimed.

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

export type Estimates = Partial<Record<MaiaSpeed, Estimate>>

const SPEEDS: MaiaSpeed[] = ['blitz', 'rapid', 'untimed']

// time is a time control as text, '5+3', and anything else (the card's
// 'unlimited', a stored game's 'untimed') has no clock. Lichess's rule:
// under 8 minutes of base time plus 40 moves of increment is blitz.
export function speedOf(time: string): MaiaSpeed {
  const m = /^(\d+)\+(\d+)$/.exec(time)
  if (!m) return 'untimed'
  return Number(m[1]) * 60 + 40 * Number(m[2]) < 480 ? 'blitz' : 'rapid'
}

// A profile from before the split has one estimate, read as the untimed one
export const estimates = (maia: Profile['maia']): Estimates => (maia && 'rating' in maia ? { untimed: maia } : (maia ?? {}))

// The estimate at a speed and the speed it comes from. A speed with no games
// yet borrows the one with the most games, else the starting guess.
export function estimateFor(all: Estimates, speed: MaiaSpeed, start: number): { rating: number; from?: MaiaSpeed } {
  const from = all[speed] ? speed : SPEEDS.filter(s => all[s]).sort((a, b) => all[b]!.games - all[a]!.games)[0]
  return { rating: from ? all[from]!.rating : start, from }
}

// The estimate going into each of the last 30 games at a speed, oldest
// first, as each stored game keeps it
export const history = (games: Game[], speed: MaiaSpeed): number[] =>
  games
    .filter(g => g.site === 'maia' && speedOf(g.speed) === speed)
    .sort((a, b) => a.playedAt - b.playedAt)
    .slice(-30)
    .map(g => g.rating)

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
  playedAt: number
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
    out.push({ gameId: g.id, color: g.color, opening: g.opening, playedAt: g.playedAt, moves: g.moves.slice(0, plies).map(m => ({ san: m.san, uci: m.uci })) })
  }
  return out
}

// One line for a start in the chooser, 'Italian Game, move 6, you were
// White'; the move is the one the player is about to make
export function startLabel(s: Start): string {
  const name = s.opening.split(':')[0].trim() || 'Your game'
  return `${name}, move ${Math.floor(s.moves.length / 2) + 1}, you were ${s.color === 'white' ? 'White' : 'Black'}`
}

// clock is in seconds, with `left` Maia's own time, and is left out of an
// untimed game. think is how long a person would have taken over the move,
// in seconds; a server that doesn't say counts as 0.
export async function fetchMove(
  moves: string[],
  level: number,
  clock: { base: number; inc: number; left: number } | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<{ move?: string; think: number; resign?: boolean }> {
  const res = await fetchFn('/api/maia/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves, level, clock }) })
  const body = (await res.json().catch(() => ({}))) as { move?: string; think?: number; resign?: boolean; error?: string }
  if (!res.ok || !(body.move || body.resign)) throw new Error(body.error ?? `Maia returned HTTP ${res.status}${res.ok ? ' with no move' : ''}.`)
  return { move: body.move, think: body.think ?? 0, resign: body.resign }
}
