import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import type { Color } from 'chessops/types'
import { makeSquare } from 'chessops/util'

// What the rules alone say about a position, before any
// engine runs. A position that fails the validity gate never reaches the
// engine; rule-draw state can overrule an evaluation.

export type Validity = { ok: true; pos: Chess } | { ok: false; reason: string }

// Kings present and apart, the side not to move not in check, no pawns on the
// back ranks, reachable material, a sane en passant square. chessops checks
// the first three; the rest are counted here (a bare FEN load accepts
// positions that crash the engine).
export function validPosition(fen: string): Validity {
  const setup = parseFen(fen)
  if (setup.isErr) return { ok: false, reason: 'unreadable FEN' }
  const pos = Chess.fromSetup(setup.value)
  if (pos.isErr) return { ok: false, reason: `illegal position (${pos.error.message})` }
  const p = pos.value
  for (const color of ['white', 'black'] as Color[]) {
    const pawns = p.board.pieces(color, 'pawn').size()
    if (pawns > 8) return { ok: false, reason: `${color} has more than 8 pawns` }
    // Every piece beyond the starting set needs a promoted pawn
    const extra =
      Math.max(0, p.board.pieces(color, 'queen').size() - 1) +
      Math.max(0, p.board.pieces(color, 'rook').size() - 2) +
      Math.max(0, p.board.pieces(color, 'bishop').size() - 2) +
      Math.max(0, p.board.pieces(color, 'knight').size() - 2)
    if (pawns + extra > 8) return { ok: false, reason: `${color} has more promoted pieces than missing pawns` }
  }
  if (p.epSquare !== undefined) {
    const rank = p.epSquare >> 3
    if (rank !== (p.turn === 'white' ? 5 : 2)) return { ok: false, reason: 'en passant square on the wrong rank' }
  }
  return { ok: true, pos: p }
}

export interface GameState {
  halfmoveClock: number
  canClaimFifty: boolean
  seventyFiveApplies: boolean
  occurrenceCount: number
  canClaimThreefold: boolean
  isFivefold: boolean
  insufficientMaterial: boolean
  castlingRights: string
  epSquare: string | null
}

// Positions repeat by placement, side to move, castling rights and en
// passant; the move counters don't count (FIDE 9.2.2)
export const repetitionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ')

// The FEN as chessops writes it, so different FEN flavours of one position
// hash the same
export function canonicalFen(fen: string): string | undefined {
  const v = validPosition(fen)
  return v.ok ? makeFen(v.pos.toSetup()) : undefined
}

// `history` is every earlier position of the game (FENs); without it the
// repetition count is a lower bound of 1, never a guess
export function gameState(pos: Chess, history: string[] = []): GameState {
  const fen = makeFen(pos.toSetup())
  const key = repetitionKey(fen)
  const occurrenceCount = 1 + history.filter(h => repetitionKey(h) === key).length
  const castling = fen.split(' ')[2]
  return {
    halfmoveClock: pos.halfmoves,
    canClaimFifty: pos.halfmoves >= 100,
    seventyFiveApplies: pos.halfmoves >= 150,
    occurrenceCount,
    canClaimThreefold: occurrenceCount >= 3,
    isFivefold: occurrenceCount >= 5,
    insufficientMaterial: pos.isInsufficientMaterial(),
    castlingRights: castling === '-' ? '-' : castling,
    epSquare: pos.epSquare === undefined ? null : makeSquare(pos.epSquare),
  }
}

export type DrawRule = 'dead-draw' | 'claimable' | 'automatic' | undefined

// Which draw rule overrides the evaluation, if any
export function drawRule(g: GameState): DrawRule {
  if (g.insufficientMaterial) return 'dead-draw'
  if (g.seventyFiveApplies || g.isFivefold) return 'automatic'
  if (g.canClaimFifty || g.canClaimThreefold) return 'claimable'
  return undefined
}
