import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { DrawShape } from '@lichess-org/chessground/draw'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseSquare, parseUci } from 'chessops/util'
import type { Engine } from './analysis/engine'
import { checkColor } from './checkColor'
import { db, type Game, type Puzzle } from './db'
import { CERT_RUN_VERSION, contextFor, explain } from './explain'
import { whyShapes, type WhyStored } from './puzzles/whyShapes'
import { renderSlot, type BoardLink, type Segment } from './server/render'
import type { Packet, SlotName } from './server/packet'
import { pawns } from './format'
import { recordAttempt } from './train'
import { landSound, sound } from './sound'

// How a puzzle plays, modelled on Lichess's trainer (lila ui/puzzle):
// - the opponent's last move is animated in, half a second after the start;
// - a wrong move is shown, taken back after 300 ms, and the player tries
//   again, but the first wrong move already decides the result;
// - any checkmate solves it, castling counts either way, and hold puzzles
//   accept any of their saving moves;
// - the hint marks the piece to move (solve = Hard, not a fail);
// - "View the solution" turns up after a miss or after 4 seconds and counts
//   as a fail;
// - a puzzle that was missed, or whose solution was viewed, ends with the
//   arrows of "Why?" on its position (see `shapes`);
// - once over, the line can be stepped through and played on freely, with
//   Stockfish's eval of the shown position.

export type DrillState = 'playing' | 'view'
export type Feedback = 'start' | 'good' | 'fail' | 'win'
export type Outcome = 'clean' | 'hinted' | 'missed' | 'shown'

// Back/forward review within a drill session: one step at a time through the
// completed puzzles, capped at the first one; stepping forward past the last
// completed returns to the live puzzle. Pure navigation - it never touches
// grades or the queue (the stored Drill instances re-render read-only in
// their finished state).
export class SessionReview {
  private completed = 0
  viewing?: number

  reset() {
    this.completed = 0
    this.viewing = undefined
  }

  onComplete() {
    this.completed++
  }

  get canBack() {
    return this.viewing === undefined ? this.completed > 0 : this.viewing > 0
  }

  get canForward() {
    return this.viewing !== undefined
  }

  // Returns the puzzle index to show, or undefined for the live puzzle
  back(): number | undefined {
    if (!this.canBack) return this.viewing
    this.viewing = this.viewing === undefined ? this.completed - 1 : this.viewing - 1
    return this.viewing
  }

  forward(): number | undefined {
    if (this.viewing === undefined) return undefined
    this.viewing++
    if (this.viewing >= this.completed) this.viewing = undefined
    return this.viewing
  }
}

// Where a run of puzzles stands, for "Puzzle 3 of 7": done are the answered
// ones, left the ones still queued. The puzzle on the board is one more
// until it is answered, and stays the same puzzle when it is retried.
export function runProgress(done: number, left: number, answered: boolean, viewing?: number): { at: number; total: number } {
  const at = viewing !== undefined ? viewing + 1 : answered ? done : done + 1
  return { at, total: done + left + (answered ? 0 : 1) }
}

export interface DrillOptions {
  // Daily queue puzzles feed FSRS; Turning Points stops don't
  record: boolean
  source?: 'queue' | 'replay'
  engine?: Engine // evals in view mode
  certEngines?: Engine[] // for "Why?"; the app's certification engines by default
  // (Turning Points): collapse the explanation's packet to the game's
  // stored eval line before it renders, so no stop contradicts another
  consistency?: (packet: Packet) => Packet
  onFinish?: (outcome: Outcome) => void
  // A sample puzzle explains itself: its own text for "Why?", and its own
  // arrows where another puzzle's are worked out from what is stored
  note?: string
  arrows?: DrawShape[]
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

let made = 0

export class Drill {
  readonly key: string // a new board for every go at a puzzle
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
  firstTry?: string // UCI of the first wrong try at the first move, for "Why?"
  solvedMove?: string // UCI of the first-ply move that solved the puzzle - it selects the explanation frame
  nodes: Node[]
  cursor = 0
  start = 0 // index of the puzzle position in nodes
  evalText?: string
  game?: Game
  reviewId?: number
  flipped = false
  showWhy = false
  why?: { loading?: boolean; progress?: [number, number]; slots?: { slot: SlotName; segments: Segment[] }[]; floor?: boolean; error?: string }
  readonly puzzle: Puzzle
  readonly opts: DrillOptions
  private cg?: Api
  private owned = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private evalFor = ''
  private recorded = false
  private reverting = false // a wrong move is on the board for a moment
  private redraw: () => void
  private loaded: Promise<unknown>
  private stored: WhyStored = {}

