import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import { Rating, type Card } from 'ts-fsrs'
import type { Engine } from '../analysis/engine'
import { db, type Opening, type OpeningCard } from '../db'
import { pawns } from '../format'
import { OpeningBoard, playMove } from './board'
import { grade, isLearned } from './cards'
import type { Policy, Reply } from './policy'
import { keyOf, norm, posKey, startsWith } from './repertoire'
import { kept, pastDepth } from './tree'

// Sparring: the player plays an opening from move 1 against Maia, which
// plays the opening's own moves first and then replies the way people at the
// player's level do, leaning towards the positions the player knows least.
// It stops after the player's DEPTH-th move.

// An unknown position's reply counts up to 4 times its Maia probability:
// enough that a weak spot comes up most sparring games, not so much that a
// 5% reply crowds out one played half the time
export const SPAR_PULL = 3

// 1 for a position never reviewed, falling as FSRS stability (days) grows
export const weakness = (c?: Card) => (!c || c.reps === 0 ? 1 : 1 / (1 + c.stability))

// Never a reply under the tree's cut, so the opponent stays one a person
// at that level could be
export function pickReply(replies: Reply[], weak: (uci: string) => number, rng: () => number = Math.random): string {
  const pool = kept(replies).length ? kept(replies) : replies.slice(0, 1)
  const w = pool.map(r => r.p * (1 + SPAR_PULL * weak(r.uci)))
  let x = rng() * w.reduce((a, b) => a + b, 0)
  for (const [i, r] of pool.entries()) if ((x -= w[i]) < 0) return r.uci
  return pool.at(-1)!.uci
}

export interface SparStep {
  fen: string
  moves: string[]
  san: string // what the player played
  known: boolean
  answer?: string // SAN of the repertoire move, when there was one and it wasn't played
}

export class SparRun {
  state: 'your-move' | 'thinking' | 'done' = 'thinking'
  // The player's moves up to the first position they didn't know, which is
  // the one that becomes a card; after it the game is off their repertoire
  steps: SparStep[] = []
  evalText?: string
  error?: string
  readonly opening: Opening
  readonly board = new OpeningBoard(uci => void this.onUci(uci))
  private pos = Chess.default()
  private moves: string[] = []
  private rep: Map<string, string>
  private cards: Map<string, OpeningCard>
  private policy: Policy
  private engine: Pick<Engine, 'search'>
  private redraw: () => void
  private rng: () => number

  constructor(opening: Opening, rep: Map<string, string>, cards: OpeningCard[], policy: Policy, engine: Pick<Engine, 'search'>, redraw: () => void, rng: () => number = Math.random) {
    this.opening = opening
    this.rep = rep
    this.cards = new Map(cards.map(c => [c.id, c]))
    this.policy = policy
    this.engine = engine
    this.redraw = redraw
    this.rng = rng
    if (opening.color === 'white') this.state = 'your-move'
  }

  get line(): string[] {
    return this.moves
  }

  get offRepertoire(): boolean {
    return this.steps.some(s => !s.known)
  }

  mount(el: HTMLElement) {
    this.board.mount(el)
    this.sync()
    if (this.opening.color === 'black') void this.reply()
  }

  destroy() {
    this.board.destroy()
  }

  private sync() {
    this.board.show(this.pos, this.opening.color, this.moves.at(-1), this.state === 'your-move')
  }

  private async onUci(uci: string) {
    if (this.state !== 'your-move') return
    const u = norm(this.pos, uci)
    if (!this.offRepertoire) {
      const answer = this.rep.get(keyOf(this.pos))
      const before = this.pos
      this.steps.push({
        fen: makeFen(before.toSetup()),
        moves: [...this.moves],
        san: makeSan(before, parseUci(u)!),
        known: answer === u,
        answer: answer && answer !== u ? makeSan(before, parseUci(answer)!) : undefined,
      })
    }
    this.pos = this.pos.clone()
    playMove(this.pos, u)
    this.moves.push(u)
    if (this.pos.isEnd() || pastDepth(this.pos)) return this.finish()
    await this.reply()
  }

  async reply() {
    this.state = 'thinking'
    this.sync()
    this.redraw()
    let uci: string
    if (this.moves.length < this.opening.moves.length && startsWith(this.opening.moves, this.moves)) uci = this.opening.moves[this.moves.length]
    else {
      try {
        const replies = await this.policy(this.moves)
        uci = pickReply(replies, r => weakness(this.cards.get(keyAfter(this.pos, r))?.card), this.rng)
      } catch (e) {
        this.error = (e as Error).message
        return this.finish()
      }
    }
    this.pos = this.pos.clone()
    playMove(this.pos, uci)
    this.moves.push(uci)
    if (this.pos.isEnd()) return this.finish()
    this.state = 'your-move'
    this.sync()
    this.redraw()
  }

  // The first position the player didn't know is due for review again when
  // it was learned; one not learned yet is still in its learn line
  private async finish() {
    this.state = 'done'
    this.sync()
    this.redraw()
    const miss = this.steps.find(s => !s.known)
    const old = miss && (await db.openingCards.get(posKey(miss.fen)))
    if (old && miss.answer && isLearned(old)) await grade(old, Rating.Again)
    if (!this.pos.isEnd()) {
      const r = await this.engine.search(makeFen(this.pos.toSetup()), 14)
      const cp = r.eval.mate !== undefined ? (r.eval.mate > 0 ? 10000 : -10000) : (r.eval.cp ?? 0)
      const mine = this.pos.turn === this.opening.color ? cp : -cp
      this.evalText = r.eval.mate !== undefined ? `Mate in ${Math.abs(r.eval.mate)} for ${mine > 0 ? 'you' : 'Maia'}` : pawns(mine)
    }
    this.redraw()
  }
}

const keyAfter = (pos: Chess, uci: string) => {
  const next = pos.clone()
  next.play(parseUci(uci)!)
  return keyOf(next)
}
