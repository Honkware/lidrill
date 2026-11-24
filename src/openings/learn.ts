import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import { Rating } from 'ts-fsrs'
import { db, type Opening } from '../db'
import { grade, isLearned, learnCard } from './cards'
import { LinePlay, type Resolved } from './line'
import { keyOf, openingArg, posKey, startsWith } from './repertoire'
import { MARK, type Mark } from './session'
import type { TreeNode } from './tree'

// Learning an opening a line at a time, from move 1, the way a person
// learns one from a book. The player plays their side with each move shown
// as an arrow, and the opponent's moves play themselves. Then the same line
// is practised from move 1 with no arrows, with retries and the hint
// ladder, and only that practice run teaches a new position: how its move
// was found is its card's first grade, and from then on it comes back in
// review. A learned position on the way that needed its move shown is due
// again. A day teaches up to NEW_PER_DAY new positions, in a set of lines.

// The opponent's move waits this long, so it can be seen landing
const OPPONENT_MS = 500

// A set the player left before its end, kept for the day so opening Learn
// again goes on with the same lines at the same place. The positions
// already practised are learned in the database either way; this keeps the
// rest of the set and whether the line on the board had been shown.
const SAVED_KEY = 'lidrill.learn'

export interface SavedLearn {
  opening: string // 'white:Italian Game'
  day: string
  lines: string[][]
  fresh: string[]
  marks: Mark[]
  index: number
  shown: boolean // the line at index has had its pass with arrows
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/

export function readLearn(opening: string, day = new Date().toDateString()): SavedLearn | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED_KEY) ?? 'null') as SavedLearn | null
    if (!s || s.opening !== opening || s.day !== day) return undefined
    if (!Array.isArray(s.fresh) || !Array.isArray(s.marks) || !s.lines.every(l => l.every(m => UCI.test(m))) || !s.lines[s.index]) throw new Error('old shape')
    return s
  } catch {
    clearLearn()
    return undefined
  }
}

export function clearLearn() {
  try {
    localStorage.removeItem(SAVED_KEY)
  } catch {
    // storage is off: there was nothing saved
  }
}

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
  // playing: a pass over the line is on the board; shown: the line has
  // been played with arrows and its practice run is next
  state: 'playing' | 'shown' | 'line-done' | 'done' = 'playing'
  pass: 'show' | 'practice' = 'show'
  index = 0 // of the line on the board
  readonly marks: Mark[] // per new position, from its practice run
  readonly misses: { id: string; moves: string[]; san: string }[] = []
  readonly opening: Opening
  readonly lines: string[][]
  readonly fresh: string[]
  readonly play: LinePlay
  private learned: Set<string>
  private redraw: () => void

  constructor(opening: Opening, set: { lines: string[][]; fresh: string[] }, learned: Set<string>, redraw: () => void, saved?: SavedLearn) {
    this.opening = opening
    this.lines = set.lines
    this.fresh = set.fresh
    this.marks = saved?.marks ?? set.fresh.map(() => undefined)
    // A line already shown goes on at its practice run
    this.index = saved?.index ?? 0
    if (saved?.shown) this.pass = 'practice'
    this.learned = new Set(learned)
    this.redraw = redraw
    this.play = new LinePlay({
      turn: () => (this.pass === 'show' ? 'show' : 'ask'),
      wait: OPPONENT_MS,
      resolved: r => this.resolved(r),
      end: () => this.ended(),
      redraw,
    })
    if (!this.lines.length) this.state = 'done'
  }

  get line(): string[] {
    return this.lines[this.index] ?? []
  }

  get taught(): number {
    return this.fresh.filter(k => this.learned.has(k)).length
  }

  // Is the position on the board new in this set?
  get isNew(): boolean {
    const pos = Chess.default()
    for (const m of this.play.played) pos.play(parseUci(m)!)
    return this.fresh.includes(keyOf(pos)) && !this.learned.has(keyOf(pos))
  }

  // Share of the set done: each line is played twice
  get progress(): number {
    if (this.state === 'done') return 1
    const pass = this.state === 'playing' ? (this.pass === 'practice' ? 1 : 0) + this.play.ply / this.line.length : this.state === 'shown' ? 1 : 2
    return (this.index * 2 + pass) / (this.lines.length * 2)
  }

  mount(el: HTMLElement) {
    this.play.board.mount(el)
    this.begin()
  }

  begin() {
    if (this.lines.length) this.play.start(this.line, this.opening.color)
  }

  destroy() {
    this.play.destroy()
  }

  practise() {
    if (this.state !== 'shown') return
    this.pass = 'practice'
    this.state = 'playing'
    this.play.start(this.line, this.opening.color)
  }

  nextLine() {
    if (this.state !== 'line-done') return
    if (this.index === this.lines.length - 1) {
      this.state = 'done'
      this.save()
      return this.redraw()
    }
    this.index++
    this.pass = 'show'
    this.state = 'playing'
    this.save()
    this.play.start(this.line, this.opening.color)
  }

  private save() {
    try {
      // A line practised to its end is behind the player: the next one is saved
      const over = this.state === 'line-done'
      const index = this.index + (over ? 1 : 0)
      if (this.state === 'done' || index >= this.lines.length) return clearLearn()
      const s: SavedLearn = { opening: openingArg(this.opening), day: new Date().toDateString(), lines: this.lines, fresh: this.fresh, marks: this.marks, index, shown: !over && (this.pass === 'practice' || this.state === 'shown') }
      localStorage.setItem(SAVED_KEY, JSON.stringify(s))
    } catch {
      // storage is full or off: the set just isn't resumable
    }
  }

  private ended() {
    this.state = this.pass === 'show' ? 'shown' : 'line-done'
    this.save()
    this.redraw()
  }

  private async resolved(r: Resolved) {
    const card = await db.openingCards.get(r.key)
    const at = this.fresh.indexOf(r.key)
    if (at >= 0 && !this.learned.has(r.key)) {
      if (card && !isLearned(card)) await learnCard(card, new Date(), r.grade)
      this.learned.add(r.key)
      this.marks[at] = MARK[r.grade]
      this.save()
    } else if (r.grade === Rating.Again && card && isLearned(card)) await grade(card, Rating.Again)
    if (r.grade === Rating.Again && card && !this.misses.some(m => m.id === r.key)) this.misses.push({ id: r.key, moves: r.moves, san: r.san })
  }
}
