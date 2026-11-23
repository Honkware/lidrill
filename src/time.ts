import type { Game, Judgment } from './db'
import { pgnHeader } from './sync/pgn'

// How the player spends their clock, from the clock left after each move
// (Game.clocks, centiseconds). A move took the clock before it minus the
// clock after it plus the increment. Each side's first move is left out:
// Lichess and Play Maia start the clocks only once both sides have moved,
// and Chess.com gives the first move a timer of its own.

export interface TimeControl {
  base: number // seconds
  inc: number
}

// From the PGN's TimeControl header, "180+2" or Chess.com's "300". Games
// against Maia keep theirs in minutes as the speed, "5+3".
export function timeControl(g: Game): TimeControl | undefined {
  const maia = g.site === 'maia'
  const m = maia ? /^(\d+)\+(\d+)$/.exec(g.speed) : /^(\d+)(?:\+(\d+))?$/.exec(pgnHeader(g.pgn, 'TimeControl') ?? '')
  if (!m) return undefined
  return { base: Number(m[1]) * (maia ? 60 : 1), inc: Number(m[2] ?? 0) }
}

export type Pace = 'fast' | 'normal' | 'slow'

// Against the median time of the player's moves in the same game, so a
// 3+0 and a 5+3 game are each measured against themselves
export const FAST = 0.5
export const SLOW = 2
// Time trouble: the clock under a tenth of the base time after a move
export const TROUBLE = 0.1

export interface MoveTime {
  ply: number // moves played, counting this one
  move: number // the move number
  secs: number
  left: number // seconds on the clock after it
  judg?: Judgment
  pace: Pace
}

export interface GameTime {
  tc: TimeControl
  moves: MoveTime[]
  median: number
  usedBy15?: number // share of the base time gone after the player's move 15
  trouble: boolean
  lostOnTime: boolean
}

// Lichess's status, Chess.com's result code and Play Maia's ending
const TIME_OUT = new Set(['outoftime', 'timeout', 'time out'])

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function gameTime(g: Game): GameTime | undefined {
  const tc = timeControl(g)
  const c = g.clocks
  if (!tc || !c) return undefined
  const raw: Omit<MoveTime, 'pace'>[] = []
  // A Lichess game that ended by resignation or time has one more clock,
  // the side to move's, which is not a move
  const end = Math.min(g.moves.length, c.length)
  for (let i = (g.color === 'white' ? 0 : 1) + 2; i < end; i += 2)
    // Lag compensation can give back a little more than the move took
    raw.push({ ply: i + 1, move: (i >> 1) + 1, secs: Math.max(0, (c[i - 2] - c[i]) / 100 + tc.inc), left: c[i] / 100, judg: g.moves[i].judg })
  if (!raw.length) return undefined
  const med = median(raw.map(m => m.secs))
  const moves = raw.map(m => ({ ...m, pace: (m.secs < FAST * med ? 'fast' : m.secs > SLOW * med ? 'slow' : 'normal') as Pace }))
  const at15 = moves.find(m => m.move === 15)
  const lostOnTime = g.result === 'loss' && TIME_OUT.has(g.termination)
  return {
    tc,
    moves,
    median: med,
    usedBy15: at15 && Math.max(0, 1 - at15.left / tc.base),
    trouble: lostOnTime || moves.some(m => m.left < TROUBLE * tc.base),
    lostOnTime,
  }
}

export const slowest = (t: GameTime): MoveTime => t.moves.reduce((a, b) => (b.secs > a.secs ? b : a))

export type TimedSpeed = 'blitz' | 'rapid'

export const RECENT = 30
export const MIN_GAMES = 5
// Think time counts from move 11: earlier moves are mostly the opening, and
// in the time fit the median move takes 2 to 4 s before ply 20 and 6 s from
// there to ply 60 (server/think_fit.md)
export const AFTER_MOVE = 10

export interface TimeProfile {
  speed: TimedSpeed
  games: number
  think: number // median seconds per move after move 10
  usedBy15?: number // mean over the games that reached move 15
  trouble: number // games
  lostOnTime: number
  pace: Record<Pace, { moves: number; errors: number }> // errors: mistakes and blunders
}

// The player's last RECENT analyzed games at a speed that have clocks.
// Games against Maia stay out: their clocks start differently in a game
// from a position, and the profile is about the games that count.
export function timeProfile(games: Game[], speed: TimedSpeed): TimeProfile | undefined {
  const times = games
    .filter(g => g.site !== 'maia' && g.speed === speed && g.analyzedAt !== undefined)
    .sort((a, b) => b.playedAt - a.playedAt)
    .map(gameTime)
    .filter((t): t is GameTime => !!t)
    .slice(0, RECENT)
  if (times.length < MIN_GAMES) return undefined
  const pace = { fast: { moves: 0, errors: 0 }, normal: { moves: 0, errors: 0 }, slow: { moves: 0, errors: 0 } }
  for (const m of times.flatMap(t => t.moves)) {
    pace[m.pace].moves++
    if (m.judg === 'mistake' || m.judg === 'blunder') pace[m.pace].errors++
  }
  const late = times.flatMap(t => t.moves.filter(m => m.move > AFTER_MOVE).map(m => m.secs))
  const used = times.flatMap(t => (t.usedBy15 === undefined ? [] : [t.usedBy15]))
  return {
    speed,
    games: times.length,
    think: late.length ? median(late) : median(times.flatMap(t => t.moves.map(m => m.secs))),
    usedBy15: used.length ? used.reduce((a, b) => a + b, 0) / used.length : undefined,
    trouble: times.filter(t => t.trouble).length,
    lostOnTime: times.filter(t => t.lostOnTime).length,
    pace,
  }
}

// Blitz and rapid, the one with more games first
export const timeProfiles = (games: Game[]): TimeProfile[] =>
  (['blitz', 'rapid'] as const)
    .map(s => timeProfile(games, s))
    .filter((p): p is TimeProfile => !!p)
    .sort((a, b) => b.games - a.games)
