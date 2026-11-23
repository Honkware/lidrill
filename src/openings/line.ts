import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import { Rating, type Grade } from 'ts-fsrs'
import { db } from '../db'
import { sound } from '../sound'
import { OpeningBoard, playMove } from './board'
import type { Verdict } from './cards'
import { lineNotes } from './notes'
import { keyOf, norm } from './repertoire'

// One line played from move 1, shared by Learn, its practice run and
// Review. The opponent's moves play themselves; at each of the player's
// turns the caller says whether the move is shown with an arrow, asked
// without one, or played for them. An asked move is never failed outright:
// a wrong move snaps back and the player tries again, and from the second
// wrong try a hint ladder is offered (the piece to move, then the arrow,
// then the move played out) beside Skip. The grade follows how the move was
// found.

export const FIRST_TRY: Grade = Rating.Good
// Found after a wrong try or with the piece marked
export const HELPED: Grade = Rating.Hard
// Found with the arrow or after the solution was played out
export const SHOWN: Grade = Rating.Again
export const SKIPPED: Grade = Rating.Again
// Wrong tries before the hint is offered
export const HINT_AFTER = 2
// How long a solution stays on the board before it is taken back to be played
const SOLUTION_MS = 800

export type Turn = 'ask' | 'show' | 'auto'

// An asked move once it has been played
export interface Resolved {
  key: string // of the position it was asked in
  moves: string[] // to that position
  san: string
  grade: Grade
  skipped?: boolean
  offer?: string // a playable other move the player made, judged Hard
}

export interface LineOpts {
  turn: (pos: Chess) => Turn // at the player's turns
  wait: number // ms before a move that plays itself
  judge?: (fen: string, uci: string, answer: string) => Promise<Verdict>
  resolved: (r: Resolved) => Promise<void> | void
  end: () => void
  redraw: () => void
}

export interface NoteRow {
  move: string // "3. Bc4" or "3... Bc5"
  text?: string
  name?: string // the explorer's name, where this move changes it
}

// Rows shown under the moves, the newest last
const NOTES_SHOWN = 4

// The explorer's name at each move that changes it, from the answers cached
// when recommended moves were looked up
async function lineNames(line: string[]): Promise<(string | undefined)[]> {
  const found = await db.explorer.bulkGet(line.map((_, i) => line.slice(0, i + 1).join(',')))
  let now: string | undefined
  return found.map(e => {
    const n = e?.opening?.name
    if (!n || n === now) return undefined
    return (now = n)
  })
}

export class LinePlay {
  // auto: a move is about to play itself; offer: a playable other move was
  // judged, and waits for the player to go on
  state: 'auto' | 'your-move' | 'judging' | 'solution' | 'offer' | 'end' = 'end'
  line: string[] = []
  ply = 0
  color: 'white' | 'black' = 'white'
  turn: Turn = 'auto'
  wrong = 0 // at the position on the board
  help = 0 // 1 the piece to move, 2 the arrow, 3 the solution played out
  tried?: string // SAN of the last wrong move there
  last?: Resolved
  streak = 0 // asked moves found on the first try in a row
  readonly board = new OpeningBoard(uci => void this.move(uci))
  private pos = Chess.default()
  private sans: string[] = []
  private notes: (string | undefined)[] = []
  private names: (string | undefined)[] = []
  private timer?: ReturnType<typeof setTimeout>
  private o: LineOpts

  constructor(o: LineOpts) {
    this.o = o
  }

  get grade(): Grade {
    return this.help >= 2 ? SHOWN : this.wrong || this.help ? HELPED : FIRST_TRY
  }

  get asking(): boolean {
    return this.state === 'your-move' && this.turn === 'ask'
  }

  // The hint ladder and Skip, from the HINT_AFTER-th wrong try
  get offered(): boolean {
    return this.asking && (this.wrong >= HINT_AFTER || this.help > 0)
  }

  get canHelp(): boolean {
    return this.offered && this.help < 3
  }

  get played(): string[] {
    return this.line.slice(0, this.ply)
  }

  get answerSan(): string | undefined {
    return this.sans[this.ply]
  }

  // The explorer's name for the deepest position played that has one
  get name(): string | undefined {
    return this.names.slice(0, this.ply).findLast(n => n)
  }

