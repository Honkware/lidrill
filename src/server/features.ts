import { attacks, between, kingAttacks, pawnAttacks, ray } from 'chessops/attacks'
import type { Chess } from 'chessops/chess'
import { SquareSet } from 'chessops/squareSet'
import type { Color, Role, Square } from 'chessops/types'
import { makeSquare, squareFile, squareRank } from 'chessops/util'
import { fromFen } from './facts'

// Position features for quiet, non-tactical positions: king safety, pawn
// structure, open files, development and activity, so an explanation can
// say "the e-file is half-open" or "d5 is isolated" only when the board says
// so. Every detector is a fixed definition, pinned by FEATURES_VERSION (and
// BACKWARD_DEF for the one with rival definitions), so prose and detector
// never drift. A FEN that doesn't parse as a legal position gives nothing:
// failures never enter the packet.
//
// Definitions (feat/1.0). "Own" is the side being measured, ranks are counted
// from that side, so the back rank is rank 1 for White and rank 8 for Black.
//
// kingSafety
//   shieldBroken  Only for a king on the wing (files a-c or f-h) on its back
//                 two ranks; castled kings always qualify. Take three files
//                 centred on the king, shifted inward at the edge (a king on
//                 h1 uses f, g, h), and count the files with no own pawn on
//                 the 2nd or 3rd rank: 0..3. A king on its 2nd rank uses the
//                 same two ranks, since the pawn beside it still shields it.
//                 A centre (d/e) or advanced king has no shield to break and
//                 gets 0; its exposure shows in the other king counts.
//   luft          The king has a flight square: adjacent, not holding an own
//                 piece, and not attacked by the opponent (sliders see
//                 through the king's own square). From the back rank only
//                 squares off the back rank count, which is what luft means:
//                 a back-rank check can't mate it.
//   openLinesAtKing  Files among the king's file and its neighbours (clipped
//                 to the board) with no own pawn, so open or half-open for
//                 the attacker, plus diagonal rays leaving the king square
//                 that are at least two squares long and hold no own pawn.
//   zoneAttackers / zoneDefenders  The zone is the king square and its
//                 neighbours. Distinct non-king pieces (pawns included) of
//                 the opponent / own side whose attacks, with the current
//                 occupancy, reach at least one zone square.
// structure (square lists, a1..h8 order)
//   isolated      No own pawn on either adjacent file.
//   doubled       Every own pawn on a file holding two or more own pawns.
//   backward (v1) No own pawn on an adjacent file level with or behind it,
//                 and its stop square (one step ahead) is attacked by an
//                 enemy pawn. An isolated pawn can be backward too.
//   passed        No enemy pawn ahead of it on its own or an adjacent file.
// openFiles       Only files that aren't closed, a..h, keeping the block
//                 small. open: no pawns; halfOpenW: no white pawn but a black
//                 one (a file White can use); halfOpenB: the reverse.
// development     SUPPRESSED after move 15 (fullmove number above 15) or once
//                 both sides have castled: the opening is over and minor
//                 counts stop meaning anything. Otherwise per side
//                 minorsOff, the starting minor squares (b, c, f, g on the
//                 back rank) no longer holding their own starting piece
//                 (moved or taken), and castled: the king on its back rank on
//                 files a-c or g-h with no castling rights left.
// activity        Mobility of knights, bishops, rooks and queens: squares
//                 attacked that don't hold an own piece, ignoring pins and
//                 whose turn it is, so both sides are measured alike. diff is
//                 w - b.

export const FEATURES_VERSION = 'feat/1.0'
export const BACKWARD_DEF = 'v1'
export const FEATURES_MAX_BYTES = 4096
export const DEVELOPMENT_LAST_MOVE = 15
export const ACTIVITY_DELTA_MIN = 5

export type Side = 'w' | 'b'
export type Cause = 'best' | 'played' | 'tried'
export type FileState = 'open' | 'halfOpenW' | 'halfOpenB' | 'closed'

export interface KingSafety {
  shieldBroken: number
  luft: boolean
  openLinesAtKing: number
  zoneAttackers: number
  zoneDefenders: number
}

