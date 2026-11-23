import type { Game, Puzzle } from './db'
import type { Drill } from './drill'
import { speedOf } from './maia'
import type { TimeProfile } from './time'

// "Move under a clock": the player's own puzzles, each with a countdown of
// their median think time in the kind of game the puzzle came from. Running
// out of time counts as a miss in the session's score; the puzzles are not
// recorded, so their schedule stays with the daily queue.

// A blitz player's median after move 10 can be 2 or 3 s, and 5 s still
// leaves time to take in a position the player did not choose. 60 s keeps a
// puzzle under the 75 s a daily puzzle is budgeted (train.ts).
export const FLOOR = 5
export const CEILING = 60

// Seconds for a puzzle: the think time for each of the player's moves in it
export const limitFor = (think: number, moves: number) => Math.min(CEILING, Math.max(FLOOR, Math.round(think))) * moves

// The profile at the speed of the puzzle's game, else the one with the most
// games (bullet, classical and daily have none, nor do untimed games
// against Maia)
export function thinkFor(profiles: TimeProfile[], g?: Game): number {
  const speed = g && (g.site === 'maia' ? speedOf(g.speed) : g.speed)
  return (profiles.find(p => p.speed === speed) ?? profiles[0]).think
}

// The own puzzles due soonest, as many as a day's queue
export function timedSet(puzzles: Puzzle[], games: Map<string, Game>, profiles: TimeProfile[], n: number): { id: string; limit: number }[] {
  return puzzles
    .filter(p => p.source !== 'lichess')
    .sort((a, b) => +a.card.due - +b.card.due)
    .slice(0, n)
    .map(p => ({ id: p.id, limit: limitFor(thinkFor(profiles, games.get(p.gameId)), p.solutionLen) }))
}

// Starts once the opponent's last move has landed and it is the player's
// turn, and shows the solution when it reaches zero
export class Countdown {
  readonly limit: number // seconds
  left: number // milliseconds
  out = false
  private deadline?: number
  private drill: Pick<Drill, 'state' | 'yourTurn' | 'viewSolution'>
  private redraw: () => void
  private onOut: () => void
  private now: () => number
  private timer: ReturnType<typeof setInterval>

  constructor(limit: number, drill: Pick<Drill, 'state' | 'yourTurn' | 'viewSolution'>, redraw: () => void, onOut: () => void, now = Date.now) {
    this.limit = limit
    this.left = limit * 1000
    this.drill = drill
    this.redraw = redraw
    this.onOut = onOut
    this.now = now
    this.timer = setInterval(() => this.tick(), 100)
  }

  private tick() {
    if (this.drill.state !== 'playing') return this.destroy()
    if (this.deadline === undefined) {
      if (!this.drill.yourTurn) return
      this.deadline = this.now() + this.limit * 1000
    }
    this.left = Math.max(0, this.deadline - this.now())
    if (!this.left) {
      this.out = true
      this.destroy()
      this.onOut()
      this.drill.viewSolution()
    }
    this.redraw()
  }

  destroy() {
    clearInterval(this.timer)
  }
}
