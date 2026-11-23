import { Chess } from 'chessops/chess'
import { Rating } from 'ts-fsrs'
import { db, type Opening } from '../db'
import { sound } from '../sound'
import { OpeningBoard, playMove } from './board'
import { grade, isLearned } from './cards'
import { keyOf, norm, posKey, startsWith } from './repertoire'
import type { TreeNode } from './tree'

// Learning an opening a line at a time, from move 1, the way a person
// learns one from a book. The player plays their side and the opponent's
// moves play themselves. A position the player hasn't learned shows its
// move as an arrow and a learned one is asked without it, so each line
// also goes over what came before. Playing a new position's move gives its
// card a first grade, and from then on it comes back in review.

// The opponent's move waits this long, so it can be seen landing
const OPPONENT_MS = 500

const same = (a: string[], b: string[]) => a.length === b.length && startsWith(a, b)

// The next line to learn: the opening's moves, then the repertoire move at
// the player's turns and, at the opponent's, the likeliest reply that still
// has a position to learn at or below it. It ends after the last new
// position along the way. Empty when nothing is left to learn.
export function learnLine(opening: Opening, nodes: TreeNode[], learned: Set<string>): string[] {
  const left = nodes.filter(n => n.answer && !learned.has(posKey(n.fen)))
  const ahead = (line: string[]) => left.some(n => startsWith(n.moves, line))
  if (!left.length) return []
  const line = [...opening.moves]
  for (;;) {
    const here = nodes.find(n => same(n.moves, line))
    if (here) {
      if (!here.answer || !ahead(line)) break
      line.push(here.answer)
      continue
    }
    const next = nodes.filter(n => n.moves.length === line.length + 1 && startsWith(n.moves, line) && ahead(n.moves)).sort((a, b) => b.reach - a.reach)[0]
    if (!next) break
    line.push(next.moves.at(-1)!)
  }
  return line
}

export class LearnRun {
  state: 'your-move' | 'thinking' | 'done' = 'thinking'
  missed = false // a wrong move at the position on the board
  taught = 0 // positions learned on this line
  name: string
  readonly opening: Opening
  readonly line: string[]
  readonly board = new OpeningBoard(uci => void this.onUci(uci))
  private pos = Chess.default()
  private ply = 0
  private learned: Set<string>
  private left: number
  private first: boolean
  private redraw: () => void
  private timer?: ReturnType<typeof setTimeout>

  // left is how many positions were still to learn before this line
  constructor(opening: Opening, line: string[], learned: Set<string>, left: number, redraw: () => void) {
    this.opening = opening
    this.line = line
    this.learned = learned
    this.left = left
    this.redraw = redraw
    this.name = opening.name
    // The opening's own moves have no cards: they are shown on the first
    // line and asked on the rest
    this.first = learned.size === 0
  }

  get played(): string[] {
    return this.line.slice(0, this.ply)
  }

  get more(): boolean {
    return this.left > this.taught
  }

  get isNew(): boolean {
    return this.ply < this.opening.moves.length ? this.first : !this.learned.has(keyOf(this.pos))
  }

  mount(el: HTMLElement) {
    this.board.mount(el)
    this.step()
  }

  destroy() {
    clearTimeout(this.timer)
    this.board.destroy()
  }

  private sync() {
    const hint = this.state === 'your-move' && (this.isNew || this.missed)
    this.board.show(this.pos, this.opening.color, this.line[this.ply - 1], this.state === 'your-move', hint ? [[this.line[this.ply], 'green']] : [])
  }

  private step() {
    if (this.ply >= this.line.length) this.state = 'done'
    else if (this.pos.turn === this.opening.color) this.state = 'your-move'
    else {
      this.state = 'thinking'
      this.timer = setTimeout(() => this.play(this.line[this.ply]), OPPONENT_MS)
    }
    this.sync()
    this.redraw()
  }

  private play(uci: string) {
    this.pos = this.pos.clone()
    playMove(this.pos, uci)
    this.ply++
    this.missed = false
    void this.nameNow()
    this.step()
  }

  // The explorer's name for the position, from the answers cached when its
  // move was recommended; a position with no name keeps the last one
  private async nameNow() {
    const name = (await db.explorer.get(this.played.join(',')))?.opening?.name
    if (name) {
      this.name = name
      this.redraw()
    }
  }

  private async onUci(uci: string) {
    if (this.state !== 'your-move') return
    const want = this.line[this.ply]
    const key = keyOf(this.pos)
    const card = await db.openingCards.get(key)
    if (norm(this.pos, uci) !== want) {
      // A learned position missed here is due again; a new one just waits
      if (!this.missed && card && isLearned(card)) await grade(card, Rating.Again)
      this.missed = true
      sound.bad()
      this.sync()
      this.redraw()
      return
    }
    if (card && !isLearned(card)) {
      await grade(card, Rating.Good)
      this.learned.add(key)
      this.taught++
    }
    this.play(want)
  }
}
