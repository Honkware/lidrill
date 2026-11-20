import { attacks, between, bishopAttacks, rookAttacks } from 'chessops/attacks'
import type { Chess } from 'chessops/chess'
import { SquareSet } from 'chessops/squareSet'
import type { Color, Role, Square } from 'chessops/types'
import { makeSquare, parseSquare } from 'chessops/util'
import { fromFen, pieceName, type LineReplay, type PlayedMove } from './facts'

// Named tactical patterns in a line, so an explanation can say "pin" or
// "fork" only when one is really there. The rules follow the Lichess puzzle
// tagger (lichess-puzzler tagger/cook.py), tightened: a pattern only counts
// if the side using it wins material or mates afterwards, pins include pins
// to the queen, and pinned defenders don't count as defenders.
// lichess-puzzler is copyright its authors (github.com/ornicar/lichess-puzzler)
// and licensed AGPL-3.0.

export type MotifName =
  | 'smothered mate'
  | 'back-rank mate'
  | 'double check'
  | 'promotion'
  | 'trapped piece'
  | 'fork'
  | 'skewer'
  | 'pin'
  | 'discovered attack'
  | 'removing the defender'
  | 'hanging piece'

export interface Motif {
  name: MotifName
  text: string // the pattern with its pieces and squares, checked against the board
  ply: number // index in the line of the move that shows it
}

// The order to prefer when several apply: what decides the line first
const PRIORITY: MotifName[] = [
  'smothered mate',
  'back-rank mate',
  'double check',
  'trapped piece',
  'fork',
  'skewer',
  'pin',
  'discovered attack',
  'removing the defender',
  'promotion',
  'hanging piece',
]

// Plain one-line meanings, for the prompt
export const MEANING: Record<MotifName, string> = {
  'smothered mate': 'the king is boxed in by its own pieces and a knight mates it',
  'back-rank mate': 'the king is stuck behind its own pieces on the back rank',
  'double check': 'two pieces give check at once, so the king has to move',
  promotion: 'a pawn reaches the last rank and becomes a new piece',
  'trapped piece': 'a piece has no safe square left',
  fork: 'one piece attacks two things at once',
  skewer: 'a valuable piece is attacked, moves away, and the piece behind it is taken',
  pin: 'a piece cannot move without exposing a more valuable piece behind it',
  'discovered attack': 'a piece moves out of the way and uncovers an attack by the piece behind it',
  'removing the defender': 'taking the piece that guards something, then taking what it guarded',
  'hanging piece': 'an unprotected piece is simply taken',
}

const V: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 }
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white')
const sq = (s: string) => parseSquare(s)!
const name = (r: Role) => pieceName(r)
const at = (pos: Chess, s: Square) => pos.board.get(s)

const isSlider = (r: Role) => r === 'bishop' || r === 'rook' || r === 'queen'
// Does a slider of this role move along the line between a and b?
const onLine = (r: Role, a: Square, b: Square) =>
  ((r === 'bishop' || r === 'queen') && bishopAttacks(a, SquareSet.empty()).has(b)) ||
  ((r === 'rook' || r === 'queen') && rookAttacks(a, SquareSet.empty()).has(b))

export interface Pin {
  pinner: Square
  pinned: Square
  target: Square
}

// Pieces of `color` that can't move off a line without exposing a more
// valuable piece (or the king) to an enemy slider
export function pinsOf(pos: Chess, color: Color): Pin[] {
  const out: Pin[] = []
  const occ = pos.board.occupied
  for (const [s, slider] of pos.board) {
    if (slider.color === color || !isSlider(slider.role)) continue
    for (const [t, target] of pos.board) {
      if (target.color !== color || !onLine(slider.role, s, t)) continue
      const inBetween = between(s, t).intersect(occ)
      const p = inBetween.singleSquare()
      if (p === undefined) continue
      const pinned = at(pos, p)!
      if (pinned.color !== color || V[pinned.role] >= V[target.role] || (V[target.role] <= V[slider.role] && target.role !== 'king')) continue
      out.push({ pinner: s, pinned: p, target: t })
    }
  }
  return out
}

// Defenders of a square, leaving out pieces pinned to their king
function defenders(pos: Chess, s: Square, color: Color): SquareSet {
  let set = pos.kingAttackers(s, color, pos.board.occupied)
  for (const pin of pinsOf(pos, color)) if (at(pos, pin.target)?.role === 'king' && !between(pin.pinner, pin.target).with(pin.pinner).has(s)) set = set.without(pin.pinned)
  return set
}

const attackersOf = (pos: Chess, s: Square, color: Color) => pos.kingAttackers(s, color, pos.board.occupied)

