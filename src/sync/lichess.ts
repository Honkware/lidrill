import type { Game, Result } from '../db'
import { pgnMoves } from './pgn'

// The subset of the NDJSON game export lidrill reads
interface LichessGame {
  id: string
  variant: string
  speed: string
  status: string
  createdAt: number
  winner?: 'white' | 'black'
  players: Record<'white' | 'black', { user?: { id: string }; rating?: number }>
  opening?: { eco: string; name: string }
  clocks?: number[]
  pgn: string
}

const SKIPPED_STATUS = new Set(['created', 'started', 'aborted', 'noStart', 'unknownFinish'])

// First import stops at the newest FIRST_SYNC_MAX games; at ~6 s of analysis
// each that's already 20 minutes of engine time.
export const FIRST_SYNC_MAX = 200

export function exportUrl(user: string, since?: number): string {
  const params = new URLSearchParams({ pgnInJson: 'true', clocks: 'true', opening: 'true', finished: 'true' })
  if (since) params.set('since', String(since))
  else params.set('max', String(FIRST_SYNC_MAX))
  return `https://lichess.org/api/games/user/${encodeURIComponent(user)}?${params}`
}

export function fromLichess(g: LichessGame, user: string): Game | null {
  if (g.variant !== 'standard' || SKIPPED_STATUS.has(g.status)) return null
  const color = g.players.white.user?.id === user.toLowerCase() ? 'white' : 'black'
  if (g.players[color].user?.id !== user.toLowerCase()) return null
  const moves = pgnMoves(g.pgn)
  if (!moves) return null
  const result: Result = !g.winner ? 'draw' : g.winner === color ? 'win' : 'loss'
  return {
    id: `lichess:${g.id}`,
    site: 'lichess',
    url: `https://lichess.org/${g.id}`,
    pgn: g.pgn,
    color,
    result,
    rating: g.players[color].rating ?? 0,
    speed: g.speed === 'correspondence' ? 'daily' : g.speed,
    eco: g.opening?.eco ?? '',
    opening: g.opening?.name ?? '',
    playedAt: g.createdAt,
    moves,
    termination: g.status,
    clocks: g.clocks,
  }
}

// Streams the export so a long history doesn't sit in memory as one string.
export async function* fetchLichessGames(
  user: string,
  since: number | undefined,
  token?: string,
  fetchFn: typeof fetch = fetch,
): AsyncGenerator<Game> {
  const res = await fetchFn(exportUrl(user, since), {
    headers: { Accept: 'application/x-ndjson', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (res.status === 404) throw new Error(`Lichess has no games for "${user}". Check the spelling, or sign in if your games are private.`)
  if (!res.ok || !res.body) throw new Error(`Lichess export failed (HTTP ${res.status}). Try again in a minute.`)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += value
    const lines = buffer.split('\n')
    buffer = done ? '' : lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      const game = fromLichess(JSON.parse(line), user)
      if (game) yield game
    }
    if (done) return
  }
}