export interface Structure {
  isolated: string[]
  doubled: string[]
  backward: string[]
  passed: string[]
}

export interface OpenFile {
  file: string
  state: FileState
}

export interface SideDevelopment {
  minorsOff: number
  castled: boolean
}

export interface Activity {
  w: number
  b: number
  diff: number
}

export interface Features {
  kingSafety: Record<Side, KingSafety>
  structure: Record<Side, Structure>
  openFiles: OpenFile[]
  development: Record<Side, SideDevelopment> | 'SUPPRESSED'
  activity: Activity
  backwardDef: typeof BACKWARD_DEF
  detectorVersion: typeof FEATURES_VERSION
}

export type DeltaFeature = 'openFiles' | 'passed' | 'shieldBroken' | 'luft' | 'isolated' | 'backward' | 'doubled' | 'activity'
export type DeltaValue = OpenFile | number | boolean | string[] | Activity

export interface FeatureDelta {
  id: string
  feature: DeltaFeature
  side: Side
  causedBy: Cause
  before: DeltaValue
  after: DeltaValue
  backwardDef?: typeof BACKWARD_DEF
  detectorVersion: typeof FEATURES_VERSION
}

export interface FeatureBlock {
  before: Features
  after: Features
  deltas: FeatureDelta[]
}

// Most important first: the size cap drops from the end of this list
export const DELTA_PRIORITY: DeltaFeature[] = ['openFiles', 'passed', 'shieldBroken', 'luft', 'isolated', 'backward', 'doubled', 'activity']

const SIDES: Side[] = ['w', 'b']
const FILES = 'abcdefgh'
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white')
// Rank counted from `c`'s side, 0 = its back rank
const rel = (s: Square, c: Color) => (c === 'white' ? squareRank(s) : 7 - squareRank(s))
const fwd = (c: Color) => (c === 'white' ? 8 : -8)
const onFile = (set: SquareSet, f: number) => set.intersect(SquareSet.fromFile(f))
const adjacent = (f: number) => [f - 1, f + 1].filter(x => x >= 0 && x < 8)

function shieldBroken(pos: Chess, c: Color): number {
  const k = pos.board.kingOf(c)!
  const kf = squareFile(k)
  if (rel(k, c) > 1 || kf === 3 || kf === 4) return 0
  const pawns = pos.board.pieces(c, 'pawn')
  const centre = Math.min(Math.max(kf, 1), 6)
  let missing = 0
  for (let f = centre - 1; f <= centre + 1; f++) if (![...onFile(pawns, f)].some(s => rel(s, c) === 1 || rel(s, c) === 2)) missing++
  return missing
}

function luft(pos: Chess, c: Color): boolean {
  const k = pos.board.kingOf(c)!
  // Without the king, so a slider checking along a line covers the square behind it
  const occ = pos.board.occupied.without(k)
  for (const s of kingAttacks(k)) {
    if (pos.board[c].has(s)) continue
    if (rel(k, c) === 0 && rel(s, c) === 0) continue
    if (pos.kingAttackers(s, other(c), occ).isEmpty()) return true
  }
  return false
}

function openLinesAtKing(pos: Chess, c: Color): number {
  const k = pos.board.kingOf(c)!
  const pawns = pos.board.pieces(c, 'pawn')
  const kf = squareFile(k)
  let n = 0
  for (let f = Math.max(kf - 1, 0); f <= Math.min(kf + 1, 7); f++) if (onFile(pawns, f).isEmpty()) n++
  for (const d of kingAttacks(k)) {
    if (squareFile(d) === kf || squareRank(d) === squareRank(k)) continue
    // The half of the diagonal from the king through d
    let half = SquareSet.empty()
    for (const s of ray(k, d)) if (s === d || between(k, s).has(d)) half = half.with(s)
    if (half.size() >= 2 && !half.intersects(pawns)) n++
  }
  return n
}

