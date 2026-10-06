import { parsePgn, startingPosition } from 'chessops/pgn'
import { parseSan } from 'chessops/san'
import { makeUci } from 'chessops/util'
import type { Move } from '../db'

// Mainline moves with UCI, or null if the PGN doesn't replay cleanly. Games
// that don't replay are skipped rather than half-imported.
export function pgnMoves(pgn: string): Move[] | null {
  const game = parsePgn(pgn)[0]
  if (!game) return null
  const start = startingPosition(game.headers)
  if (start.isErr) return null
  const pos = start.value
  const moves: Move[] = []
  for (const node of game.moves.mainline()) {
    const move = parseSan(pos, node.san)
    if (!move) return null
    moves.push({ san: node.san, uci: makeUci(move) })
    pos.play(move)
  }
  return moves
}

export function pgnHeader(pgn: string, name: string): string | undefined {
  return pgn.match(new RegExp(`^\\[${name} "([^"]*)"\\]`, 'm'))?.[1]
}
