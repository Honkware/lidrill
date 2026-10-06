import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import type { Game, JournalEntry, Puzzle } from './db'

// Review of one game: step through it with the move list or the arrow keys.
export class GameView {
  ply: number
  readonly game: Game
  journal?: JournalEntry
  puzzles: Puzzle[] = []
  private fens: string[]
  private checks: boolean[]
  private cg?: Api
  private redraw: () => void
  private onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
    const to = { ArrowLeft: this.ply - 1, ArrowRight: this.ply + 1, Home: 0, End: this.fens.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    this.go(to)
  }

  constructor(game: Game, redraw: () => void, ply = 0) {
    this.game = game
    this.redraw = redraw
    this.ply = ply
    const pos = Chess.default()
    this.fens = [makeFen(pos.toSetup())]
    this.checks = [false]
    for (const m of game.moves) {
      pos.play(parseUci(m.uci)!)
      this.fens.push(makeFen(pos.toSetup()))
      this.checks.push(pos.isCheck())
    }
  }

  mount(el: HTMLElement) {
    this.cg = Chessground(el, { orientation: this.game.color, coordinates: true, viewOnly: true })
    window.addEventListener('keydown', this.onKey)
    this.go(this.ply)
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey)
    this.cg?.destroy()
  }

  go(ply: number) {
    this.ply = Math.max(0, Math.min(this.fens.length - 1, ply))
    const last = this.game.moves[this.ply - 1]
    this.cg?.set({
      fen: this.fens[this.ply],
      lastMove: last ? ([last.uci.slice(0, 2), last.uci.slice(2, 4)] as Key[]) : undefined,
      check: this.checks[this.ply],
    })
    this.redraw()
  }

  // The player's mistakes and blunders, for "jump to" buttons
  get lowPoints(): number[] {
    const mine = this.game.color === 'white' ? 1 : 0
    return this.game.moves.flatMap((m, i) => ((i + 1) % 2 === mine && (m.judg === 'blunder' || m.judg === 'mistake') ? [i + 1] : []))
  }
}