function badSpot(pos: Chess, s: Square): boolean {
  const piece = at(pos, s)
  if (!piece) return false
  const att = attackersOf(pos, s, other(piece.color))
  if (att.isEmpty()) return false
  if (defenders(pos, s, piece.color).isEmpty()) return true
  for (const a of att) if (at(pos, a)!.role !== 'king' && V[at(pos, a)!.role] < V[piece.role]) return true
  return false
}

// No move of the piece reaches a safe square or wins something as good
function trapped(pos: Chess, s: Square): boolean {
  const piece = at(pos, s)
  if (!piece || piece.role === 'pawn' || piece.role === 'king' || pos.turn !== piece.color || pos.isCheck()) return false
  // A pinned piece can't move either, but that's the pin, not a trap
  if (pinsOf(pos, piece.color).some(p => p.pinned === s)) return false
  if (!badSpot(pos, s)) return false
  for (const d of pos.dests(s)) {
    const taken = at(pos, d)
    if (taken && V[taken.role] >= V[piece.role]) return false
    const next = pos.clone()
    next.play({ from: s, to: d })
    if (!badSpot(next, d)) return false
  }
  return true
}

function materialOf(pos: Chess, color: Color): number {
  let d = 0
  for (const [, p] of pos.board) if (p.role !== 'king') d += (p.color === color ? 1 : -1) * V[p.role]
  return d
}

const before = (m: PlayedMove) => fromFen(m.fenBefore)!

