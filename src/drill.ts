import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseSquare, parseUci } from 'chessops/util'
import type { Engine } from './analysis/engine'
import { db, type Game, type Puzzle } from './db'
import { explain } from './explain'
import { pawns } from './format'
import { recordAttempt } from './train'
import { parseTyped } from './typed'

// How a puzzle plays, modelled on Lichess's trainer (lila ui/puzzle):
// - the opponent's last move is animated in, half a second after the start;
// - a wrong move is shown, taken back after 300 ms, and the player tries
//   again, but the first wrong move already decides the result;
// - any checkmate solves it, castling counts either way, and hold puzzles
//   accept any of their saving moves;
// - the hint marks the piece to move (solve = Hard, not a fail);
// - "View the solution" turns up after a miss or after 4 seconds and counts
//   as a fail;
// - once over, the line can be stepped through and played on freely, with
//   Stockfish's eval of the shown position.

export type DrillState = 'playing' | 'view'
export type Feedback = 'start' | 'good' | 'fail' | 'win'
export type Outcome = 'clean' | 'hinted' | 'missed' | 'shown'

export interface DrillOptions {
  // Daily queue puzzles feed FSRS; Turning Points stops don't
  record: boolean
  engine?: Engine // evals in view mode
  onFinish?: (outcome: Outcome) => void
}

export interface Node {
  fen: string
  uci?: string // the move that led here
  san?: string
  mark?: 'good' | 'win' // a solution move the player found
  solution?: boolean // shown by "View the solution"
}

const REVERT_MS = 300
const REPLY_MS = 350
const INTRO_MS = 500
const SOLUTION_BUTTON_MS = 4000

export class Drill {
  state: DrillState = 'playing'
  feedback: Feedback = 'start'
  step = 0 // solution index of the next expected move
  hinted = false
  showHint = false
  failed = false
  shown = false
  canViewSolution = false
  outcome?: Outcome
  misses: string[] = [] // SAN of wrong tries
  nodes: Node[]
  cursor = 0
  start = 0 // index of the puzzle position in nodes
  evalText?: string
  game?: Game
  reviewId?: number
  flipped = false
  why?: { loading?: boolean; text?: string; error?: string }
  readonly puzzle: Puzzle
  private cg?: Api
  private owned = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private evalFor = ''
  private recorded = false
  private reverting = false // a wrong move is on the board for a moment
  private redraw: () => void
  private opts: DrillOptions
  private loaded: Promise<void>

  constructor(puzzle: Puzzle, redraw: () => void, opts: DrillOptions = { record: true }) {
    this.puzzle = puzzle
    this.redraw = redraw
    this.opts = opts
    this.nodes = [{ fen: puzzle.fen }]
    this.loaded = puzzle.gameId
      ? db.games.get(puzzle.gameId).then(g => {
          this.game = g
          this.addIntro()
        })
      : Promise.resolve(this.addIntro())
  }

  // The position before the opponent's last move, when it's known
  private addIntro() {
    let before: string | undefined
    let uci: string | undefined
    const g = this.game
    if (g && this.puzzle.ply > 1) {
      const pos = Chess.default()
      for (const m of g.moves.slice(0, this.puzzle.ply - 2)) pos.play(parseUci(m.uci)!)
      before = makeFen(pos.toSetup())
      uci = g.moves[this.puzzle.ply - 2].uci
    } else if (this.puzzle.before && this.puzzle.lastMove) {
      before = this.puzzle.before
      uci = this.puzzle.lastMove
    }
    if (!before && this.puzzle.lastMove) this.nodes[0].uci = this.puzzle.lastMove // highlight only
    if (!before || !uci) return
    this.nodes = [{ fen: before }, { fen: this.puzzle.fen, uci, san: this.san(before, uci) }]
    this.start = 1
  }

  get color(): 'white' | 'black' {
    return this.posAt(this.start).turn
  }

  private posAt(i: number): Chess {
    return Chess.fromSetup(parseFen(this.nodes[i].fen).unwrap()).unwrap()
  }

  private san(fen: string, uci: string): string {
    const move = parseUci(uci)
    return move ? makeSan(Chess.fromSetup(parseFen(fen).unwrap()).unwrap(), move) : uci
  }

  // SAN of a UCI move from the puzzle's starting position
  sanAt(uci: string, fen = this.puzzle.fen): string {
    return this.san(fen, uci)
  }

  get holdingSans(): string[] {
    return (this.puzzle.alternatives ?? []).map(uci => this.sanAt(uci))
  }

  mount(el: HTMLElement) {
    this.useBoard(Chessground(el, { coordinates: true, premovable: { enabled: false } }), true)
  }

