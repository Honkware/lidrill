import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import { Rating, type Grade } from 'ts-fsrs'
import type { Engine } from '../analysis/engine'
import type { OpeningCard } from '../db'
import { grade, judgeMove } from './cards'
import { LinePlay, type Resolved } from './line'
import { addOwnMove, keyOf, norm } from './repertoire'

// A set of due opening cards to review, played as lines from move 1 with
// no arrow: the moves before a due position play themselves, quickly, and
// each due position is asked with the retries and hint ladder of a learn
// line's practice. A playable other move can become the repertoire move
// instead. A missed position opened again from a summary is the same
// screen ungraded.

// One square per item of a set, as ui's dots draws them
export type Mark = 'good' | 'warn' | 'bad' | undefined

export const MARK: Record<number, Mark> = { [Rating.Good]: 'good', [Rating.Hard]: 'warn', [Rating.Again]: 'bad' }

// Moves that play themselves in review come quicker than in Learn, since
// the player has seen them before
const REVIEW_MS = 300

export const replay = (moves: string[]): Chess => {
  const pos = Chess.default()
  for (const m of moves) pos.play(parseUci(m)!)
  return pos
}

// "1. e4 e5 2. Nf3", for a card's moves
export function lineSan(moves: string[]): string {
  const pos = Chess.default()
  const parts: string[] = []
  for (const uci of moves) {
    if (pos.turn === 'white') parts.push(`${pos.fullmoves}.`)
    const move = parseUci(uci)!
    parts.push(makeSan(pos, move))
    pos.play(move)
  }
  return parts.join(' ')
}

// The moves with the one to find as "?": "1. e4 e5 2. ?"
export const lineAsk = (moves: string[]) => `${lineSan(moves)} ${moves.length % 2 ? '' : `${moves.length / 2 + 1}. `}?`.trim()

export interface ReviewLine {
  moves: string[]
  asks: string[] // the due positions on it, in order
}

// Due cards grouped into lines from move 1. The deepest card's moves and
// its repertoire move make a line, and every other due card whose position
// comes up on that line with its repertoire move played there is asked on
// it too. Lines come in the order of their first card in cards.
export function reviewLines(cards: OpeningCard[], rep: Map<string, string>): ReviewLine[] {
  const left = new Map(cards.map((c, i) => [c.id, i]))
  const out: (ReviewLine & { first: number })[] = []
  for (const c of [...cards].sort((a, b) => b.moves.length - a.moves.length)) {
    if (!left.has(c.id)) continue
    const moves = [...c.moves, rep.get(c.id)!]
    const asks: string[] = []
    const pos = Chess.default()
    for (const m of moves) {
      const k = keyOf(pos)
      if (left.has(k) && rep.get(k) === norm(pos, m)) asks.push(k)
      pos.play(parseUci(m)!)
    }
    out.push({ moves, asks, first: Math.min(...asks.map(k => left.get(k)!)) })
    for (const k of asks) left.delete(k)
  }
  return out.sort((a, b) => a.first - b.first).map(({ moves, asks }) => ({ moves, asks }))
}

export class OpeningSession {
  index = 0 // of the line on the board
  state: 'playing' | 'line-done' | 'done' = 'playing'
  added = false // the last playable move was made the repertoire move
  readonly grades = new Map<string, Grade>() // by card id
  readonly cards: OpeningCard[] // in the order they come up
  readonly lines: ReviewLine[]
  readonly graded: boolean
  readonly play: LinePlay
  private rep: Map<string, string>
  private redraw: () => void

  // Every card has a move in rep
  constructor(cards: OpeningCard[], rep: Map<string, string>, engine: Pick<Engine, 'search'>, redraw: () => void, graded = true) {
    this.rep = rep
    this.redraw = redraw
    this.graded = graded
    this.lines = reviewLines(cards, rep)
    const byId = new Map(cards.map(c => [c.id, c]))
    this.cards = this.lines.flatMap(l => l.asks.map(k => byId.get(k)!))
    this.play = new LinePlay({
      turn: pos => (this.line.asks.includes(keyOf(pos)) && !this.grades.has(keyOf(pos)) ? 'ask' : 'auto'),
      wait: REVIEW_MS,
      judge: (fen, uci, answer) => judgeMove(fen, uci, answer, engine),
      resolved: r => this.resolved(r),
      end: () => {
        this.state = 'line-done'
        redraw()
      },
      redraw,
    })
    if (!this.lines.length) this.state = 'done'
  }

  get line(): ReviewLine {
    return this.lines[this.index]
  }

  // The player's side in the line on the board
  get color(): 'white' | 'black' {
    return replay(this.cards.find(c => c.id === this.line.asks[0])!.moves).turn
  }

  get marks(): Mark[] {
    return this.cards.map(c => MARK[this.grades.get(c.id) ?? 0])
  }

  get progress(): number {
    return this.cards.length ? this.grades.size / this.cards.length : 1
  }

  // The cards missed, with their repertoire move
  get misses(): { id: string; moves: string[]; san: string }[] {
    return this.cards.flatMap(c => (this.grades.get(c.id) === Rating.Again ? [{ id: c.id, moves: c.moves, san: makeSan(replay(c.moves), parseUci(this.rep.get(c.id)!)!) }] : []))
  }

  mount(el: HTMLElement) {
    this.play.board.mount(el)
    this.begin()
  }

  begin() {
    if (this.lines.length) this.play.start(this.line.moves, this.color)
  }

  destroy() {
    this.play.destroy()
  }

  private async resolved(r: Resolved) {
    this.added = false
    const c = this.cards.find(x => x.id === r.key)!
    if (this.graded) await grade(c, r.grade)
    this.grades.set(r.key, r.grade)
  }

  // Makes the playable move just judged the repertoire move. The line on
  // the board goes on with the move it was built from.
  async add() {
    const last = this.play.last
    if (!last?.offer || this.added) return
    const c = this.cards.find(x => x.id === last.key)!
    await addOwnMove(makeFen(replay(c.moves).toSetup()), last.offer)
    this.rep.set(c.id, last.offer)
    this.added = true
    this.redraw()
  }

  nextLine() {
    if (this.state !== 'line-done') return
    if (this.index === this.lines.length - 1) {
      this.state = 'done'
      return this.redraw()
    }
    this.index++
    this.state = 'playing'
    this.play.start(this.line.moves, this.color)
  }
}
