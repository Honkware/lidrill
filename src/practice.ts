import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseSquare, parseUci } from 'chessops/util'
import type { Engine } from './analysis/engine'
import { db, type Game, type Practice, type PracticeKind } from './db'
import { povCp } from './puzzles/generate'
import { parseTyped } from './typed'

// Conversion and defense drills: positions from the player's own
// games, played out against Stockfish. Cleared after 3 successes in a row.

export const CLEAR_AFTER = 3
const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 }

// Conversion: a game not won after holding a 5-point material lead for 4
// plies; the drill starts where the lead was first established, player to
// move. Defense: a game not lost after being 150 cp worse; it starts at the
// first such position.
export function findPractice(game: Game): Practice[] {
  if (!game.analyzedAt) return []
  const pos = Chess.default()
  const out: Practice[] = []
  let run = 0
  let conversion: Practice | undefined
  let defense: Practice | undefined
  game.moves.forEach((m, i) => {
    const ply = i + 1
    pos.play(parseUci(m.uci)!)
    const playerToMove = pos.turn === game.color
    let lead = 0
    for (const [, p] of pos.board) lead += (p.color === game.color ? 1 : -1) * VALUE[p.role]
    run = lead >= 5 ? run + 1 : 0
    const fen = makeFen(pos.toSetup())
    const cp = m.eval ? povCp(m.eval, game.color) : undefined
    if (!conversion && game.result !== 'win' && run >= 4 && playerToMove && !pos.isEnd() && cp !== undefined && cp >= 300)
      conversion = { id: `${game.id}:${ply}:conversion`, gameId: game.id, ply, fen, kind: 'conversion', startCp: cp, streak: 0, attempts: 0, cleared: false }
    if (!defense && game.result !== 'loss' && ply > 10 && playerToMove && !pos.isEnd() && cp !== undefined && cp <= -150 && cp > -600 && !m.book)
      defense = { id: `${game.id}:${ply}:defense`, gameId: game.id, ply, fen, kind: 'defense', startCp: cp, streak: 0, attempts: 0, cleared: false }
  })
  if (conversion) out.push(conversion)
  if (defense) out.push(defense)
  return out
}

export type RunState = 'thinking' | 'your-move' | 'won' | 'lost'

const DEPTH = 10
const MAX_MOVES: Record<PracticeKind, number> = { conversion: 30, defense: 12 }

// Success and failure lines, in centipawns for the player
export function verdict(kind: PracticeKind, startCp: number, cp: number, movesPlayed: number): 'won' | 'lost' | undefined {
  if (kind === 'conversion') {
    if (cp >= 1000) return 'won'
    if (cp < 200) return 'lost'
    if (movesPlayed >= MAX_MOVES.conversion) return cp >= 500 ? 'won' : 'lost'
    return undefined
  }
  if (cp < startCp - 200) return 'lost'
  if (cp >= 0 || movesPlayed >= MAX_MOVES.defense) return cp >= startCp - 100 ? 'won' : 'lost'
  return undefined
}

export class PracticeRun {
  state: RunState = 'your-move'
  moves = 0
  cp: number
  last?: string // SAN of the engine's last reply
  readonly practice: Practice
  private pos: Chess
  private cg?: Api
  private engine: Engine
  private redraw: () => void
  private color: 'white' | 'black'

  constructor(practice: Practice, engine: Engine, redraw: () => void) {
    this.practice = practice
    this.engine = engine
    this.redraw = redraw
    this.cp = practice.startCp
    this.pos = Chess.fromSetup(parseFen(practice.fen).unwrap()).unwrap()
    this.color = this.pos.turn
  }

  get orientation() {
    return this.color
  }

  mount(el: HTMLElement) {
    this.cg = Chessground(el, {
      fen: this.practice.fen,
      orientation: this.color,
      turnColor: this.color,
      coordinates: true,
      premovable: { enabled: false },
      movable: { free: false, color: this.color, dests: chessgroundDests(this.pos), showDests: true },
      events: { move: (orig, dest) => this.onMove(orig, dest) },
    })
  }

  destroy() {
    this.cg?.destroy()
  }

  private sync(lastMove?: string) {
    this.cg?.set({
      fen: makeFen(this.pos.toSetup()),
      turnColor: this.pos.turn,
      check: this.pos.isCheck(),
      lastMove: lastMove ? ([lastMove.slice(0, 2), lastMove.slice(2, 4)] as Key[]) : undefined,
      movable: this.state === 'your-move' ? { color: this.color, dests: chessgroundDests(this.pos) } : { color: undefined, dests: new Map() },
    })
  }

  private onMove(orig: Key, dest: Key) {
    let uci = orig + dest
    if (this.pos.board.get(parseSquare(orig)!)?.role === 'pawn' && /[18]$/.test(dest)) uci += 'q'
    this.onUci(uci)
  }

  // Keyboard entry; returns false if the text isn't a legal move here
  typeMove(text: string): boolean {
    if (this.state !== 'your-move') return false
    const uci = parseTyped(this.pos, text)
    if (!uci) return false
    this.onUci(uci)
    return true
  }

  private async onUci(uci: string) {
    this.pos.play(parseUci(uci)!)
    this.moves++
    this.state = 'thinking'
    this.sync(uci)
    this.redraw()
    if (this.pos.isCheckmate()) return this.end('won')
    if (this.pos.isEnd()) return this.end(this.practice.kind === 'defense' ? 'won' : 'lost') // a draw holds, but doesn't convert

    const reply = await this.engine.search(makeFen(this.pos.toSetup()), DEPTH)
    // The search is from the engine's side: flip it for the player
    this.cp = -povCp(reply.eval, 'white')
    const early = verdict(this.practice.kind, this.practice.startCp, this.cp, this.moves)
    if (early === 'lost' || !reply.pv[0]) return this.end(early ?? 'lost')
    const move = parseUci(reply.pv[0])!
    this.last = makeSan(this.pos, move)
    this.pos.play(move)
    if (this.pos.isCheckmate()) return this.end('lost')
    if (this.pos.isEnd()) return this.end(this.practice.kind === 'defense' ? 'won' : 'lost')
    if (early) return this.end(early)
    this.state = 'your-move'
    this.sync(reply.pv[0])
    this.redraw()
  }

  private async end(result: 'won' | 'lost') {
    this.state = result
    this.sync()
    const p = this.practice
    const streak = result === 'won' ? p.streak + 1 : 0
    await db.practice.update(p.id, { streak, attempts: p.attempts + 1, cleared: p.cleared || streak >= CLEAR_AFTER })
    this.redraw()
  }
}
