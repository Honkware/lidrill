import { db, type Game, type Move } from '../db'
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

export interface Masters {
  moves: Record<string, number> // games per move
  opening?: { eco: string; name: string }
}

// Explorer answers are cached by move sequence; openings repeat a lot across
// one player's games, so most lookups after the first sync are local. Rows
// cached before the name was kept have no opening.
export async function mastersAt(play: string[], token: string, fetchFn: typeof fetch = fetch): Promise<Masters> {
  const key = play.join(',')
  const cached = await db.explorer.get(key)
  if (cached) return cached
  const url = `https://explorer.lichess.org/masters?play=${key}&moves=30&topGames=0`
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401) throw new SignInExpired()
  if (!res.ok) throw new Error(`explorer HTTP ${res.status}`)
  const data = (await res.json()) as { moves: ExplorerMove[]; opening?: { eco: string; name: string } | null }
  const moves = Object.fromEntries(data.moves.map(m => [m.uci, m.white + m.draws + m.black]))
  await db.explorer.put({ key, moves, opening: data.opening ?? undefined })
  return { moves, opening: data.opening ?? undefined }
}

// Number of leading plies that are book. Throws on network trouble so the
// caller can fall back to FALLBACK_BOOK_PLIES.
export async function bookLength(moves: Move[], token: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const limit = Math.min(MAX_PLIES, moves.length)
  for (let ply = 0; ply < limit; ply++) {
    const { moves: known } = await mastersAt(
      moves.slice(0, ply).map(m => m.uci),
      token,
      fetchFn,
    )
    if ((known[moves[ply].uci] ?? 0) < MIN_GAMES) return ply
  }
  return limit
}

// Book length per game for one analysis run. A game against Maia gets no
// fixed book: Maia plays like a person at its level, so a blunder on move 3
// is as much the player's own as one on move 30. Signed in, it uses the
// explorer like any other game.
export function bookFor(token?: string, fetchFn: typeof fetch = fetch): (game: Game) => Promise<number> {
  let explorerDown = false
  const fallback = (game: Game) => (game.site === 'maia' ? 0 : FALLBACK_BOOK_PLIES)
  return async game => {
    if (!token || explorerDown) return fallback(game)
    try {
      return await bookLength(game.moves, token, fetchFn)
    } catch (e) {
      if (e instanceof SignInExpired) throw e
      // Rate limited or offline: finish this run with the fixed count
      explorerDown = true
      return fallback(game)
    }
  }
}
