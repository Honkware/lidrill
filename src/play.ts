import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess, normalizeMove } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { makeUci, opposite, parseSquare, parseUci } from 'chessops/util'
import type { Color } from 'chessops/types'
import { checkColor } from './checkColor'
import type { Game, Result } from './db'
import { stepKey } from './gameview'
import { fetchMove, type Start } from './maia'
import { landSound, sound } from './sound'

// A whole game against Maia-3, from move 1 or from a position out of one of
// the player's own games. There are no hints and no take-backs: the finished
// game is stored like an imported one, and the analysis that turns mistakes
// into puzzles is where the feedback comes from.

export type PlayState = 'thinking' | 'your-move' | 'failed' | 'over'
export type Pace = 'human' | 'instant'

export interface PlayOptions {
  level: number
  color: 'white' | 'black'
  rating: number // the player's estimate going in, stored on the game
  start?: Start
  clock?: { base: number; inc: number } // seconds; none is an untimed game
  pace: Pace // human waits as long as Maia says a person would have taken
}

// What the Play Maia card was last set to, kept per browser
export interface Choices {
  time: string
  color: 'white' | 'black' | 'random'
  pace: Pace
}

export const TIMES = ['3+2', '5+0', '5+3', '10+0', '10+5', '15+10', 'unlimited']
const DEFAULT_CHOICES: Choices = { time: '10+0', color: 'random', pace: 'human' }
const CHOICES_KEY = 'lidrill.maiaChoices'

// Storage can be off (private mode), which just means the defaults
export function readChoices(): Choices {
  try {
    return { ...DEFAULT_CHOICES, ...(JSON.parse(localStorage.getItem(CHOICES_KEY) ?? '{}') as Partial<Choices>) }
  } catch {
    return { ...DEFAULT_CHOICES }
  }
}

export function writeChoices(c: Choices) {
  try {
    localStorage.setItem(CHOICES_KEY, JSON.stringify(c))
  } catch {
    // not saved; fine
  }
}

// The game in progress, rebuilt after a reload. left is each side's
// milliseconds at the time of the save, `at` that time by the wall clock.
export interface SavedGame {
  opts: PlayOptions
  moves: { san: string; uci: string }[]
  left: { white: number; black: number }
  clocks: number[]
  at: number
}

const GAME_KEY = 'lidrill.maiaGame'

// A game saved by an older version or damaged in storage would break
// halfway through rebuilding the board, and there is nothing in it worth
// recovering by hand, so it is dropped and the next game starts fresh
export function readGame(): SavedGame | undefined {
  try {
    const g = JSON.parse(localStorage.getItem(GAME_KEY) ?? 'null') as SavedGame | null
    if (!g) return undefined
    if (!Number.isFinite(g.at + g.left.white + g.left.black + g.opts.level) || !['white', 'black'].includes(g.opts.color) || !Array.isArray(g.clocks)) throw new Error('old shape')
    const pos = Chess.default()
    for (const m of g.moves) {
      const move = parseUci(m.uci)
      if (!move || !pos.isLegal(move)) throw new Error('bad move')
      pos.play(move)
    }
    return g
  } catch {
    clearGame()
    return undefined
  }
}

function writeGame(g: SavedGame) {
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(g))
  } catch {
    // storage off; the game only lasts as long as the page
  }
}

export function clearGame() {
  try {
    localStorage.removeItem(GAME_KEY)
  } catch {
    // nothing was saved either
  }
}