  // Take over a board that's already on screen (Turning Points replays the
  // game on it first). The drill only destroys boards it created.
  useBoard(cg: Api, owned = false) {
    this.cg = cg
    this.owned = owned
    cg.set({ events: { move: (orig, dest) => this.onMove(orig, dest) } })
    this.loaded.then(() => {
      // Turning Points arrives with the board already at the puzzle position
      this.cursor = owned ? 0 : this.start
      this.sync()
      if (this.cursor < this.start) this.later(() => this.go(this.start), INTRO_MS)
      this.later(() => {
        this.canViewSolution = true
        this.redraw()
      }, SOLUTION_BUTTON_MS)
      this.redraw()
    })
  }

  destroy() {
    this.timers.forEach(clearTimeout)
    if (this.owned) this.cg?.destroy()
  }

  private later(f: () => void, ms: number) {
    this.timers.push(setTimeout(f, ms))
  }

  // --- board ---

  get atTip() {
    return this.cursor === this.nodes.length - 1
  }

  get yourTurn() {
    return this.state === 'playing' && this.atTip && this.cursor >= this.start && this.posAt(this.cursor).turn === this.color
  }

  private sync() {
    const node = this.nodes[this.cursor]
    const pos = this.posAt(this.cursor)
    const playable = this.state === 'view' || (this.yourTurn && !this.reverting)
    const hint = this.showHint && this.state === 'playing' ? this.puzzle.solution[this.step]?.slice(0, 2) : undefined
    this.cg?.set({
      fen: node.fen,
      orientation: this.flipped ? (this.color === 'white' ? 'black' : 'white') : this.color,
      turnColor: pos.turn,
      check: pos.isCheck(),
      lastMove: node.uci ? ([node.uci.slice(0, 2), node.uci.slice(2, 4)] as Key[]) : undefined,
      movable: playable
        ? { free: false, color: this.state === 'view' ? 'both' : this.color, dests: chessgroundDests(pos), showDests: true }
        : { color: undefined, dests: new Map() },
      highlight: { custom: hint ? new Map([[hint as Key, 'hint']]) : new Map() },
    })
    if (hint) this.cg?.selectSquare(hint as Key)
    if (this.state === 'view') this.evaluate()
  }

  go(i: number) {
    this.cursor = Math.max(0, Math.min(this.nodes.length - 1, i))
    this.showHint = false
    this.sync()
    this.redraw()
  }

  flip() {
    this.flipped = !this.flipped
    this.sync()
    this.redraw()
  }

  // --- moves ---

  private onMove(orig: Key, dest: Key) {
    const pos = this.posAt(this.cursor)
    let uci = orig + dest
    const expected = this.puzzle.solution[this.step]
    // Promotions: the solution's piece if the squares match, else a queen
    if (this.state === 'playing' && expected?.startsWith(uci) && expected.length === 5) uci = expected
    else if (pos.board.get(parseSquare(orig)!)?.role === 'pawn' && /[18]$/.test(dest)) uci += 'q'
    this.onUci(uci)
  }

  // Keyboard entry; false if the text isn't a legal move here
  typeMove(text: string): boolean {
    if (this.state === 'playing' && (!this.yourTurn || this.reverting)) return false
    const uci = parseTyped(this.posAt(this.cursor), text)
    if (!uci) return false
    this.onUci(uci)
    return true
  }

  private push(uci: string, extra: Partial<Node> = {}): Chess {
    const pos = this.posAt(this.cursor)
    const move = parseUci(uci)!
    const san = makeSan(pos, move)
    pos.play(move)
    this.nodes = this.nodes.slice(0, this.cursor + 1)
    this.nodes.push({ fen: makeFen(pos.toSetup()), uci, san, ...extra })
    this.cursor = this.nodes.length - 1
    return pos
  }

  private onUci(uci: string) {
    if (this.state === 'view') {
      // Free play after the puzzle: a new line from here
      this.push(uci)
      this.sync()
      return this.redraw()
    }
    const here = this.nodes[this.cursor].fen
    const expected = this.puzzle.solution[this.step]
    const accepted = this.step === 0 && this.puzzle.alternatives ? this.puzzle.alternatives : [expected]
    const san = this.san(here, uci)
    const hit = accepted.find(a => a && (a === uci || this.san(here, a) === san))
    const after = this.posAt(this.cursor)
    after.play(parseUci(uci)!)
    if (!hit && !after.isCheckmate()) return this.miss(uci, san)

    this.showHint = false
    const end = this.push(hit ?? uci, { mark: 'good' })
    this.step++
    if (end.isCheckmate() || this.step >= this.puzzle.solution.length) {
      this.nodes[this.cursor].mark = 'win'
      return void this.complete()
    }
    this.feedback = 'good'
    this.sync()
    this.redraw()
    // The opponent's reply from the solution line
    this.later(() => {
      this.push(this.puzzle.solution[this.step])
      this.step++
      this.sync()
      this.redraw()
    }, REPLY_MS)
  }

