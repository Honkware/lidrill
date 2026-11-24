import { db, type Game } from '../db'
import { analyzeMoves } from './analyze'
import type { Engine } from './engine'
import { shareable, withShared, type Shared } from './shared'

export interface QueueOptions {
  depth: number
  // Book length for a game: masters explorer when signed in, else a fixed count
  bookPlies: (game: Game) => Promise<number>
  // Evals other browsers have already searched (./shared.ts)
  shared?: Shared
}

export interface Progress {
  done: number
  total: number
}

// Runs fn over items with one engine each, in order of the list: every
// engine takes the next item as soon as it's free. Results are the same as
// one engine doing it all, since each item stays on a single engine.
export async function eachWithEngine<T>(
  items: T[],
  engines: Engine[],
  fn: (item: T, engine: Engine) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0
  await Promise.all(
    engines.map(async engine => {
      while (next < items.length && !signal?.aborted) await fn(items[next++], engine)
    }),
  )
}

// Newest games first, so the trainer can start before the backlog is done
//Each game is saved as soon as it's analyzed; stopping
// mid-game loses only the games in flight.
export async function runQueue(
  engines: Engine[],
  opts: QueueOptions,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
  onGame?: (game: Game, engine: Engine) => Promise<void>,
): Promise<void> {
  const pending = await db.games.filter(g => g.analyzedAt === undefined).toArray()
  pending.sort((a, b) => b.playedAt - a.playedAt)
  const total = pending.length
  let done = 0
  onProgress({ done, total })
  const known = (await opts.shared?.get(pending, opts.depth)) ?? new Map()
  await eachWithEngine(
    pending,
    engines,
    async (game, engine) => {
      const bookPlies = await opts.bookPlies(game)
      const before = known.has(game.id) ? withShared(game.moves, known.get(game.id)!) : game.moves
      const moves = await analyzeMoves(before, engine, { depth: opts.depth, bookPlies })
      if (signal?.aborted) return
      // Uploaded only when this device found evals the server didn't have
      const evals = (ms: typeof moves) => ms.filter(m => m.eval).length
      if (shareable(game) && evals(moves) > evals(before)) void opts.shared?.put(moves, opts.depth)
      const analyzed = { ...game, moves, analyzedAt: Date.now() }
      await db.games.put(analyzed)
      await onGame?.(analyzed, engine)
      onProgress({ done: ++done, total })
    },
    signal,
  )
}