  constructor(puzzle: Puzzle, redraw: () => void, opts: DrillOptions = { record: true }) {
    this.puzzle = puzzle
    this.key = `${puzzle.id}#${++made}`
    this.redraw = redraw
    this.opts = opts
    this.nodes = [{ fen: puzzle.fen }]
    const game = puzzle.gameId
      ? db.games.get(puzzle.gameId).then(g => {
          this.game = g
          this.addIntro()
        })
      : Promise.resolve(this.addIntro())
    this.loaded = Promise.all([game, opts.arrows ? undefined : this.loadStored()])
  }

  // Read when the puzzle opens, so the arrows wait on nothing later: the
  // certification runs, and the packet of an explanation already made
  private async loadStored() {
    const cert = await db.certs.get(this.puzzle.id)
    const row = await db.explanations.where('puzzleId').equals(this.puzzle.id).first()
    this.stored = { runs: cert?.version === CERT_RUN_VERSION ? cert.runs : undefined, packet: row?.packet }
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
    cg.set({ events: { move: (orig, dest) => void this.move(orig, dest) } })
    this.loaded.then(() => {
      // Turning Points arrives with the board already at the puzzle position
      this.cursor = owned ? 0 : this.start
      // A new board holds the starting position, and the pieces would slide
      // from there to the puzzle's
      if (owned) cg.set({ animation: { enabled: false } })
      this.sync()
      if (owned) cg.set({ animation: { enabled: true } })
      if (this.cursor < this.start)
        this.later(() => {
          this.land(this.start) // the opponent's last move animates in
          this.go(this.start)
        }, INTRO_MS)
      this.later(() => {
        this.canViewSolution = true
        this.redraw()
      }, SOLUTION_BUTTON_MS)
      this.redraw()
    })
  }

