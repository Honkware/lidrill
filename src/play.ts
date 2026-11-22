import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess, normalizeMove } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { makeUci, parseSquare, parseUci } from 'chessops/util'
import { checkColor } from './checkColor'
import type { Game, Result } from './db'
import { fetchMove, type Start } from './maia'
import { landSound, sound } from './sound'

// A whole game against Maia-3, from move 1 or from a position out of one of
// the player's own games. There are no hints and no take-backs: the finished
// game is stored like an imported one, and the analysis that turns mistakes
// into puzzles is where the feedback comes from.

export type PlayState = 'thinking' | 'your-move' | 'failed' | 'over'

export interface PlayOptions {
  level: number
  color: 'white' | 'black'
  rating: number // the player's estimate going in, stored on the game
  start?: Start
}

// Castling rights and the en passant square are part of a position, the move
// counters are not
const positionKey = (pos: Chess) => makeFen(pos.toSetup()).split(' ').slice(0, 4).join(' ')

export function drawn(pos: Chess, seen: Map<string, number>): boolean {
  return pos.isStalemate() || pos.isInsufficientMaterial() || pos.halfmoves >= 100 || (seen.get(positionKey(pos)) ?? 0) >= 3
}

let runs = 0

export class PlayRun {
  readonly key = `play:${++runs}` // a new board for every game
  state: PlayState = 'your-move'
  result?: Result
  ending = '' // how it ended, in words
  error?: string
  last?: string // SAN of Maia's last move
  saved?: Game
  readonly opts: PlayOptions
  readonly moves: { san: string; uci: string }[]
  private pos = Chess.default()
  private seen = new Map<string, number>()
  private cg?: Api
  private redraw: () => void
  private onEnd: (run: PlayRun) => void
  private fetchFn: typeof fetch
  private gone = false

  constructor(opts: PlayOptions, redraw: () => void, onEnd: (run: PlayRun) => void, fetchFn: typeof fetch = fetch) {
    this.opts = opts
    this.redraw = redraw
    this.onEnd = onEnd
    this.fetchFn = fetchFn
    this.moves = [...(opts.start?.moves ?? [])]
    this.count()
    for (const m of this.moves) {
      this.pos.play(parseUci(m.uci)!)
      this.count()
    }
    if (this.pos.turn !== opts.color) void this.reply()
  }

  get playerMoves() {
    return Math.floor((this.moves.length - (this.opts.start?.moves.length ?? 0) + 1) / 2)
  }

  mount(el: HTMLElement) {
    this.cg = Chessground(el, {
      orientation: this.opts.color,
      coordinates: true,
      premovable: { enabled: false },
      movable: { free: false, showDests: true },
      events: { move: (orig, dest) => this.onMove(orig, dest) },
    })
    this.sync()
  }

  destroy() {
    this.gone = true
    this.cg?.destroy()
  }

  private count() {
    const key = positionKey(this.pos)
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1)
  }

  private sync() {
    const last = this.moves.at(-1)?.uci
    const mine = this.state === 'your-move'
    this.cg?.set({
      fen: makeFen(this.pos.toSetup()),
      turnColor: this.pos.turn,
      check: checkColor(this.pos),
      lastMove: last ? ([last.slice(0, 2), last.slice(2, 4)] as Key[]) : undefined,
      movable: mine ? { color: this.opts.color, dests: chessgroundDests(this.pos) } : { color: undefined, dests: new Map() },
    })
  }

  private onMove(orig: Key, dest: Key) {
    let uci = orig + dest
    if (this.pos.board.get(parseSquare(orig)!)?.role === 'pawn' && /[18]$/.test(dest)) uci += 'q'
    void this.move(uci)
  }

  // Plays a move for whoever's turn it is; true when the game goes on
  private push(uci: string): boolean {
    // Castling is stored king-takes-rook, as in imported games
    const move = normalizeMove(this.pos, parseUci(uci)!)
    if (!this.pos.isLegal(move)) throw new Error(`Maia answered with ${uci}, which isn’t legal here.`)
    const capture = this.pos.board.get(move.to) !== undefined || move.to === this.pos.epSquare
    const mover = this.pos.turn
    this.moves.push({ san: makeSan(this.pos, move), uci: makeUci(move) })
    this.pos.play(move)
    this.count()
    sound[landSound(capture, this.pos.isCheck())]()
    if (this.pos.isCheckmate()) return this.end(mover === this.opts.color ? 'win' : 'loss', 'Checkmate'), false
    if (drawn(this.pos, this.seen)) return this.end('draw', this.pos.isStalemate() ? 'Stalemate' : 'Draw'), false
    return true
  }

  // The player's move, as the board reports it
  async move(uci: string) {
    if (this.state !== 'your-move') return
    if (!this.push(uci)) return
    await this.reply()
  }

  private async reply() {
    this.state = 'thinking'
    this.error = undefined
    this.sync()
    this.redraw()
    try {
      const uci = await fetchMove(this.moves.map(m => m.uci), this.opts.level, this.fetchFn)
      if (this.gone || this.state !== 'thinking') return
      const before = this.moves.length
      if (!this.push(uci)) return
      this.last = this.moves[before].san
      this.state = 'your-move'
    } catch (e) {
      if (this.state !== 'thinking') return
      this.state = 'failed'
      this.error = (e as Error).message
    }
    this.sync()
    this.redraw()
  }

  retry() {
    if (this.state === 'failed') void this.reply()
  }

  resign() {
    if (this.state !== 'over') this.end('loss', 'Resigned')
  }

  private end(result: Result, ending: string) {
    this.state = 'over'
    this.result = result
    this.ending = ending
    sound[result === 'win' ? 'win' : result === 'loss' ? 'lose' : 'draw']()
    this.sync()
    this.redraw()
    this.onEnd(this)
  }

  // The finished game in the shape of an imported one, so analysis, puzzles
  // and Turning Points treat it the same
  toGame(now: number): Game {
    const white = this.opts.color === 'white'
    const score = this.result === 'draw' ? '1/2-1/2' : (this.result === 'win') === white ? '1-0' : '0-1'
    const text = this.moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m.san}` : m.san)).join(' ')
    return {
      id: `maia:${now}`,
      site: 'maia',
      url: '',
      pgn: `${text} ${score}`,
      color: this.opts.color,
      result: this.result!,
      rating: this.opts.rating,
      opponent: 'Maia',
      opponentRating: this.opts.level,
      speed: 'untimed',
      eco: '',
      opening: this.opts.start?.opening ?? '',
      playedAt: now,
      moves: this.moves.map(m => ({ ...m })),
      termination: this.ending.toLowerCase(),
    }
  }
}