// Motifs used by the side making move `start` (0 for the best line, 1 for the
// opponent's punishment of a wrong move)
export function motifs(line: LineReplay, start = 0): Motif[] {
  const ms = line.moves
  if (ms.length <= start) return []
  const me = ms[start].color
  const them = other(me)
  const last = line.positions[line.positions.length - 1]
  const mated = last.isCheckmate() && last.turn === them
  // Net over the whole line, so taking back after a trade isn't a win
  const gain = materialOf(last, me) - materialOf(before(ms[0]), me)
  if (!mated && gain <= 0) return []
  const out: Motif[] = []
  // Later captures by the side using the pattern
  const takenLater = (from: number, s: Square) => ms.slice(from).some((m, j) => (from + j - start) % 2 === 0 && m.color === me && m.capturedOn === makeSquare(s))

  if (mated) {
    const k = last.board.kingOf(them)!
    const checkers = last.ctx().checkers
    const fin = ms[ms.length - 1]
    const ring = attacks({ role: 'king', color: them }, k, SquareSet.empty())
    const own = [...ring].filter(s => at(last, s)?.color === them).length
    if (checkers.size() === 1 && at(last, checkers.first()!)!.role === 'knight' && own === ring.size())
      out.push({ name: 'smothered mate', text: `the king on ${makeSquare(k)} is boxed in by its own pieces and the knight mates with ${fin.san}`, ply: ms.length - 1 })
    const back = them === 'white' ? 0 : 7
    if (k >> 3 === back && [...checkers].some(c => c >> 3 === back)) {
      const front = [...ring].filter(s => s >> 3 !== back)
      if (front.length && front.every(s => at(last, s)?.color === them && attacksFrom(last, s, me).isEmpty()))
        out.push({ name: 'back-rank mate', text: `the king on ${makeSquare(k)} is stuck behind its own pieces and ${fin.san} mates on the back rank`, ply: ms.length - 1 })
    }
  }

  for (let i = start; i < ms.length; i += 2) {
    const m = ms[i]
    const after = line.positions[i]
    const pre = before(m)
    const to = sq(m.to)
    const checkers = after.ctx().checkers

    if (checkers.size() >= 2) out.push({ name: 'double check', text: `${m.san} gives check with two pieces at once, so the king has to move`, ply: i })
    if (m.promotion) out.push({ name: 'promotion', text: `${m.san} promotes the pawn to a ${name(m.promotion)}`, ply: i })

    // Fork: the moved piece, safe where it landed, hits two targets, and one is won
    // (a mating move is the mate, not a fork)
    if (m.role !== 'king' && !m.castle && !m.mate && !badSpot(after, to)) {
      const targets = [...attacks(at(after, to)!, to, after.board.occupied)].filter(t => {
        const p = at(after, t)
        return p && p.color === them && p.role !== 'pawn' && (V[p.role] > V[m.role] || (defenders(after, t, them).isEmpty() && !attacks(p, t, after.board.occupied).has(to)))
      })
      if (targets.length >= 2 && targets.some(t => at(after, t)!.role !== 'king' && takenLater(i + 1, t)))
        out.push({ name: 'fork', text: `${m.san} attacks ${targets.map(t => `the ${name(at(after, t)!.role)} on ${makeSquare(t)}`).join(' and ')} at once`, ply: i })
    }

    // Pin: a piece pinned after this move is still pinned when it's taken
    for (const pin of pinsOf(after, them)) {
      if (at(after, pin.pinner)?.color !== me) continue
      const pinnedRole = at(after, pin.pinned)!.role
      if (pinnedRole === 'pawn') continue
      const taker = ms.findIndex((x, j) => j > i && (j - start) % 2 === 0 && x.capturedOn === makeSquare(pin.pinned))
      const still = (pos: Chess) => pinsOf(pos, them).some(p => p.pinned === pin.pinned && p.pinner === pin.pinner)
      if (taker > i && still(before(ms[taker])))
        out.push({
          name: 'pin',
          text: `the ${name(pinnedRole)} on ${makeSquare(pin.pinned)} is pinned to the ${name(at(after, pin.target)!.role)} on ${makeSquare(pin.target)} by the ${name(at(after, pin.pinner)!.role)} on ${makeSquare(pin.pinner)}`,
          ply: i,
        })
    }

    if (i > start) {
      const o = ms[i - 1] // the opponent's move just before
      const oFrom = sq(o.from)
      // Skewer: a valuable piece stepped off the slider's line, the one behind falls
      if (m.captured && m.captured !== 'pawn' && isSlider(m.role) && !m.mate && o.to !== m.to && between(sq(m.from), to).has(oFrom) && V[o.role] > V[m.captured]) {
        const preO = before(o)
        if (attacks(at(preO, sq(m.from))!, sq(m.from), preO.board.occupied).has(oFrom))
          out.push({ name: 'skewer', text: `the ${name(o.role)} on ${o.from} had to step off the line, and ${m.san} takes the ${name(m.captured)} behind it`, ply: i })
      }
      // Trapped: the piece taken had no safe square before its last chance
      if (m.captured && m.captured !== 'pawn') {
        const s = o.to === m.capturedOn ? oFrom : sq(m.capturedOn!)
        const preO = before(o)
        if (trapped(preO, s)) out.push({ name: 'trapped piece', text: `the ${name(at(preO, s)!.role)} on ${makeSquare(s)} had no safe square, and ${m.san} wins it`, ply: i })
      }
    }

    // Discovered attack: moving away opens a line from a piece behind
    const opened = m.castle ? [] : [...after.board.pieces(me, 'bishop').union(after.board.pieces(me, 'rook')).union(after.board.pieces(me, 'queen'))].filter(s => s !== to)
    for (const s of opened) {
      const slider = at(after, s)!
      for (const t of attacks(slider, s, after.board.occupied)) {
        const target = at(after, t)
        if (!target || target.color !== them || !between(s, t).has(sq(m.from)) || between(s, t).has(to)) continue
        if (target.role !== 'king' && (V[target.role] < 3 || !takenLater(i + 1, t))) continue
        out.push({
          name: 'discovered attack',
          text: `moving the ${name(m.role)} from ${m.from} uncovers the ${name(slider.role)} on ${makeSquare(s)}, which ${target.role === 'king' ? 'gives check' : `attacks the ${name(target.role)} on ${makeSquare(t)}`}`,
          ply: i,
        })
      }
    }

    // Removing the defender: the piece taken was the only guard of something taken later
    // (winning a bigger piece outright is just winning it)
    if (m.captured && m.capturedOn && V[m.captured] <= V[m.role]) {
      const d = sq(m.capturedOn)
      const guard = at(pre, d)!
      for (const t of attacks(guard, d, pre.board.occupied)) {
        const target = at(pre, t)
        if (!target || target.color !== them || target.role === 'king' || target.role === 'pawn') continue
        if (defenders(pre, t, them).size() !== 1) continue
        if (ms.slice(i + 2).some((x, j) => j % 2 === 0 && x.capturedOn === makeSquare(t) && x.captured === target.role))
          out.push({ name: 'removing the defender', text: `${m.san} takes the ${name(guard.role)} that guarded the ${name(target.role)} on ${makeSquare(t)}`, ply: i })
      }
    }

    // Hanging: the first move simply takes an unguarded piece
    if (i === start && m.captured && m.captured !== 'pawn' && defenders(pre, sq(m.capturedOn!), them).isEmpty())
      out.push({ name: 'hanging piece', text: `the ${name(m.captured)} on ${m.capturedOn} was unprotected, so ${m.san} wins it`, ply: i })
  }

  // One of each, best first, earliest first within a kind
  const seen = new Set<MotifName>()
  return out
    .sort((a, b) => PRIORITY.indexOf(a.name) - PRIORITY.indexOf(b.name) || a.ply - b.ply)
    .filter(x => {
      if (seen.has(x.name)) return false
      seen.add(x.name)
      return true
    })
}

function attacksFrom(pos: Chess, s: Square, by: Color): SquareSet {
  return pos.kingAttackers(s, by, pos.board.occupied)
}
