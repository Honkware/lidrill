import { Chess } from 'chessops/chess'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import { Rating } from 'ts-fsrs'
import { db, type Opening } from '../db'
import { sound } from '../sound'
import { OpeningBoard, playMove } from './board'
import { grade, isLearned, learnCard } from './cards'
import { keyOf, norm, posKey, startsWith } from './repertoire'
import { variation, type Mark } from './session'
import type { TreeNode } from './tree'

// Learning an opening a line at a time, from move 1, the way a person
// learns one from a book. The player plays their side and the opponent's
// moves play themselves. A new position shows its move as an arrow, then
// asks for it again without one, and only that recall teaches it: its card
// gets a first grade and from then on comes back in review. A learned
// position on the way is asked without the arrow, so each line also goes
// over what came before. A day teaches up to NEW_PER_DAY new positions, in
// a set of lines.

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

// A set of lines: whole lines while their new positions fit in room, and
// the first line cut short after room new positions when it alone has
// more. fresh lists the set's new positions in the order they come up.
export function learnSet(opening: Opening, nodes: TreeNode[], learned: Set<string>, room: number): { lines: string[][]; fresh: string[] } {
  const answers = new Map(nodes.filter(n => n.answer).map(n => [posKey(n.fen), n.answer]))
  const known = new Set(learned)
  const lines: string[][] = []
  const fresh: string[] = []
  while (fresh.length < room) {
    let line = learnLine(opening, nodes, known)
    const here: [string, number][] = [] // a new position and the ply its move is at
    const pos = Chess.default()
    for (const [i, m] of line.entries()) {
      const k = keyOf(pos)
      if (answers.get(k) === m && !known.has(k) && !here.some(h => h[0] === k)) here.push([k, i])
      pos.play(parseUci(m)!)
    }
    // learnLine always ends on a new position; this keeps a tree it walks
    // differently from looping forever
    if (!here.length) break
    const left = room - fresh.length
    if (here.length > left) {
      if (lines.length) break
      line = line.slice(0, here[left - 1][1] + 1)
      here.length = left
    }
    lines.push(line)
    for (const [k] of here) {
      known.add(k)
      fresh.push(k)
    }
  }
  return { lines, fresh }
}

export class LearnRun {
  // show: the move's arrow is on the board; recall: the same position again
  // without it; your-move: a position already learned, or the opening's
  // own moves after the first line
  state: 'show' | 'recall' | 'your-move' | 'thinking' | 'line-done' | 'done' = 'thinking'
  missed = false // a wrong move at the position on the board
  result?: { ok: boolean; san: string } // the player's last move, or the right one after a miss
  name: string
  index = 0 // of the line on the board
  readonly marks: Mark[] // per new position: good when recalled first time
  readonly misses: { id: string; moves: string[]; san: string }[] = []
  readonly opening: Opening
  readonly lines: string[][]
  readonly fresh: string[]
  readonly board = new OpeningBoard(uci => void this.onUci(uci))
  private pos = Chess.default()
  private ply = 0
  private learned: Set<string>
  private first: boolean
  private redraw: () => void
  private timer?: ReturnType<typeof setTimeout>

  constructor(opening: Opening, set: { lines: string[][]; fresh: string[] }, learned: Set<string>, redraw: () => void) {
    this.opening = opening
    this.lines = set.lines
    this.fresh = set.fresh
    this.marks = set.fresh.map(() => undefined)
    this.learned = new Set(learned)
    this.redraw = redraw
    this.name = opening.name
    // The opening's own moves have no cards: they are shown on the first
    // line ever and asked on the rest
    this.first = learned.size === 0
    if (!this.lines.length) this.state = 'done'
  }

  get line(): string[] {
    return this.lines[this.index] ?? []
  }

  get played(): string[] {
    return this.line.slice(0, this.ply)
  }

  get taught(): number {
    return this.fresh.filter(k => this.learned.has(k)).length
  }

  get playing(): boolean {
    return this.state === 'show' || this.state === 'recall' || this.state === 'your-move'
  }

  // The new position's move while its arrow is up, for the panel
  get newSan(): string | undefined {
    return this.state === 'show' ? makeSan(this.pos, parseUci(this.line[this.ply])!) : undefined
  }

  private get teaching(): boolean {
    return this.ply < this.opening.moves.length ? this.first && this.index === 0 : this.fresh.includes(keyOf(this.pos)) && !this.learned.has(keyOf(this.pos))
  }

  mount(el: HTMLElement) {
    this.board.mount(el)
    if (this.lines.length) this.step()
  }

  destroy() {
    clearTimeout(this.timer)
    this.board.destroy()
  }

  nextLine() {
    if (this.state !== 'line-done') return
    this.index++
    this.pos = Chess.default()
    this.ply = 0
    this.result = undefined
    this.step()
  }

  private sync() {
    const hint = this.state === 'show' || (this.state === 'your-move' && this.missed)
    this.board.show(this.pos, this.opening.color, this.line[this.ply - 1], this.playing, hint ? [[this.line[this.ply], 'green']] : [])
  }

  private step() {
    this.missed = false
    if (this.ply >= this.line.length) this.state = this.index < this.lines.length - 1 ? 'line-done' : 'done'
    else if (this.pos.turn === this.opening.color) this.state = this.teaching ? 'show' : 'your-move'
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
    void this.nameNow()
    this.step()
  }

  private async nameNow() {
    const name = await variation(this.played)
    if (name) {
      this.name = name
      this.redraw()
    }
  }

  private miss(key: string, san: string) {
    this.missed = true
    this.result = { ok: false, san }
    if (!this.misses.some(m => m.id === key)) this.misses.push({ id: key, moves: this.played, san })
    sound.bad()
  }

  private async onUci(uci: string) {
    if (!this.playing) return
    const want = this.line[this.ply]
    const key = keyOf(this.pos)
    const san = makeSan(this.pos, parseUci(want)!)
    const at = this.fresh.indexOf(key)
    if (norm(this.pos, uci) !== want) {
      if (this.state === 'show') sound.bad()
      else if (this.state === 'recall') {
        this.marks[at] = 'bad'
        this.miss(key, san)
        this.state = 'show'
      } else {
        // A learned position missed here is due again
        const card = await db.openingCards.get(key)
        if (!this.missed && card && isLearned(card)) await grade(card, Rating.Again)
        this.miss(key, san)
      }
      this.sync()
      return this.redraw()
    }
    if (this.state === 'show' && at >= 0) {
      this.state = 'recall'
      this.result = undefined
      this.sync()
      return this.redraw()
    }
    if (this.state === 'recall') {
      const card = await db.openingCards.get(key)
      if (card && !isLearned(card)) await learnCard(card)
      this.learned.add(key)
      this.marks[at] ??= 'good'
    }
    this.result = { ok: !this.missed, san }
    this.play(want)
  }
}