  destroy() {
    this.timers.forEach(clearTimeout)
    clearTimeout(this.previewTimer)
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

  // The arrows of "Why?", drawn on the puzzle position only. They are up
  // while "Why?" is open, and without it after a miss or a viewed solution.
  // Auto shapes, so the player's own drawings stay.
  get shapes(): DrawShape[] {
    const wanted = this.showWhy || this.outcome === 'missed' || this.outcome === 'shown'
    if (this.state !== 'view' || !wanted || this.cursor !== this.start) return []
    return this.opts.arrows ?? whyShapes(this.puzzle, this.stored, this.firstTry ?? this.puzzle.played)
  }

  private sync() {
    this.previewing = undefined
    this.cg?.setAutoShapes(this.shapes)
    const node = this.nodes[this.cursor]
    const pos = this.posAt(this.cursor)
    const playable = this.state === 'view' || (this.yourTurn && !this.reverting)
    const hint = this.showHint && this.state === 'playing' ? this.puzzle.solution[this.step]?.slice(0, 2) : undefined
    this.cg?.set({
      fen: node.fen,
      orientation: this.flipped ? (this.color === 'white' ? 'black' : 'white') : this.color,
      turnColor: pos.turn,
      check: checkColor(pos),
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

  // A move made on the board; false while it is not the player's to make
  move(orig: Key, dest: Key): boolean {
    if (this.state === 'playing' && (!this.yourTurn || this.reverting)) return false
    const pos = this.posAt(this.cursor)
    let uci = orig + dest
    const expected = this.puzzle.solution[this.step]
    // Promotions: the solution's piece if the squares match, else a queen
    if (this.state === 'playing' && expected?.startsWith(uci) && expected.length === 5) uci = expected
    else if (pos.board.get(parseSquare(orig)!)?.role === 'pawn' && /[18]$/.test(dest)) uci += 'q'
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
      this.land(this.cursor)
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
    if (this.step === 0) this.solvedMove ??= hit ?? uci
    this.step++
    sound.good() // the grade: right move
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
      this.land(this.cursor)
      this.sync()
      this.redraw()
    }, REPLY_MS)
  }

  // The sound of the move that produced nodes[i]: a capture or a check if it
  // is one, else the plain knock. Nodes before index 1 have no from-position.
  private land(i: number) {
    const uci = this.nodes[i]?.uci
    const move = uci && parseUci(uci)
    if (!move || i < 1) return
    const before = this.posAt(i - 1)
    const capture = before.board.get(move.to) !== undefined || move.to === before.epSquare
    sound[landSound(capture, this.posAt(i).isCheck())]()
  }

  // Show the wrong move, then take it back and let the player try again
  private miss(uci: string, san: string) {
    this.misses.push(san)
    sound.bad() // the grade: wrong move
    if (this.step === 0) this.firstTry ??= uci
    this.feedback = 'fail'
    this.reverting = true
    this.canViewSolution = true
    const pos = this.posAt(this.cursor)
    pos.play(parseUci(uci)!)
    this.cg?.set({
      fen: makeFen(pos.toSetup()),
      turnColor: pos.turn,
      check: checkColor(pos),
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

  // The hint is earned by a wrong try, and stays once it has been shown
  get hintReady() {
    return this.feedback === 'fail' || this.showHint
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
    // From the puzzle position the arrows show the answer, and the line is a
    // step away; further in, the next move of the line is shown
    this.go(from === this.start ? from : Math.min(from + 1, this.nodes.length - 1))
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
    this.reviewId = await recordAttempt(this.puzzle, solved, new Date(), outcome === 'hinted', this.opts.source)
  }

  // While a word in the explanation is hovered or tapped: the position the
  // move is played from, with its arrow (or a circle for a square)
  previewing?: BoardLink

  // A move is played out on the board: its starting position appears, then
  // the move animates in. A square just gets a circle.
  preview(target?: BoardLink) {
    this.previewing = target
    clearTimeout(this.previewTimer)
    // The panel marks the word being shown
    this.redraw()
    if (!target) {
      this.cg?.set({ animation: { enabled: true } })
      return this.sync()
    }
    const still = { lastMove: undefined, check: false, movable: { color: undefined, dests: new Map() }, highlight: { custom: new Map() } }
    if (target.fen && target.after && target.from) {
      this.cg?.setAutoShapes([])
      const before = Chess.fromSetup(parseFen(target.fen).unwrap()).unwrap()
      this.cg?.set({ ...still, animation: { enabled: false }, fen: target.fen, turnColor: before.turn })
      this.previewTimer = setTimeout(() => {
        if (this.previewing !== target) return
        const after = Chess.fromSetup(parseFen(target.after!).unwrap()).unwrap()
        this.cg?.set({ animation: { enabled: true }, fen: target.after, turnColor: after.turn, lastMove: [target.from as Key, target.to as Key], check: checkColor(after) })
      }, 180)
    } else {
      // A square: circled in the position it's about
      const fen = target.fen ?? this.nodes[this.cursor].fen
      const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap()
      this.cg?.set({ ...still, animation: { enabled: true }, fen, turnColor: pos.turn, check: checkColor(pos) })
      this.cg?.setAutoShapes([{ orig: target.to as Key, brush: 'green' }])
    }
  }

  private previewTimer?: ReturnType<typeof setTimeout>

  // "Why?" opens and closes; the explanation is made once and kept
  toggleWhy() {
    if (this.state !== 'view') return
    this.showWhy = !this.showWhy
    // The arrows are drawn for the puzzle position, before anything is asked for
    this.go(this.showWhy ? this.start : this.cursor)
    if (this.showWhy) void this.explain()
  }

  // A short worded explanation built from the engine lines
  private async explain() {
    if (this.state !== 'view' || this.why?.loading || this.why?.slots) return
    if (this.opts.note) {
      this.why = { slots: [{ slot: 'why', segments: [{ text: this.opts.note }] }] }
      return this.redraw()
    }
    this.why = { loading: true }
    this.redraw()
    try {
      const ctx = await contextFor(this.puzzle, this.game)
      const pipeline = await import('./pipeline')
      const engines = this.opts.certEngines ?? pipeline.getCertEngines()
      const e = await pipeline.whileExplaining(() =>
        explain(this.puzzle, engines, ctx, this.firstTry, (done, total) => {
          if (this.why?.loading) this.why = { loading: true, progress: [done, total] }
          this.redraw()
        }, this.solvedMove),
      )
      // The packet may certify a threat the stored runs could not show
      this.stored = { ...this.stored, packet: e.packet }
      this.cg?.setAutoShapes(this.shapes)
      const packet = this.opts.consistency?.(e.packet) ?? e.packet
      this.why = { slots: e.slots.map(s => ({ slot: s.slot, segments: renderSlot(s, packet) })), floor: e.floor }
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