function zoneCounts(pos: Chess, c: Color): { zoneAttackers: number; zoneDefenders: number } {
  const k = pos.board.kingOf(c)!
  const zone = kingAttacks(k).with(k)
  let zoneAttackers = 0
  let zoneDefenders = 0
  for (const [s, p] of pos.board) {
    if (p.role === 'king' || !attacks(p, s, pos.board.occupied).intersects(zone)) continue
    if (p.color === c) zoneDefenders++
    else zoneAttackers++
  }
  return { zoneAttackers, zoneDefenders }
}

export function kingSafetyOf(pos: Chess, c: Color): KingSafety {
  return { shieldBroken: shieldBroken(pos, c), luft: luft(pos, c), openLinesAtKing: openLinesAtKing(pos, c), ...zoneCounts(pos, c) }
}

export function structureOf(pos: Chess, c: Color): Structure {
  const mine = pos.board.pieces(c, 'pawn')
  const theirs = pos.board.pieces(other(c), 'pawn')
  const out: Structure = { isolated: [], doubled: [], backward: [], passed: [] }
  for (const s of mine) {
    const f = squareFile(s)
    const r = rel(s, c)
    const adj = adjacent(f)
    if (adj.every(a => onFile(mine, a).isEmpty())) out.isolated.push(makeSquare(s))
    if (onFile(mine, f).size() >= 2) out.doubled.push(makeSquare(s))
    const supported = adj.some(a => [...onFile(mine, a)].some(t => rel(t, c) <= r))
    // Enemy pawns hitting the stop square sit where our pawn there would capture
    if (!supported && pawnAttacks(c, s + fwd(c)).intersects(theirs)) out.backward.push(makeSquare(s))
    if (![f, ...adj].some(a => [...onFile(theirs, a)].some(t => rel(t, c) > r))) out.passed.push(makeSquare(s))
  }
  return out
}

export function fileStates(pos: Chess): FileState[] {
  const states: FileState[] = []
  for (let f = 0; f < 8; f++) {
    const w = !onFile(pos.board.pieces('white', 'pawn'), f).isEmpty()
    const b = !onFile(pos.board.pieces('black', 'pawn'), f).isEmpty()
    states.push(!w && !b ? 'open' : !w ? 'halfOpenW' : !b ? 'halfOpenB' : 'closed')
  }
  return states
}

const MINOR_START: [number, Role][] = [
  [1, 'knight'],
  [2, 'bishop'],
  [5, 'bishop'],
  [6, 'knight'],
]

function castled(pos: Chess, c: Color): boolean {
  const k = pos.board.kingOf(c)!
  const f = squareFile(k)
  return rel(k, c) === 0 && (f <= 2 || f >= 6) && !pos.castles.castlingRights.intersects(SquareSet.backrank(c))
}

export function developmentOf(pos: Chess): Features['development'] {
  if (pos.fullmoves > DEVELOPMENT_LAST_MOVE || (castled(pos, 'white') && castled(pos, 'black'))) return 'SUPPRESSED'
  const side = (c: Color): SideDevelopment => {
    const back = c === 'white' ? 0 : 56
    const minorsOff = MINOR_START.filter(([f, role]) => {
      const p = pos.board.get(back + f)
      return !p || p.color !== c || p.role !== role
    }).length
    return { minorsOff, castled: castled(pos, c) }
  }
  return { w: side('white'), b: side('black') }
}

function mobility(pos: Chess, c: Color): number {
  let n = 0
  for (const [s, p] of pos.board) {
    if (p.color !== c || p.role === 'pawn' || p.role === 'king') continue
    n += attacks(p, s, pos.board.occupied).diff(pos.board[c]).size()
  }
  return n
}

export function activityOf(pos: Chess): Activity {
  const w = mobility(pos, 'white')
  const b = mobility(pos, 'black')
  return { w, b, diff: w - b }
}

export function featuresOfPos(pos: Chess): Features {
  const per = <T>(fn: (p: Chess, c: Color) => T): Record<Side, T> => ({ w: fn(pos, 'white'), b: fn(pos, 'black') })
  return {
    kingSafety: per(kingSafetyOf),
    structure: per(structureOf),
    openFiles: fileStates(pos)
      .map((state, f) => ({ file: FILES[f], state }))
      .filter(x => x.state !== 'closed'),
    development: developmentOf(pos),
    activity: activityOf(pos),
    backwardDef: BACKWARD_DEF,
    detectorVersion: FEATURES_VERSION,
  }
}

