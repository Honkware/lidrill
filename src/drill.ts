import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseSquare, parseUci } from 'chessops/util'
import { db, type Game, type Puzzle } from './db'
import { recordAttempt } from './train'

export type DrillState = 'playing' | 'solved' | 'failed'

// One puzzle on one board. The view reads its fields; moves come in from
// chessground and the controller calls redraw when something changes.
export class Drill {
  state: DrillState = 'playing'
  step = 0
  game?: Game
  reviewId?: number
  private pos: Chess
  private cg?: Api

  readonly puzzle: Puzzle
  private redraw: () => void

  constructor(puzzle: Puzzle, redraw: () => void) {
    this.puzzle = puzzle
    this.redraw = redraw
    this.pos = Chess.fromSetup(parseFen(puzzle.fen).unwrap()).unwrap()
    db.games.get(puzzle.gameId).then(g => {
      this.game = g
      redraw()
    })
  }

  get color() {
    return this.pos.turn
  }

  mount(el: HTMLElement) {
    this.cg = Chessground(el, {
      fen: this.puzzle.fen,
      orientation: this.color,
      turnColor: this.color,
      coordinates: true,
      movable: { free: false, color: this.color, dests: chessgroundDests(this.pos), showDests: true },
      premovable: { enabled: false },
      events: { move: (orig, dest) => this.onMove(orig, dest) },
    })
  }

  destroy() {
    this.cg?.destroy()
  }

  // SAN of a UCI move from the puzzle's starting position
  sanAt(uci: string, fen = this.puzzle.fen): string {
    const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap()
    return makeSan(pos, parseUci(uci)!)
  }

  private onMove(orig: Key, dest: Key) {
    const expected = this.puzzle.solution[this.step]
    // Promotions: take the solution's piece if the squares match, else a queen
    let uci = orig + dest
    if (expected?.startsWith(uci) && expected.length === 5) uci = expected
    else if (this.pos.board.get(parseSquare(orig)!)?.role === 'pawn' && /[18]$/.test(dest)) uci += 'q'

    if (uci !== expected) return this.finish(false)
    this.play(uci)
    if (this.step >= this.puzzle.solution.length) return this.finish(true)
    // Opponent's reply from the solution line
    setTimeout(() => {
      this.play(this.puzzle.solution[this.step])
      this.cg?.set({ turnColor: this.color, movable: { color: this.color, dests: chessgroundDests(this.pos) } })
      this.redraw()
    }, 350)
    this.redraw()
  }

  private play(uci: string) {
    const move = parseUci(uci)!
    this.pos.play(move)
    this.step++
    this.cg?.set({
      fen: makeFen(this.pos.toSetup()),
      lastMove: [uci.slice(0, 2), uci.slice(2, 4)] as Key[],
      turnColor: this.pos.turn,
      check: this.pos.isCheck(),
      movable: { color: undefined, dests: new Map() },
    })
  }

  private async finish(solved: boolean) {
    this.state = solved ? 'solved' : 'failed'
    this.cg?.set({ movable: { color: undefined, dests: new Map() } })
    if (!solved) {
      // Walk the rest of the solution so the player sees it
      const rest = this.puzzle.solution.slice(this.step)
      this.cg?.set({ fen: makeFen(this.pos.toSetup()) })
      rest.forEach((uci, i) => setTimeout(() => this.play(uci), 500 + i * 600))
    }
    this.reviewId = await recordAttempt(this.puzzle, solved)
    this.redraw()
  }
}
