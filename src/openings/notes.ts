import { attacks, kingAttacks } from 'chessops/attacks'
import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import type { Color, Role, Square } from 'chessops/types'
import { makeSquare, parseSquare, parseUci, squareFile } from 'chessops/util'
import { developmentOf, fileStates, structureOf } from '../server/features'
import { fromFen, passFen, pieceName, replay, type PlayedMove } from '../server/facts'
import { pinsOf } from '../server/motifs'

// A one-sentence note on what a move in a line does, built from the board
// with the same detectors the "Why?" explanations use, so it only says what
// is true there: a head (castles, takes, develops, a pawn to the centre or a
// passed pawn pushed) and at most one thing the move then does, the first
// of mate threat, double attack, pin, attack, defence, a square by the
// king, a file opened and lines opened by a pawn. A move with none of these
// gets no note.

const V: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 }
const CENTRE = new Set(['d4', 'e4', 'd5', 'e5'])
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white')
const the = (pos: Chess, s: Square) => `the ${pieceName(pos.board.get(s)!.role)} on ${makeSquare(s)}`

// The most valuable of squares holding pieces, for "attacks the bishop"
const best = (pos: Chess, sqs: Square[]) => sqs.sort((a, b) => V[pos.board.get(b)!.role] - V[pos.board.get(a)!.role])[0]

function head(pre: Chess, post: Chess, m: PlayedMove, prev?: PlayedMove): string | undefined {
  if (m.captured) return prev?.capturedOn === m.capturedOn ? `takes back on ${m.capturedOn}` : `takes the ${pieceName(m.captured)} on ${m.capturedOn}`
  const dev = [developmentOf(pre), developmentOf(post)]
  const side = m.color === 'white' ? 'w' : 'b'
  if (dev[0] !== 'SUPPRESSED' && dev[1] !== 'SUPPRESSED' && dev[1][side].minorsOff > dev[0][side].minorsOff) return `develops the ${pieceName(m.role)}`
  if (m.role !== 'pawn') return undefined
  if (structureOf(post, m.color).passed.includes(m.to)) return `pushes the passed pawn to ${m.to}`
  if (CENTRE.has(m.to)) return 'puts a pawn in the centre'
}

// Where the side that just moved would mate if it moved again
function mateThreat(fenAfter: string): string | undefined {
  const fen = passFen(fenAfter)
  const pos = fen && fromFen(fen)
  if (!pos) return undefined
  for (const [from, p] of pos.board) {
    if (p.color !== pos.turn) continue
    for (const to of pos.dests(from)) {
      const next = pos.clone()
      next.play({ from, to, promotion: p.role === 'pawn' && (to >> 3 === 0 || to >> 3 === 7) ? 'queen' : undefined })
      if (next.isCheckmate()) return makeSquare(to)
    }
  }
}

function clause(pre: Chess, post: Chess, m: PlayedMove): string | undefined {
  const me = m.color
  const them = other(me)
  const to = parseSquare(m.to)!
  const from = parseSquare(m.from)!
  const piece = post.board.get(to)!
  const hits = attacks(piece, to, post.board.occupied)
  const hitBefore = attacks(piece, from, pre.board.occupied)

  if (!m.check) {
    const mate = mateThreat(m.fenAfter)
    if (mate) return `threatens mate on ${mate}`
  }
  if (m.fork) return `attacks ${m.fork.slice(m.fork.indexOf(' attacks ') + 9)} at once`
  const pin = pinsOf(post, them).find(p => p.pinner === to && post.board.get(p.pinned)!.role !== 'pawn')
  if (pin) return `pins ${the(post, pin.pinned)} to ${the(post, pin.target)}`

  const undefended = (pos: Chess, s: Square, c: Color) => pos.kingAttackers(s, c, pos.board.occupied).isEmpty()
  const targets = [...hits].filter(s => {
    const p = post.board.get(s)
    return p && p.color === them && p.role !== 'king' && !hitBefore.has(s) && (V[p.role] > V[m.role] || undefended(post, s, them))
  })
  if (targets.length) return `attacks ${the(post, best(post, targets))}`
  const guarded = [...hits].filter(s => {
    const p = post.board.get(s)
    return p && p.color === me && p.role !== 'king' && !post.kingAttackers(s, them, post.board.occupied).isEmpty() && undefended(pre, s, me)
  })
  if (guarded.length) return `defends ${the(post, best(post, guarded))}`

  const king = post.board.kingOf(them)!
  if (m.role !== 'pawn' && !m.check) {
    const near = [...hits.intersect(kingAttacks(king))].filter(s => !hitBefore.has(s) && post.board.get(s)?.color !== me)
    if (near.length) return `aims at ${makeSquare(near[0])}, next to the king`
  }

  const files = [fileStates(pre), fileStates(post)]
  const mine = me === 'white' ? 'halfOpenW' : 'halfOpenB'
  const f = files[1].findIndex((s, i) => s !== files[0][i] && (s === 'open' || s === mine))
  if (f >= 0) return `${files[1][f] === 'open' ? 'opens' : 'half-opens'} the ${'abcdefgh'[f]}-file`

  if (m.role === 'pawn') {
    // A bishop, rook or queen behind the pawn that now reaches two more squares
    const roles: Role[] = []
    for (const [s, p] of post.board) {
      if (p.color !== me || s === to || !['bishop', 'rook', 'queen'].includes(p.role) || roles.includes(p.role)) continue
      if (attacks(p, s, post.board.occupied).size() - attacks(p, s, pre.board.occupied).size() >= 2) roles.push(p.role)
    }
    roles.sort((a, b) => V[a] - V[b])
    if (roles.length) return `opens ${roles.length > 1 ? 'lines' : 'a line'} for the ${roles.join(' and ')}`
  }
}

function note(pre: Chess, uci: string, prev?: PlayedMove): { move: PlayedMove; text?: string } {
  const m = replay(makeFen(pre.toSetup()), [makeSan(pre, parseUci(uci)!)])!.moves[0]
  if (m.mate) return { move: m, text: 'Checkmate.' }
  const post = fromFen(m.fenAfter)!
  if (m.castle) return { move: m, text: `Castles ${squareFile(parseSquare(m.to)!) === 6 ? 'kingside' : 'queenside'}${m.check ? ' with check' : ''}.` }
  let h = head(pre, post, m, prev)
  const c = clause(pre, post, m)
  if (m.check && !m.fork) h = h ? `${h} with check` : 'gives check'
  const text = h && c ? `${h} and ${c}` : (h ?? c)
  return { move: m, text: text && `${text[0].toUpperCase()}${text.slice(1)}.` }
}

// A note per move of a line from the starting position, undefined where
// nothing notable is true
export function lineNotes(moves: string[]): (string | undefined)[] {
  const pos = Chess.default()
  let prev: PlayedMove | undefined
  return moves.map(uci => {
    const n = note(pos, uci, prev)
    pos.play(parseUci(uci)!)
    prev = n.move
    return n.text
  })
}
