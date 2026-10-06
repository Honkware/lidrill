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
import { parseTyped } from './typed'

export type DrillState = 'playing' | 'solved' | 'failed'

export interface DrillOptions {
  // Daily queue puzzles feed FSRS; Turning Points stops don't
  record: boolean
  onFinish?: (solved: boolean) => void
}

// One puzzle on one board. The view reads its fields; moves come in from
// chessground and the controller calls redraw when something changes.
export class Drill {
  state: DrillState = 'playing'
  step = 0
  hinted = false
  game?: Game
  reviewId?: number
  private pos: Chess
  private cg?: Api

  readonly puzzle: Puzzle
  private redraw: () => void
  private opts: DrillOptions

  constructor(puzzle: Puzzle, redraw: () => void, opts: DrillOptions = { record: true }) {
    this.puzzle = puzzle
    this.redraw = redraw
    this.opts = opts
    this.pos = Chess.fromSetup(parseFen(puzzle.fen).unwrap()).unwrap()
    if (puzzle.gameId)
      db.games.get(puzzle.gameId).then(g => {
        this.game = g
        redraw()
      })
  }

  get color() {
    return this.pos.turn
  }

  mount(el: HTMLElement) {
    this.useBoard(Chessground(el, { coordinates: true, premovable: { enabled: false } }), true)
  }

  // Take over a board that's already on screen (Turning Points replays the
  // game on it first). The drill only destroys boards it created.
  useBoard(cg: Api, owned = false) {
    this.cg = cg
    this.owned = owned
    cg.set({
      fen: this.puzzle.fen,
      orientation: this.color,
      turnColor: this.color,
      check: this.pos.isCheck(),
      movable: { free: false, color: this.color, dests: chessgroundDests(this.pos), showDests: true },
      events: { move: (orig, dest) => this.onMove(orig, dest) },
    })
  }

  destroy() {
    this.timers.forEach(clearTimeout)
    if (this.owned) this.cg?.destroy()
  }

  private owned = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private later(f: () => void, ms: number) {
    this.timers.push(setTimeout(f, ms))
  }

  // Marks the piece to move. The drill still counts, as Hard if solved.
  hint() {
    if (this.state !== 'playing' || this.hinted) return
    this.hinted = true
    const from = this.puzzle.solution[this.step].slice(0, 2) as Key
    this.cg?.set({ highlight: { custom: new Map([[from, 'hint']]) } })
    this.redraw()
  }

  // For hold puzzles: every move that would have done
  get holdingSans(): string[] {
    return (this.puzzle.alternatives ?? []).map(uci => this.sanAt(uci))
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
    this.onUci(uci)
  }

  // Keyboard entry; returns false if the text isn't a legal move here
  typeMove(text: string): boolean {
    if (this.state !== 'playing' || this.pos.turn !== this.color) return false
    const uci = parseTyped(this.pos, text)
    if (!uci) return false
    this.cg?.move(uci.slice(0, 2) as Key, uci.slice(2, 4) as Key)
    this.onUci(uci)
    return true
  }

  private onUci(uci: string) {
    const expected = this.puzzle.solution[this.step]
    // Castling arrives as e1g1 or e1h1 depending on where the king was dropped
    const here = makeFen(this.pos.toSetup())
    const accepted = this.step === 0 && this.puzzle.alternatives ? this.puzzle.alternatives : [expected]
    const hit = accepted.find(a => a && (a === uci || this.sanAt(a, here) === this.sanAt(uci, here)))
    if (!hit) return this.finish(false)
    uci = hit
    this.cg?.set({ highlight: { custom: new Map() } })
    this.play(uci)
    if (this.step >= this.puzzle.solution.length) return this.finish(true)
    // Opponent's reply from the solution line
    this.later(() => {
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
      rest.forEach((uci, i) => this.later(() => this.play(uci), 500 + i * 600))
    }
    this.cg?.set({ highlight: { custom: new Map() } })
    if (this.opts.record) this.reviewId = await recordAttempt(this.puzzle, solved, new Date(), this.hinted)
    this.opts.onFinish?.(solved)
    this.redraw()
  }
}
