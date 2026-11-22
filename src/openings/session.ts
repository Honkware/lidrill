import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import type { Grade } from 'ts-fsrs'
import type { Engine } from '../analysis/engine'
import type { OpeningCard } from '../db'
import { OpeningBoard, playMove } from './board'
import { grade, judgeMove, type Verdict } from './cards'
import { addOwnMove, norm } from './repertoire'

// A set of opening cards, one move each: the move is judged, the card
// graded, and a good answer to a gap can be added to the repertoire.

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

export class OpeningSession {
  index = 0
  state: 'your-move' | 'judging' | 'judged' = 'your-move'
  verdict?: Verdict
  added = false
  grades: Grade[] = []
  readonly cards: OpeningCard[]
  readonly board = new OpeningBoard(uci => void this.onUci(uci))
  private rep: Map<string, string>
  private engine: Pick<Engine, 'search'>
  private redraw: () => void

  constructor(cards: OpeningCard[], rep: Map<string, string>, engine: Pick<Engine, 'search'>, redraw: () => void) {
    this.cards = cards
    this.rep = rep
    this.engine = engine
    this.redraw = redraw
  }

  get card(): OpeningCard | undefined {
    return this.cards[this.index]
  }

  // Asked before the move, so the screen can say which kind it is
  get recall(): boolean {
    return !!this.card && this.rep.has(this.card.id)
  }

  get offerSan(): string | undefined {
    const offer = this.verdict?.offer
    return offer && this.card ? makeSan(replay(this.card.moves), parseUci(offer)!) : undefined
  }

  mount(el: HTMLElement) {
    this.board.mount(el)
    this.show()
  }

  private show(played?: string) {
    const c = this.card
    if (!c) return
    const pos = replay(c.moves)
    const color = pos.turn
    if (played) playMove(pos, played)
    this.board.show(pos, color, played ?? c.moves.at(-1), this.state === 'your-move')
  }

  private async onUci(uci: string) {
    const c = this.card
    if (!c || this.state !== 'your-move') return
    const pos = replay(c.moves)
    const played = norm(pos, uci)
    this.state = 'judging'
    this.show(played)
    this.redraw()
    this.verdict = await judgeMove(makeFen(pos.toSetup()), played, this.rep.get(c.id), this.engine)
    await grade(c, this.verdict.rating)
    this.grades.push(this.verdict.rating)
    this.state = 'judged'
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
    this.added = false
    this.show()
    this.redraw()
  }
}
