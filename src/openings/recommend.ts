import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { mastersAt } from '../analysis/book'
import { after, cpOf, PLAYABLE_CP, RECALL_DEPTH, type Search } from './cards'
import { norm } from './repertoire'

// The move the trainer teaches where the player has none of their own: the
// one masters play most, when Stockfish puts it within PLAYABLE_CP of its
// own best, and Stockfish's best otherwise or without the explorer. The
// search runs at the depth review judges moves at, so a recommended move is
// never one review would call a mistake. Only the most played move is
// checked; when it fails, Stockfish's move is taught rather than the
// masters' second choice.

export type MastersMoves = (moves: string[]) => Promise<Record<string, number> | undefined>

export async function recommend(moves: string[], masters: MastersMoves | undefined, engine: Search): Promise<string> {
  const pos = Chess.default()
  for (const m of moves) pos.play(parseUci(m)!)
  const fen = makeFen(pos.toSetup())
  const best = await engine.search(fen, RECALL_DEPTH)
  if (!best.pv[0]) throw new Error(`no move at ${fen}`)
  const top = norm(pos, best.pv[0])
  const counts = await masters?.(moves)
  const popular = counts && Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!popular) return top
  const p = norm(pos, popular)
  if (p === top || cpOf(best.eval) - (await after(engine, fen, p, RECALL_DEPTH)) <= PLAYABLE_CP) return p
  return top
}

// Masters' counts while the explorer answers. Signed out there are none,
// and after a failure (offline, rate limited, sign-in expired) the rest of
// the walk goes on with Stockfish alone, the way bookFor finishes a run.
export function mastersFor(token: string | undefined, fetchFn: typeof fetch = fetch): MastersMoves | undefined {
  if (!token) return undefined
  let down = false
  return async moves => {
    if (down) return undefined
    try {
      return (await mastersAt(moves, token, fetchFn)).moves
    } catch {
      down = true
      return undefined
    }
  }
}