export function featuresOf(fen: string): Features | undefined {
  const pos = fromFen(fen)
  return pos && featuresOfPos(pos)
}

const stateAt = (f: Features, file: string): FileState => f.openFiles.find(x => x.file === file)?.state ?? 'closed'

// Meaningful changes from `before` to `after`, caused by `side`'s move.
// openFiles: any file whose state changed; the delta's side is the side the
// file is now half-open for, else the mover. shieldBroken: any change.
// luft: gained or lost. Structure: a list that grew (a new passed, isolated,
// backward or doubled pawn); a pawn that just advanced keeps its count and
// isn't news. activity: diff moved by ACTIVITY_DELTA_MIN or more; the side
// is the one it moved toward. Ids run fd1, fd2, … in emission order.
export function deltas(before: Features, after: Features, causedBy: Cause, side: Side): FeatureDelta[] {
  const out: Omit<FeatureDelta, 'id'>[] = []
  const add = (feature: DeltaFeature, s: Side, b: DeltaValue, a: DeltaValue) =>
    out.push({ feature, side: s, causedBy, before: b, after: a, ...(feature === 'backward' ? { backwardDef: BACKWARD_DEF } : {}), detectorVersion: FEATURES_VERSION })

  for (const file of FILES) {
    const b = stateAt(before, file)
    const a = stateAt(after, file)
    if (a !== b) add('openFiles', a === 'halfOpenW' ? 'w' : a === 'halfOpenB' ? 'b' : side, { file, state: b }, { file, state: a })
  }
  for (const s of SIDES) {
    const kb = before.kingSafety[s]
    const ka = after.kingSafety[s]
    if (kb.shieldBroken !== ka.shieldBroken) add('shieldBroken', s, kb.shieldBroken, ka.shieldBroken)
    if (kb.luft !== ka.luft) add('luft', s, kb.luft, ka.luft)
    for (const kind of ['passed', 'isolated', 'backward', 'doubled'] as const) {
      const b = before.structure[s][kind]
      const a = after.structure[s][kind]
      if (a.length > b.length) add(kind, s, b, a)
    }
  }
  const move = after.activity.diff - before.activity.diff
  if (Math.abs(move) >= ACTIVITY_DELTA_MIN) add('activity', move > 0 ? 'w' : 'b', before.activity, after.activity)
  return out.map((d, i) => ({ id: `fd${i + 1}`, ...d }))
}

export const byteSize = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length

// Drops the lowest-priority deltas (latest first within a kind) until the
// block fits, then renumbers so ids stay fd1, fd2, … A block that can't fit
// even with no deltas is refused.
export function capBlock(block: FeatureBlock, maxBytes = FEATURES_MAX_BYTES): FeatureBlock | undefined {
  let ds = [...block.deltas]
  const fits = () => byteSize({ ...block, deltas: ds }) <= maxBytes
  while (!fits() && ds.length) {
    let worst = ds.length - 1
    for (let i = ds.length - 1; i >= 0; i--) if (DELTA_PRIORITY.indexOf(ds[i].feature) > DELTA_PRIORITY.indexOf(ds[worst].feature)) worst = i
    ds = ds.filter((_, i) => i !== worst)
  }
  if (!fits()) return undefined
  return { ...block, deltas: ds.map((d, i) => ({ ...d, id: `fd${i + 1}` })) }
}

// The packet's features block for one move: the mover is the side to move
// in `fenBefore`
export function featureBlock(fenBefore: string, fenAfter: string, causedBy: Cause, maxBytes = FEATURES_MAX_BYTES): FeatureBlock | undefined {
  const pre = fromFen(fenBefore)
  const post = fromFen(fenAfter)
  if (!pre || !post) return undefined
  const before = featuresOfPos(pre)
  const after = featuresOfPos(post)
  return capBlock({ before, after, deltas: deltas(before, after, causedBy, pre.turn === 'white' ? 'w' : 'b') }, maxBytes)
}