  get noteRows(): NoteRow[] {
    const rows: NoteRow[] = []
    for (let i = 0; i < this.ply; i++)
      if (this.notes[i] || this.names[i]) rows.push({ move: `${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'} ${this.sans[i]}`, text: this.notes[i], name: this.names[i] })
    return rows.slice(-NOTES_SHOWN)
  }

  start(line: string[], color: 'white' | 'black') {
    clearTimeout(this.timer)
    this.line = line
    this.color = color
    this.pos = Chess.default()
    this.ply = 0
    this.last = undefined
    this.notes = lineNotes(line)
    this.names = []
    const p = Chess.default()
    this.sans = line.map(m => {
      const san = makeSan(p, parseUci(m)!)
      p.play(parseUci(m)!)
      return san
    })
    void lineNames(line).then(names => {
      if (line !== this.line) return
      this.names = names
      this.o.redraw()
    })
    this.step()
  }

  destroy() {
    clearTimeout(this.timer)
    this.board.destroy()
  }

  private step() {
    this.wrong = 0
    this.help = 0
    this.tried = undefined
    if (this.ply >= this.line.length) {
      this.state = 'end'
      this.sync()
      return this.o.end()
    }
    this.turn = this.pos.turn === this.color ? this.o.turn(this.pos) : 'auto'
    this.state = this.turn === 'auto' ? 'auto' : 'your-move'
    if (this.turn === 'auto') this.timer = setTimeout(() => this.advance(), this.o.wait)
    this.sync()
    this.o.redraw()
  }

  private advance() {
    this.pos = this.pos.clone()
    playMove(this.pos, this.line[this.ply])
    this.ply++
    this.step()
  }

  private sync() {
    const want = this.line[this.ply]
    const on = this.state === 'your-move'
    const arrow = on && (this.turn === 'show' || this.help >= 2)
    this.board.show(this.pos, this.color, this.line[this.ply - 1], on, arrow ? [[want, 'green']] : [], on && this.help === 1 ? want.slice(0, 2) : undefined)
  }

  async move(uci: string) {
    if (this.state !== 'your-move') return
    const want = this.line[this.ply]
    const played = norm(this.pos, uci)
    if (played === want) return this.resolve(this.turn === 'ask' ? this.grade : undefined)
    if (this.turn === 'ask') this.streak = 0
    if (this.turn === 'ask' && this.o.judge && this.help < 2) {
      const tried = this.pos.clone()
      tried.play(parseUci(played)!)
      this.state = 'judging'
      this.board.show(tried, this.color, played, false)
      this.o.redraw()
      const v = await this.o.judge(makeFen(this.pos.toSetup()), played, want)
      if (v.offer) {
        this.last = { key: keyOf(this.pos), moves: this.played, san: makeSan(this.pos, parseUci(v.offer)!), grade: Math.min(this.grade, v.rating) as Grade, offer: v.offer }
        await this.o.resolved(this.last)
        this.state = 'offer'
        this.board.show(this.pos, this.color, this.line[this.ply - 1], false, [
          [want, 'green'],
          [v.offer, 'yellow'],
        ])
        return this.o.redraw()
      }
    }
    this.wrong++
    this.tried = makeSan(this.pos, parseUci(played)!)
    sound.bad()
    this.state = 'your-move'
    this.sync()
    this.o.redraw()
  }

  private async resolve(grade?: Grade, skipped?: boolean) {
    if (grade !== undefined) {
      this.last = { key: keyOf(this.pos), moves: this.played, san: this.sans[this.ply], grade, skipped }
      this.streak = grade === FIRST_TRY && !skipped ? this.streak + 1 : 0
      this.state = 'auto'
      await this.o.resolved(this.last)
    }
    this.advance()
  }

  // The next step of the hint ladder. The solution is played on the board,
  // then taken back with its arrow for the player to play.
  hint() {
    if (!this.canHelp) return
    this.help++
    if (this.help === 3) {
      const shown = this.pos.clone()
      playMove(shown, this.line[this.ply])
      this.state = 'solution'
      this.board.show(shown, this.color, this.line[this.ply], false)
      this.timer = setTimeout(() => {
        this.state = 'your-move'
        this.sync()
        this.o.redraw()
      }, SOLUTION_MS)
    } else this.sync()
    this.o.redraw()
  }

  skip() {
    if (this.asking) void this.resolve(SKIPPED, true)
  }

  // After a playable other move: on with the line's own move
  next() {
    if (this.state === 'offer') this.advance()
  }
}
