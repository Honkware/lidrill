import { db, type Move } from '../db'
import { SignInExpired } from '../sync/lichess'

// Opening book from the Lichess masters database. A move is book
// while masters have played it at least MIN_GAMES times from that position;
// the first move that isn't ends the book. Popular amateur traps don't count,
// which is the point: a beginner's 4...Nf6?? in the Scholar's Mate should be
// judged, however often it's been played on Lichess.

export const FALLBACK_BOOK_PLIES = 8
const MIN_GAMES = 10
const MAX_PLIES = 30

interface ExplorerMove {
  uci: string
  white: number
  draws: number
  black: number
}

// Explorer answers are cached by move sequence; openings repeat a lot across
// one player's games, so most lookups after the first sync are local.
async function mastersMoves(play: string[], token: string, fetchFn: typeof fetch): Promise<Record<string, number>> {
  const key = play.join(',')
  const cached = await db.explorer.get(key)
  if (cached) return cached.moves
  const url = `https://explorer.lichess.org/masters?play=${key}&moves=30&topGames=0`
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401) throw new SignInExpired()
  if (!res.ok) throw new Error(`explorer HTTP ${res.status}`)
  const data = (await res.json()) as { moves: ExplorerMove[] }
  const moves = Object.fromEntries(data.moves.map(m => [m.uci, m.white + m.draws + m.black]))
  await db.explorer.put({ key, moves })
  return moves
}

// Number of leading plies that are book. Throws on network trouble so the
// caller can fall back to FALLBACK_BOOK_PLIES.
export async function bookLength(moves: Move[], token: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const limit = Math.min(MAX_PLIES, moves.length)
  for (let ply = 0; ply < limit; ply++) {
    const known = await mastersMoves(
      moves.slice(0, ply).map(m => m.uci),
      token,
      fetchFn,
    )
    if ((known[moves[ply].uci] ?? 0) < MIN_GAMES) return ply
  }
  return limit
}
