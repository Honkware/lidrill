import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import type { Color } from 'chessops/types'
import { checkColor } from './checkColor'
import type { Game, JournalEntry, Puzzle } from './db'

// Lichess's keys for stepping through a game (lila ui/round/src/keyboard.ts):
// left/k back, right/j on, up/0/home to the start, down/$/end to the end.
// Returns the ply to go to, or undefined when the key isn't one of them.
export function stepKey(e: KeyboardEvent, ply: number, last: number): number | undefined {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
  // Leave the browser's own shortcuts alone, such as ctrl+0 for zoom
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const to: Record<string, number> = { ArrowLeft: ply - 1, k: ply - 1, ArrowRight: ply + 1, j: ply + 1, ArrowUp: 0, '0': 0, Home: 0, ArrowDown: last, $: last, End: last }
  return to[e.key]
}

// Review of one game: step through it with the move list or the arrow keys.
export class GameView {
  ply: number
  readonly game: Game
  journal?: JournalEntry
  puzzles: Puzzle[] = []
  private fens: string[]
  private checks: (Color | false)[]
  private cg?: Api
  private redraw: () => void
  private onKey = (e: KeyboardEvent) => {
    const to = stepKey(e, this.ply, this.fens.length - 1)
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
      this.checks.push(checkColor(pos))
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
      turnColor: this.fens[this.ply].split(' ')[1] === 'w' ? 'white' : 'black',
    })
    this.redraw()
  }

  // SAN of a UCI move in the position before `ply`
  sanBefore(ply: number, uci: string): string {
    const move = parseUci(uci)
    return move ? makeSan(Chess.fromSetup(parseFen(this.fens[ply - 1]).unwrap()).unwrap(), move) : uci
  }

  // The player's mistakes and blunders, for "jump to" buttons
  get lowPoints(): number[] {
    const mine = this.game.color === 'white' ? 1 : 0
    return this.game.moves.flatMap((m, i) => ((i + 1) % 2 === mine && (m.judg === 'blunder' || m.judg === 'mistake') ? [i + 1] : []))
  }
}
