import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import type { Game, Puzzle } from '../db'
import { clampLevel } from '../maia'
import { cachedPolicy } from '../openings/policy'
import { norm } from '../openings/repertoire'

// Whether a person would find the answer: Maia-3's probability for the
// puzzle's first move, asked as a player a little stronger than the one who
// missed it. Stockfish says the move is best; this says it is a move people
// play. Answers go through the openings' policy cache, so a position is
// asked once per level.

// The player already missed the move at their own level, so the question is
// whether someone a class stronger plays it
export const FIND_EDGE = 300

// Under 1 in 100 at that level the move is the engine's, not a person's.
// TODO: tune on stored probabilities once puzzles carry them; 0.01 is a
// starting cut, not a measured one
export const MAIA_MIN_P = 0.01

export const findLevel = (rating: number) => clampLevel(rating + FIND_EDGE)

// The summed probability of the accepted first moves (one for an ordinary
// puzzle, two or three for a hold), or undefined when Maia can't be asked
export type Findable = (game: Game, ply: number, accepted: string[]) => Promise<number | undefined>

// After one failed request nothing more is asked for the rest of the run:
// offline analysis doesn't wait on a request per puzzle, and a visitor who
// hit the route's rate limit stops adding to it
export function maiaFindable(fetchFn: typeof fetch = fetch): Findable {
  let down = false
  return async (game, ply, accepted) => {
    if (down) return undefined
    const moves = game.moves.slice(0, ply - 1).map(m => m.uci)
    try {
      const replies = await cachedPolicy(findLevel(game.rating), fetchFn)(moves)
      const pos = Chess.default()
      for (const m of moves) pos.play(parseUci(m)!)
      // Stockfish writes castling as the king's two squares, the cache as king to rook
      const wanted = new Set(accepted.map(uci => norm(pos, uci)))
      return replies.filter(r => wanted.has(r.uci)).reduce((sum, r) => sum + r.p, 0)
    } catch {
      down = true
      return undefined
    }
  }
}

// For the day's queue: the puzzles a person is likelier to find come first.
// A puzzle Maia was never asked about is not held back.
export const moreFindable = (a: Pick<Puzzle, 'maiaP'>, b: Pick<Puzzle, 'maiaP'>) => (b.maiaP ?? 1) - (a.maiaP ?? 1)
