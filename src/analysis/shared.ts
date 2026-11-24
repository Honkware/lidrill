import type { Eval, Game, Move } from '../db'
import { sha256Hex } from '../server/sha256'

// Engine evals shared between browsers. A game's evals are the same for
// whoever analyses it, so before searching, the queue asks the server for
// the games it has pending, and after searching a game it uploads what it
// found. A player who opens the site on a second device, or meets a game
// their opponent already analysed here, gets the evals without the search.
// A game is sent as its moves alone. The puzzles are still made on the
// device, since they depend on the player's band and thresholds.

// The eval after each move, null where there is none
export type SharedEvals = (Eval | null)[]

export interface Shared {
  get(games: Game[], depth: number): Promise<Map<string, SharedEvals>> // by game id
  put(moves: Move[], depth: number): Promise<void>
}

// The server takes this many keys in one request and this many plies in a
// game (MAX_EVAL_KEYS and MAX_PLIES in server/app.py)
const KEYS = 500
const PLIES = 600

// Has to match evals_key in server/app.py
export const evalsKey = (moves: Move[], depth: number) => sha256Hex(`${depth}:${moves.map(m => m.uci).join(' ')}`)

// Games against Maia exist on one device only, and a game Lichess analysed
// arrives with its evals
export const shareable = (g: Game) => g.site !== 'maia' && !g.serverAnalysis && g.moves.length > 0 && g.moves.length <= PLIES

const isEval = (e: unknown): e is Eval | null =>
  e === null || (typeof e === 'object' && Object.values(e as object).every(Number.isInteger) && ('cp' in (e as object) || 'mate' in (e as object)))

// Evals the moves don't have yet, taken from the shared ones
export const withShared = (moves: Move[], evals: SharedEvals): Move[] => moves.map((m, i) => (m.eval || !evals[i] ? m : { ...m, eval: evals[i]! }))

const post = (path: string, body: unknown, fetchFn: typeof fetch) => fetchFn(`/api/evals/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// Analysis works without the server, so trouble reaching it means searching
// as before and is never shown
export const shared = (fetchFn: typeof fetch = fetch): Shared => ({
  async get(games, depth) {
    const out = new Map<string, SharedEvals>()
    const wanted = games.filter(shareable).map(g => ({ g, key: evalsKey(g.moves, depth) }))
    for (let i = 0; i < wanted.length; i += KEYS) {
      const chunk = wanted.slice(i, i + KEYS)
      try {
        const res = await post('get', { keys: chunk.map(w => w.key) }, fetchFn)
        if (!res.ok) return out
        const { found } = (await res.json()) as { found: Record<string, unknown> }
        for (const { g, key } of chunk) {
          const evals = found[key]
          if (Array.isArray(evals) && evals.length === g.moves.length && evals.every(isEval)) out.set(g.id, evals)
        }
      } catch {
        return out
      }
    }
    return out
  },
  async put(moves, depth) {
    await post('put', { depth, moves: moves.map(m => m.uci), evals: moves.map(m => m.eval ?? null) }, fetchFn).catch(() => {})
  },
})
