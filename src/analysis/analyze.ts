import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import type { Eval, Move } from '../db'
import type { Engine } from './engine'
import { judge } from './judge'

export interface AnalyzeOptions {
  depth: number
  // Plies treated as opening book: not judged, and their positions not
  // searched. falls back to 8 when the explorer isn't available.
  bookPlies: number
}

export const MATED = 10000

// Returns the moves with eval/judg/book filled in. Moves that already carry an
// eval aren't searched again. Positions are searched in order so a cancelled
// run leaves a clean prefix.
export async function analyzeMoves(moves: Move[], engine: Engine, opts: AnalyzeOptions): Promise<Move[]> {
  const pos = Chess.default()
  const fens: string[] = [makeFen(pos.toSetup())]
  const terminal: (Eval | undefined)[] = [undefined]
  for (const m of moves) {
    pos.play(parseUci(m.uci)!)
    fens.push(makeFen(pos.toSetup()))
    terminal.push(
      pos.isCheckmate() ? { cp: pos.turn === 'white' ? -MATED : MATED } : pos.isEnd() ? { cp: 0 } : undefined,
    )
  }

  const evals: (Eval | undefined)[] = []
  for (let i = Math.min(opts.bookPlies, moves.length); i < fens.length; i++) {
    if (terminal[i]) {
      evals[i] = terminal[i]
      continue
    }
    // Already known, e.g. from Lichess's server analysis
    const known = i > 0 ? moves[i - 1].eval : undefined
    if (known) {
      evals[i] = known
      continue
    }
    const { eval: e } = await engine.search(fens[i], opts.depth)
    // UCI scores are from the side to move; store white's view
    const whiteToMove = i % 2 === 0
    evals[i] = whiteToMove ? e : { cp: e.cp === undefined ? undefined : -e.cp, mate: e.mate === undefined ? undefined : -e.mate }
  }

  return moves.map((m, idx) => {
    const ply = idx + 1
    if (ply <= opts.bookPlies) return { ...m, book: true, eval: m.eval, judg: undefined }
    const prev = evals[ply - 1]
    const next = evals[ply]
    const mover = ply % 2 === 1 ? 'white' : 'black'
    // Delivering mate isn't judged, as on Lichess (the mated position has no eval there)
    const mates = Math.abs(terminal[ply]?.cp ?? 0) === MATED
    return { ...m, book: false, eval: next, judg: prev && next && !mates ? judge(prev, next, mover) : undefined }
  })
}
