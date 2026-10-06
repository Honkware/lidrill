import type { Game, Result } from '../db'
import { pgnHeader, pgnMoves } from './pgn'

interface ChesscomPlayer {
  username: string
  rating: number
  result: string
}

interface ChesscomGame {
  url: string
  pgn?: string
  rules: string
  time_class: string
  end_time: number
  white: ChesscomPlayer
  black: ChesscomPlayer
  eco?: string
}

const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'])

export function fromChesscom(g: ChesscomGame, user: string): Game | null {
  if (g.rules !== 'chess' || !g.pgn) return null
  const me = user.toLowerCase()
  const color = g.white.username.toLowerCase() === me ? 'white' : 'black'
  if (g[color].username.toLowerCase() !== me) return null
  const moves = pgnMoves(g.pgn)
  if (!moves) return null
  const mine = g[color].result
  const theirs = g[color === 'white' ? 'black' : 'white'].result
  const result: Result = mine === 'win' ? 'win' : DRAWS.has(mine) ? 'draw' : 'loss'
  // The eco field is a URL like .../openings/Alapin-Sicilian-Defense-2...Qa5
  const slug = g.eco?.split('/openings/')[1] ?? ''
  return {
    id: `chesscom:${g.url.split('/').pop()}`,
    site: 'chesscom',
    url: g.url,
    pgn: g.pgn,
    color,
    result,
    rating: g[color].rating,
    speed: g.time_class,
    eco: pgnHeader(g.pgn, 'ECO') ?? '',
    opening: decodeURIComponent(slug).replace(/-/g, ' '),
    playedAt: g.end_time * 1000,
    moves,
    termination: result === 'win' ? theirs : mine,
  }
}

// Chess.com asks for serial requests and blocks heavy archive crawls, so
// months that can no longer change are skipped and the rest fetched one by
// one. cache: 'no-cache' lets the browser revalidate with the ETag it already
// has, without a custom header (which would need a CORS preflight).
export async function fetchChesscomGames(
  user: string,
  doneMonths: string[],
  now: Date,
  fetchFn: typeof fetch = fetch,
): Promise<{ games: Game[]; doneMonths: string[] }> {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games`
  const res = await fetchFn(`${base}/archives`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`chess.com archives: HTTP ${res.status}`)
  const { archives } = (await res.json()) as { archives: string[] }
  const current = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const done = new Set(doneMonths)
  const games: Game[] = []
  for (const url of archives) {
    const month = url.split('/games/')[1]
    if (done.has(month)) continue
    const monthRes = await fetchFn(url, { cache: 'no-cache' })
    if (!monthRes.ok) throw new Error(`chess.com ${month}: HTTP ${monthRes.status}`)
    const data = (await monthRes.json()) as { games: ChesscomGame[] }
    for (const g of data.games) {
      const game = fromChesscom(g, user)
      if (game) games.push(game)
    }
    if (month < current) done.add(month)
  }
  return { games, doneMonths: [...done].sort() }
}
