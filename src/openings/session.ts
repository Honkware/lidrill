import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import { Rating, type Grade } from 'ts-fsrs'
import type { Engine } from '../analysis/engine'
import { db, type OpeningCard } from '../db'
import { sound } from '../sound'
import { OpeningBoard, playMove } from './board'
import { grade, judgeMove, type Verdict } from './cards'
import { addOwnMove, norm } from './repertoire'

// A set of opening cards to review, one move each, with no arrow. A wrong
// move shows the repertoire move and has the player play it; a playable
// other move can become the repertoire move instead. A missed position
// opened again from a summary is the same screen ungraded.

// One square per item of a set, as ui's dots draws them
export type Mark = 'good' | 'warn' | 'bad' | undefined

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

// The explorer's name for the deepest position along moves that has one,
// from the answers cached when recommended moves were looked up
export async function variation(moves: string[]): Promise<string | undefined> {
  for (let i = moves.length; i > 0; i--) {
    const name = (await db.explorer.get(moves.slice(0, i).join(',')))?.opening?.name
    if (name) return name
  }
}

const MARK: Record<number, Mark> = { [Rating.Good]: 'good', [Rating.Hard]: 'warn', [Rating.Again]: 'bad' }

export class OpeningSession {
  index = 0
  state: 'your-move' | 'judging' | 'fix' | 'judged' = 'your-move'
  verdict?: Verdict
  added = false
  grades: Grade[] = []
  name?: string // of the card's variation
  readonly cards: OpeningCard[]
  readonly graded: boolean
  readonly board = new OpeningBoard(uci => void this.onUci(uci))
  played?: string
  private rep: Map<string, string>
  private engine: Pick<Engine, 'search'>
  private redraw: () => void

  // Every card has a move in rep
  constructor(cards: OpeningCard[], rep: Map<string, string>, engine: Pick<Engine, 'search'>, redraw: () => void, graded = true) {
    this.cards = cards
    this.rep = rep
    this.engine = engine
    this.redraw = redraw
    this.graded = graded
  }

  get marks(): Mark[] {
    return this.cards.map((_, i) => MARK[this.grades[i]])
  }

  // The cards missed, with their repertoire move
  get misses(): { id: string; moves: string[]; san: string }[] {
    return this.cards.flatMap((c, i) => (this.grades[i] === Rating.Again ? [{ id: c.id, moves: c.moves, san: makeSan(replay(c.moves), parseUci(this.rep.get(c.id)!)!) }] : []))
  }

  get card(): OpeningCard | undefined {
    return this.cards[this.index]
  }

  private get answer(): string {
    return this.rep.get(this.card!.id)!
  }

  get answerSan(): string | undefined {
    return this.card && makeSan(replay(this.card.moves), parseUci(this.answer)!)
  }

  get offerSan(): string | undefined {
    const offer = this.verdict?.offer
    return offer && this.card ? makeSan(replay(this.card.moves), parseUci(offer)!) : undefined
  }

  mount(el: HTMLElement) {
    this.board.mount(el)
    this.show()
    void this.nameNow()
  }

  private async nameNow() {
    const c = this.card
    this.name = undefined
    if (!c) return
    const name = await variation(c.moves)
    if (c === this.card) {
      this.name = name
      this.redraw()
    }
  }

  // A playable other move is shown beside the repertoire move, on the
  // position it was played from
  private show() {
    const c = this.card
    if (!c) return
    const pos = replay(c.moves)
    const color = pos.turn
    if (this.state === 'fix') return this.board.show(pos, color, c.moves.at(-1), true, [[this.answer, 'green']])
    if (this.state === 'judged' && this.verdict?.offer) return this.board.show(pos, color, c.moves.at(-1), false, [[this.answer, 'green'], [this.verdict.offer, 'yellow']])
    if (this.played) playMove(pos, this.played)
    this.board.show(pos, color, this.played ?? c.moves.at(-1), this.state === 'your-move')
  }

  private async onUci(uci: string) {
    const c = this.card
    if (!c) return
    const pos = replay(c.moves)
    const played = norm(pos, uci)
    if (this.state === 'fix') {
      if (played === this.answer) {
        this.played = played
        this.state = 'judged'
      } else sound.bad()
      this.show()
      return this.redraw()
    }
    if (this.state !== 'your-move') return
    this.played = played
    this.state = 'judging'
    this.show()
    this.redraw()
    this.verdict = await judgeMove(makeFen(pos.toSetup()), played, this.answer, this.engine)
    if (this.graded) await grade(c, this.verdict.rating)
    this.grades.push(this.verdict.rating)
    if (this.verdict.rating === Rating.Again) {
      this.played = undefined
      this.state = 'fix'
      sound.bad()
    } else this.state = 'judged'
    this.show()
    this.redraw()
  }

  async add() {
    const c = this.card
    const offer = this.verdict?.offer
    if (!c || !offer || this.added) return
    await addOwnMove(makeFen(replay(c.moves).toSetup()), offer)
    this.rep.set(c.id, offer)
    this.added = true
    this.redraw()
  }

  next() {
    this.index++
    this.state = 'your-move'
    this.verdict = undefined
    this.played = undefined
    this.added = false
    this.show()
    this.redraw()
    void this.nameNow()
  }
}
