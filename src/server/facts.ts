import { attacks } from 'chessops/attacks'
import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan, parseSan } from 'chessops/san'
import type { Color, Role, Square } from 'chessops/types'
import { makeSquare } from 'chessops/util'

// Board facts for the explanation, worked out by replaying the moves, so the
// model is told what is on the board instead of guessing. Lines that don't
// replay legally are refused.

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 }
const NAME: Record<Role, string> = { pawn: 'pawn', knight: 'knight', bishop: 'bishop', rook: 'rook', queen: 'queen', king: 'king' }
const COLOR = (c: Color) => (c === 'white' ? 'White' : 'Black')
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white')

export const fromFen = (fen: string): Chess | undefined => {
  const setup = parseFen(fen)
  if (setup.isErr) return undefined
  const pos = Chess.fromSetup(setup.value)
  return pos.isOk ? pos.value : undefined
}

function attackers(pos: Chess, square: Square, by: Color): { role: Role; square: Square }[] {
  const out: { role: Role; square: Square }[] = []
  for (const [sq, piece] of pos.board) if (piece.color === by && attacks(piece, sq, pos.board.occupied).has(square)) out.push({ role: piece.role, square: sq })
  return out.sort((a, b) => VALUE[a.role] - VALUE[b.role])
}

// Pieces of `color` that the other side can win: attacked and undefended, or
// attacked by something cheaper
export interface Loose {
  role: Role
  square: string
  text: string
}

export function looseList(pos: Chess, color: Color): Loose[] {
  const out: Loose[] = []
  for (const [sq, piece] of pos.board) {
    if (piece.color !== color || piece.role === 'king') continue
    const att = attackers(pos, sq, other(color))
    if (!att.length) continue
    const def = attackers(pos, sq, color)
    if (def.length && VALUE[att[0].role] >= VALUE[piece.role]) continue
    out.push({
      role: piece.role,
      square: makeSquare(sq),
      text: `the ${NAME[piece.role]} on ${makeSquare(sq)} can be taken by the ${NAME[att[0].role]} on ${makeSquare(att[0].square)}${def.length ? '' : ' and is undefended'}`,
    })
  }
  return out.slice(0, 3)
}

export const hanging = (pos: Chess, color: Color): string[] => looseList(pos, color).map(l => l.text)

// What the piece that just moved to `to` attacks: two or more valuable
// targets is a fork
function forks(pos: Chess, to: Square): string | undefined {
  const piece = pos.board.get(to)
  if (!piece) return undefined
  const targets = [...attacks(piece, to, pos.board.occupied)]
    .map(sq => ({ sq, p: pos.board.get(sq) }))
    .filter(t => t.p && t.p.color !== piece.color && (t.p.role === 'king' || VALUE[t.p.role] >= 3 || VALUE[t.p.role] > VALUE[piece.role]))
  if (targets.length < 2) return undefined
  return `the ${NAME[piece.role]} on ${makeSquare(to)} attacks ${targets.map(t => `the ${NAME[t.p!.role]} on ${makeSquare(t.sq)}`).join(' and ')}`
}

export interface PlayedMove {
  san: string // as written, with + or #
  bare: string // without + or #
  from: string
  to: string
  fenBefore: string
  fenAfter: string
  color: Color
  role: Role
  captured?: Role
  capturedOn?: string
  promotion?: Role
  castle: boolean
  check: boolean
  mate: boolean
  fork?: string
}

export interface LineReplay {
  annotated: string // "6. Bxf7+ (bishop takes pawn on f7, check) Ke7 7. Nd5# (checkmate)"
  moves: PlayedMove[]
  positions: Chess[] // after each move
}

// Replays SAN from fen; undefined if any move is illegal
export function replay(fen: string, sans: string[]): LineReplay | undefined {
  const pos = fromFen(fen)
  if (!pos) return undefined
  let n = pos.fullmoves
  const parts: string[] = []
  const positions: Chess[] = []
  const moves: PlayedMove[] = []
  for (const [i, san] of sans.entries()) {
    const move = parseSan(pos, san)
    if (!move || !('from' in move)) return undefined
    const fenBefore = makeFen(pos.toSetup())
    const mover = pos.board.get(move.from)!
    const target = pos.board.get(move.to)
    const castle = mover.role === 'king' && target?.color === mover.color
    const enPassant = mover.role === 'pawn' && !target && move.from % 8 !== move.to % 8
    const captured: Role | undefined = castle ? undefined : target ? target.role : enPassant ? 'pawn' : undefined
    const capturedOn = captured ? makeSquare(enPassant ? (move.to + (mover.color === 'white' ? -8 : 8)) : move.to) : undefined
    const written = makeSan(pos, move)
    if (pos.turn === 'white') parts.push(`${n}.`)
    else if (i === 0) parts.push(`${n}...`)
    pos.play(move)
    if (pos.turn === 'white') n++
    // Castling is stored king-to-rook; the king lands on c or g
    const to = castle ? makeSquare(((move.to % 8) > (move.from % 8) ? move.from + 2 : move.from - 2)) : makeSquare(move.to)
    const m: PlayedMove = {
      san: written,
      bare: written.replace(/[+#]$/, ''),
      from: makeSquare(move.from),
      to,
      fenBefore,
      fenAfter: makeFen(pos.toSetup()),
      color: mover.color,
      role: mover.role,
      captured,
      capturedOn,
      promotion: move.promotion,
      castle,
      check: pos.isCheck() && !pos.isCheckmate(),
      mate: pos.isCheckmate(),
      fork: castle ? undefined : forks(pos, move.to),
    }
    const notes: string[] = []
    if (castle) notes.push('castles')
    else if (captured) notes.push(`${NAME[mover.role]} takes ${NAME[captured]} on ${capturedOn}`)
    if (m.promotion) notes.push(`promotes to ${NAME[m.promotion]}`)
    if (m.mate) notes.push('checkmate')
    else if (m.check) notes.push('check')
    if (m.fork) notes.push(m.fork)
    parts.push(notes.length ? `${written} (${notes.join(', ')})` : written)
    positions.push(pos.clone())
    moves.push(m)
  }
  return { annotated: parts.join(' '), moves, positions }
}

export const pieceName = (r: Role) => NAME[r]

function material(pos: Chess): number {
  let d = 0
  for (const [, p] of pos.board) if (p.role !== 'king') d += (p.color === 'white' ? 1 : -1) * VALUE[p.role]
  return d
}

export function setting(pos: Chess): string {
  let pieces = 0
  for (const [, p] of pos.board) if (p.role !== 'king' && p.role !== 'pawn') pieces += VALUE[p.role]
  const phase = pieces <= 26 ? 'endgame' : pos.fullmoves <= 12 ? 'opening' : 'middlegame'
  const d = material(pos)
  const bal = d === 0 ? 'material is level' : `${d > 0 ? 'White' : 'Black'} is up ${Math.abs(d)} point${Math.abs(d) === 1 ? '' : 's'} of material`
  const check = pos.isCheck() ? `, ${COLOR(pos.turn)} is in check` : ''
  return `Move ${pos.fullmoves}, ${phase}; ${bal}${check}.`
}

// Position with the other side to move, for "what do they threaten?"
export function passFen(fen: string): string | undefined {
  const pos = fromFen(fen)
  if (!pos || pos.isCheck()) return undefined
  const passed = pos.clone()
  passed.turn = other(pos.turn)
  passed.epSquare = undefined
  const back = fromFen(makeFen(passed.toSetup()))
  return back && !back.isCheck() ? makeFen(passed.toSetup()) : undefined
}
