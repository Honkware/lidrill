import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import { db } from '../db'
import { clampLevel } from '../maia'
import { keyOf, norm } from './repertoire'

// What people at a rating play: Maia-3's probability for every legal move,
// from the server's /maia/policy, with the setting and temperature its
// /maia/move plays with. Answers are kept per position and level, so a tree
// is fetched once. Maia also sees the last few moves, so a transposition
// reuses an answer worked out from another move order; the difference is
// small next to the 5% cut the trees make.

export interface Reply {
  uci: string
  p: number
}

export type Policy = (moves: string[]) => Promise<Reply[]>

// The trees use the player's estimate rounded to 100, about the spacing of
// Maia's measured settings, so a few points of change after each game
// doesn't make every cached answer stale
export const LEVEL_STEP = 100

export const treeLevel = (rating: number) => clampLevel(Math.round(rating / LEVEL_STEP) * LEVEL_STEP)

// The Worker allows a visitor so many of these a minute, and the first walk
// of a big tree asks for more. Being told to slow down is no failure of the
// walk, so it waits and asks again instead of ending with an error the
// player did nothing to cause.
const SLOW_DOWN_MS = 15_000
const SLOW_DOWN_TRIES = 6

export async function fetchPolicy(moves: string[], level: number, fetchFn: typeof fetch = fetch, wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<Reply[]> {
  const ask = () => fetchFn('/api/maia/policy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves, level }) })
  let res = await ask()
  for (let i = 0; res.status === 429 && i < SLOW_DOWN_TRIES; i++) {
    await wait(SLOW_DOWN_MS)
    res = await ask()
  }
  const body = (await res.json().catch(() => ({}))) as { moves?: Reply[]; error?: string }
  if (!res.ok || !body.moves) throw new Error(body.error ?? 'Maia isn’t available right now.')
  return body.moves
}

export function cachedPolicy(level: number, fetchFn: typeof fetch = fetch): Policy {
  return async moves => {
    const pos = Chess.default()
    for (const m of moves) pos.play(parseUci(m)!)
    const key = `${level}|${keyOf(pos)}`
    const hit = await db.policy.get(key)
    if (hit) return hit.moves
    const replies = (await fetchPolicy(moves, level, fetchFn)).map(r => ({ uci: norm(pos, r.uci), p: r.p }))
    await db.policy.put({ key, moves: replies })
    return replies
  }
}