// '5+3' is 5 minutes and 3 seconds a move
export function clockOf(time: string): PlayOptions['clock'] {
  if (time === 'unlimited') return undefined
  const [min, inc] = time.split('+').map(Number)
  return { base: min * 60, inc }
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
  // The position on the board: the live one unless the player has stepped
  // back, and then the board is read-only
  viewPly = 0
  private fens: string[] = []
  private checks: (Color | false)[] = []
  private pos = Chess.default()
  private seen = new Map<string, number>()
  private cg?: Api
  private redraw: () => void
  private onEnd: (run: PlayRun) => void
  private fetchFn: typeof fetch
  private now: () => number
  private gone = false
  // Milliseconds on each clock, not counting the one running since `since`.
  // Nothing runs before both first moves, while a failed request waits for
  // a retry, or once the game is over.
  private left = { white: 0, black: 0 }
  private since?: number
  private clocks: number[] // centiseconds left after each move
  private timer?: ReturnType<typeof setInterval>
  private onKey = (e: KeyboardEvent) => {
    const to = stepKey(e, this.viewPly, this.moves.length)
    if (to === undefined) return
    e.preventDefault()
    this.go(to)
  }

  // `from` is a saved game to carry on with instead of starting a new one
  constructor(opts: PlayOptions, redraw: () => void, onEnd: (run: PlayRun) => void, fetchFn: typeof fetch = fetch, now = Date.now, from?: SavedGame) {
    this.opts = opts
    this.redraw = redraw
    this.onEnd = onEnd
    this.fetchFn = fetchFn
    this.now = now
    this.moves = [...(from?.moves ?? opts.start?.moves ?? [])]
    this.clocks = [...(from?.clocks ?? [])]
    this.count()
    for (const m of this.moves) {
      this.pos.play(parseUci(m.uci)!)
      this.count()
    }
    this.viewPly = this.moves.length
    if (opts.clock) {
      this.left = from ? { ...from.left } : { white: opts.clock.base * 1000, black: opts.clock.base * 1000 }
      this.resume()
      // The clock ran on while the page was away, as on Lichess
      if (from && this.since !== undefined) this.since = from.at
      this.timer = setInterval(() => this.tick(), 100)
    }
    this.save()
    if (this.flag()) return
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
    window.addEventListener('keydown', this.onKey)
    this.sync()
  }

  destroy() {
    this.gone = true
    clearInterval(this.timer)
    window.removeEventListener('keydown', this.onKey)
    this.cg?.destroy()
  }

  // Milliseconds left, counting the clock that is running
  clock(color: Color): number {
    const ran = this.since !== undefined && this.pos.turn === color ? this.now() - this.since : 0
    return Math.max(0, this.left[color] - ran)
  }

  get running(): Color | undefined {
    return this.since === undefined ? undefined : this.pos.turn
  }

  // In a game from move 1 the clocks start once both sides have moved, as
  // on Lichess. From an own game they run from the start.
  private resume() {
    if (this.opts.clock && (this.opts.start || this.moves.length >= 2)) this.since = this.now()
  }

  private save() {
    writeGame({ opts: this.opts, moves: this.moves, left: { white: this.clock('white'), black: this.clock('black') }, clocks: this.clocks, at: this.now() })
  }

  private stop() {
    if (this.since === undefined) return
    this.left[this.pos.turn] -= this.now() - this.since
    this.since = undefined
  }

  private tick() {
    if (this.since !== undefined && !this.flag()) this.redraw()
  }

  // Ends the game when the side to move is out of time. It is a draw when
  // the other side has too little left to mate, as on Lichess.
  private flag(): boolean {
    const side = this.pos.turn
    if (this.since === undefined || this.clock(side) > 0) return false
    this.end(this.pos.hasInsufficientMaterial(opposite(side)) ? 'draw' : side === this.opts.color ? 'loss' : 'win', 'Time out')
    return true
  }

  get live() {
    return this.viewPly === this.moves.length
  }

  go(ply: number) {
    this.viewPly = Math.max(0, Math.min(this.moves.length, ply))
    this.sync()
    this.redraw()
  }

  // Counts the position for repetition and keeps it for stepping back
  private count() {
    const key = positionKey(this.pos)
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1)
    this.fens.push(makeFen(this.pos.toSetup()))
    this.checks.push(checkColor(this.pos))
  }

  private sync() {
    const ply = this.viewPly
    const last = this.moves[ply - 1]?.uci
    const mine = this.state === 'your-move' && this.live
    this.cg?.set({
      fen: this.fens[ply],
      turnColor: ply % 2 === 0 ? 'white' : 'black',
      check: this.checks[ply],
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
    const timed = this.since !== undefined
    this.stop()
    if (timed) this.left[mover] += this.opts.clock!.inc * 1000
    this.clocks.push(Math.round(this.left[mover] / 10))
    this.moves.push({ san: makeSan(this.pos, move), uci: makeUci(move) })
    this.pos.play(move)
    this.count()
    // Either side's move brings a player who stepped back to the live board
    this.viewPly = this.moves.length
    sound[landSound(capture, this.pos.isCheck())]()
    if (this.pos.isCheckmate()) return this.end(mover === this.opts.color ? 'win' : 'loss', 'Checkmate'), false
    if (drawn(this.pos, this.seen)) return this.end('draw', this.pos.isStalemate() ? 'Stalemate' : 'Draw'), false
    this.resume()
    this.save()
    return true
  }

  // The player's move, as the board reports it
  async move(uci: string) {
    if (this.state !== 'your-move' || !this.live || this.flag()) return
    if (!this.push(uci)) return
    await this.reply()
  }

  private async reply() {
    this.state = 'thinking'
    this.error = undefined
    this.sync()
    this.redraw()
    const c = this.opts.clock
    const clock = c && { ...c, left: Math.round(this.clock(opposite(this.opts.color)) / 100) / 10 }
    const asked = this.now()
    try {
      const { move: uci, think } = await fetchMove(this.moves.map(m => m.uci), this.opts.level, clock, this.fetchFn)
      // Human pace shows the move once the time a person would have taken
      // has passed, counting the time the request took
      const wait = this.opts.pace === 'human' ? think * 1000 - (this.now() - asked) : 0
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      if (this.gone || this.state !== 'thinking' || this.flag()) return
      const before = this.moves.length
      if (!this.push(uci)) return
      this.last = this.moves[before].san
      this.state = 'your-move'
    } catch (e) {
      if (this.state !== 'thinking') return
      // Waiting for a retry isn't Maia thinking, so neither clock runs
      this.stop()
      this.state = 'failed'
      this.error = (e as Error).message
    }
    this.sync()
    this.redraw()
  }

  retry() {
    if (this.state !== 'failed') return
    this.resume()
    void this.reply()
  }

  resign() {
    if (this.state !== 'over') this.end('loss', 'Resigned')
  }

  private end(result: Result, ending: string) {
    this.stop()
    clearGame()
    clearInterval(this.timer)
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
    const c = this.opts.clock
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
      // Never a Lichess speed name, which would count it toward the band
      speed: c ? `${c.base / 60}+${c.inc}` : 'untimed',
      eco: '',
      opening: this.opts.start?.opening ?? '',
      playedAt: now,
      moves: this.moves.map(m => ({ ...m })),
      termination: this.ending.toLowerCase(),
      clocks: c && !this.opts.start ? [...this.clocks] : undefined,
    }
  }
}
