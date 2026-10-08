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

function attackers(pos: Chess, square: Square, by: Color, occupied?: typeof pos.board.occupied): { role: Role; square: Square }[] {
  const occ = occupied ?? pos.board.occupied
  const out: { role: Role; square: Square }[] = []
  for (const [sq, piece] of pos.board) if (piece.color === by && attacks(piece, sq, occ).has(square)) out.push({ role: piece.role, square: sq })
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

// MateNet: why the king cannot run. Enumerated at the terminal
// position of a certified mating line, with the mated side to move: every
// square adjacent to the king is either blocked by its own piece or covered
// by an attacker of the mating side (chessops attacks include the enemy
// king, so adjacency is covered too). A genuine checkmate refutes every
// flight square; an open square means the line was not mate and the caller
// must fail closed rather than certify.
export interface EscapeSquare {
  square: string
  blockedBy?: Role // an own piece sits on the square
  coveredBy?: { role: Role; square: string }[] // mating side's attackers
}

export function escapeSquares(pos: Chess, mated: Color): { squares: EscapeSquare[]; complete: boolean } {
  const king = pos.board.kingOf(mated)
  if (king === undefined) return { squares: [], complete: false }
  const mating = other(mated)
  // Coverage is computed with the mated king lifted off the board: it blocks
  // the checking piece's ray, but the squares behind it are still flight
  // squares it could never reach (the ray re-opens the moment it moves)
  const noKing = pos.board.occupied.without(king)
  const squares: EscapeSquare[] = []
  let complete = true
  const kf = king % 8
  const kr = Math.floor(king / 8)
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue
      const f = kf + df
      const r = kr + dr
      if (f < 0 || f > 7 || r < 0 || r > 7) continue
      const sq = f + r * 8
      const square = makeSquare(sq)
      const piece = pos.board.get(sq)
      if (piece && piece.color === mated) {
        squares.push({ square, blockedBy: piece.role })
        continue
      }
      const cover = attackers(pos, sq, mating, noKing).map(a => ({ role: a.role, square: makeSquare(a.square) }))
      if (cover.length) squares.push({ square, coveredBy: cover })
      else {
        squares.push({ square })
        complete = false
      }
    }
  }
  return { squares, complete }
}

// MateNet, in words: the certified refutation sentence the mate
// certificate's companion carries ("the king cannot run" + one clause per
// flight square, squares sharing a blocker or cover grouped). Composed once
// here at build time; every surface renders the stored text verbatim.
export function escapeNetText(net: { squares: EscapeSquare[] }): string {
  const blocked = new Map<string, string[]>()
  const covered = new Map<string, string[]>()
  for (const e of net.squares) {
    if (e.blockedBy) {
      const key = pieceName(e.blockedBy)
      blocked.set(key, [...(blocked.get(key) ?? []), e.square])
      continue
    }
    const cover = (e.coveredBy ?? []).map(c => `the ${pieceName(c.role)} on ${c.square}`).join(' and ')
    const key = cover || 'open'
    covered.set(key, [...(covered.get(key) ?? []), e.square])
  }
  const join = (sq: string[]) => (sq.length > 2 ? `${sq.slice(0, -1).join(', ')} and ${sq[sq.length - 1]}` : sq.join(' and '))
  const items: string[] = []
  for (const [role, sq] of blocked) items.push(`${join(sq)} ${sq.length > 1 ? 'are' : 'is'} blocked by its own ${role}${sq.length > 1 ? 's' : ''}`)
  for (const [cover, sq] of covered) items.push(cover === 'open' ? `${join(sq)} is open` : `${join(sq)} ${sq.length > 1 ? 'are' : 'is'} covered by ${cover}`)
  return `The king cannot run: ${items.join('; ')}`
}

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

// "White: Ke1, Qd1, Bc4, pawns a2 b2. Black: ..." so the model doesn't
// have to read the FEN (misreading the board is the commonest LLM error)
export function pieceList(pos: Chess): string {
  const LETTER: Record<Role, string> = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' }
  const ORDER: Role[] = ['king', 'queen', 'rook', 'bishop', 'knight']
  const side = (c: Color) => {
    const pieces = ORDER.flatMap(r => [...pos.board.pieces(c, r)].map(s => `${LETTER[r]}${makeSquare(s)}`))
    const pawns = [...pos.board.pieces(c, 'pawn')].map(makeSquare)
    return `${COLOR(c)}: ${[...pieces, ...(pawns.length ? [`pawns ${pawns.join(' ')}`] : [])].join(', ')}.`
  }
  return `${side('white')} ${side('black')}`
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
