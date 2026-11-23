import { parseComment, parsePgn, startingPosition } from 'chessops/pgn'
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

// Centiseconds left after each mainline move, from the [%clk h:mm:ss.s]
// comments, or undefined unless every move has one
export function pgnClocks(pgn: string): number[] | undefined {
  const game = parsePgn(pgn)[0]
  if (!game) return undefined
  const clocks: number[] = []
  for (const node of game.moves.mainline()) {
    const clock = (node.comments ?? []).map(c => parseComment(c).clock).find(c => c !== undefined)
    if (clock === undefined) return undefined
    clocks.push(Math.round(clock * 100))
  }
  return clocks.length ? clocks : undefined
}

export function pgnHeader(pgn: string, name: string): string | undefined {
  return pgn.match(new RegExp(`^\\[${name} "([^"]*)"\\]`, 'm'))?.[1]
}