  // Show the wrong move, then take it back and let the player try again
  private miss(uci: string, san: string) {
    this.misses.push(san)
    this.feedback = 'fail'
    this.reverting = true
    this.canViewSolution = true
    const pos = this.posAt(this.cursor)
    pos.play(parseUci(uci)!)
    this.cg?.set({
      fen: makeFen(pos.toSetup()),
      lastMove: [uci.slice(0, 2), uci.slice(2, 4)] as Key[],
      movable: { color: undefined, dests: new Map() },
    })
    if (!this.failed) {
      this.failed = true
      this.record('missed')
    }
    this.redraw()
    // Take it back; the message stays until the next move
    this.later(() => {
      this.reverting = false
      if (this.state !== 'playing') return
      this.sync()
      this.redraw()
    }, REVERT_MS)
  }

  hint() {
    if (!this.yourTurn) return
    this.hinted = true
    this.showHint = !this.showHint
    this.sync()
    this.redraw()
  }

  viewSolution() {
    if (this.state !== 'playing') return
    this.shown = true
    this.timers.forEach(clearTimeout)
    this.cursor = this.nodes.length - 1
    const from = this.cursor
    while (this.step < this.puzzle.solution.length) {
      const move = parseUci(this.puzzle.solution[this.step])
      if (!move || !this.posAt(this.cursor).isLegal(move)) break
      this.push(this.puzzle.solution[this.step], { solution: true })
      this.step++
    }
    this.complete()
    this.go(Math.min(from + 1, this.nodes.length - 1))
  }

  private async complete() {
    this.state = 'view'
    this.feedback = 'win'
    this.timers.forEach(clearTimeout)
    this.outcome = this.failed ? 'missed' : this.shown ? 'shown' : this.hinted ? 'hinted' : 'clean'
    this.sync()
    this.redraw()
    await this.record(this.outcome)
    this.opts.onFinish?.(this.outcome)
    this.redraw()
  }

  private async record(outcome: Outcome) {
    if (this.recorded || !this.opts.record) return
    this.recorded = true
    const solved = outcome === 'clean' || outcome === 'hinted'
    this.reviewId = await recordAttempt(this.puzzle, solved, new Date(), outcome === 'hinted')
  }

  // Moves of the solution and the game move, by SAN, for linking words in
  // the explanation to squares on the board
  get knownMoves(): Map<string, { from: string; to: string }> {
    const out = new Map<string, { from: string; to: string }>()
    const add = (ucis: string[]) => {
      const pos = Chess.fromSetup(parseFen(this.puzzle.fen).unwrap()).unwrap()
      for (const uci of ucis) {
        const move = parseUci(uci)
        if (!move || !pos.isLegal(move)) return
        out.set(makeSan(pos, move).replace(/[+#]$/, ''), { from: uci.slice(0, 2), to: uci.slice(2, 4) })
        pos.play(move)
      }
    }
    add(this.puzzle.solution)
    if (this.puzzle.played) add([this.puzzle.played])
    for (const alt of this.puzzle.alternatives ?? []) add([alt])
    return out
  }

  // Shows a square or a move on the board while a word in the explanation
  // is hovered or tapped
  point(target?: { from?: string; to: string }) {
    this.cg?.setAutoShapes(
      target ? [target.from ? { orig: target.from as Key, dest: target.to as Key, brush: 'green' } : { orig: target.to as Key, brush: 'green' }] : [],
    )
  }

  // "Why?": a short worded explanation built from the engine lines
  async explain() {
    if (this.state !== 'view' || this.why?.loading || this.why?.text) return
    this.why = { loading: true }
    this.redraw()
    try {
      this.why = { text: await explain(this.puzzle, this.opts.engine) }
    } catch (e) {
      this.why = { error: (e as Error).message }
    }
    this.redraw()
  }

  // Stockfish's view of the shown position, once the puzzle is over
  private async evaluate() {
    const engine = this.opts.engine
    const node = this.nodes[this.cursor]
    if (!engine || this.evalFor === node.fen) return
    this.evalFor = node.fen
    const pos = this.posAt(this.cursor)
    if (pos.isEnd()) {
      this.evalText = pos.isCheckmate() ? 'Checkmate' : 'Draw'
      return this.redraw()
    }
    this.evalText = '…'
    this.redraw()
    const r = await engine.search(node.fen, 14)
    if (this.evalFor !== node.fen) return
    const flip = pos.turn === 'black'
    const cp = r.eval.cp === undefined ? undefined : flip ? -r.eval.cp : r.eval.cp
    const mate = r.eval.mate === undefined ? undefined : flip ? -r.eval.mate : r.eval.mate
    const score = mate !== undefined ? `#${mate}` : pawns(cp ?? 0)
    this.evalText = r.pv[0] ? `${score} · best ${this.san(node.fen, r.pv[0])}` : score
    this.redraw()
  }
}
