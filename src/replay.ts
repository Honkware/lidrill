import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import type { Engine } from './analysis/engine'
import { checkColor } from './checkColor'
import { Drill } from './drill'
import { db, type Game, type Puzzle } from './db'

export type ReplayState = 'playing' | 'stop' | 'between' | 'done'

const STEP_MS = 450

// Turning Points: the game plays itself and stops at each critical
// moment, where the player has to find the move. Stops are the game's own
// puzzles, so a stop is exactly the position a puzzle was made from.
export class Replay {
  state: ReplayState = 'playing'
  ply = 0 // moves on the board
  drill?: Drill
  results: boolean[] = []
  private reviewIds: number[] = []
  readonly game: Game
  readonly stops: Puzzle[]
  private fens: string[]
  private cg?: Api
  private timer?: ReturnType<typeof setTimeout>
  private redraw: () => void

  engine?: Engine

  constructor(game: Game, stops: Puzzle[], redraw: () => void, engine?: Engine) {
    this.engine = engine
    this.game = game
    this.stops = [...stops].sort((a, b) => a.ply - b.ply)
    this.redraw = redraw
    const pos = Chess.default()
    this.fens = [makeFen(pos.toSetup())]
    for (const m of game.moves) {
      pos.play(parseUci(m.uci)!)
      this.fens.push(makeFen(pos.toSetup()))
    }
  }

  get stopIndex() {
    return this.results.length
  }

  get current(): Puzzle | undefined {
    return this.stops[this.stopIndex]
  }

  mount(el: HTMLElement) {
    this.cg = Chessground(el, {
      fen: this.fens[0],
      orientation: this.game.color,
      coordinates: true,
      movable: { color: undefined },
      premovable: { enabled: false },
    })
    this.schedule()
  }

  destroy() {
    clearTimeout(this.timer)
    this.drill?.destroy()
    this.cg?.destroy()
  }

  // Jump straight to the next stop (or the end)
  skip() {
    clearTimeout(this.timer)
    const target = this.current ? this.current.ply - 1 : this.fens.length - 1
    this.show(target)
    this.arrive()
  }

  // After a stop: show what was actually played and carry on
  continue() {
    const stop = this.state === 'between' ? this.stops[this.stopIndex - 1] : undefined
    this.drill?.destroy()
    this.drill = undefined
    if (stop) this.show(stop.ply)
    if (!this.current) {
      // No stops left: the score is what matters, not the rest of the game
      this.show(this.fens.length - 1)
      this.state = 'done'
      return this.redraw()
    }
    this.state = 'playing'
    this.redraw()
    this.schedule()
  }

  private async saveSession() {
    await db.replaySessions.add({ gameId: this.game.id, at: Date.now(), stops: this.reviewIds, scoreN: this.results.filter(Boolean).length, scoreM: this.stops.length })
  }

  private show(ply: number) {
    this.ply = ply
    const last = this.game.moves[ply - 1]
    const pos = Chess.default()
    for (const m of this.game.moves.slice(0, ply)) pos.play(parseUci(m.uci)!)
    this.cg?.set({
      fen: this.fens[ply],
      lastMove: last ? ([last.uci.slice(0, 2), last.uci.slice(2, 4)] as Key[]) : undefined,
      turnColor: pos.turn,
      check: checkColor(pos),
      movable: { color: undefined, dests: new Map() },
      events: { move: undefined },
    })
  }

  private schedule() {
    this.timer = setTimeout(() => this.arrive(), this.atStop() ? 0 : STEP_MS)
  }

  private atStop() {
    return this.current !== undefined && this.ply === this.current.ply - 1
  }

  private arrive() {
    if (this.atStop()) {
      this.state = 'stop'
      const drill = new Drill(this.current!, this.redraw, {
        // Stops are reviews like any other: the scheduler counts them
        record: true,
        source: 'replay',
        engine: this.engine,
        onFinish: outcome => {
          this.results.push(outcome === 'clean' || outcome === 'hinted')
          if (drill.reviewId !== undefined) this.reviewIds.push(drill.reviewId)
          this.state = 'between'
          if (!this.current) void this.saveSession()
        },
      })
      this.drill = drill
      this.drill.useBoard(this.cg!)
      this.redraw()
      return
    }
    if (this.ply >= this.game.moves.length) {
      this.state = 'done'
      this.redraw()
      return
    }
    this.show(this.ply + 1)
    this.redraw()
    this.schedule()
  }
}
