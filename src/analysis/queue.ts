import { db, type Game } from '../db'
import { analyzeMoves } from './analyze'
import type { Engine } from './engine'

export interface QueueOptions {
  depth: number
  // Book length for a game: masters explorer when signed in, else a fixed count
  bookPlies: (game: Game) => Promise<number>
}

export interface Progress {
  done: number
  total: number
}

// Newest games first, so the trainer can start before the backlog is done
//Each game is saved as soon as it's analyzed; stopping
// mid-game loses only that game's work.
export async function runQueue(
  engine: Engine,
  opts: QueueOptions,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
  onGame?: (game: Game) => Promise<void>,
): Promise<void> {
  const pending = await db.games.filter(g => g.analyzedAt === undefined).toArray()
  pending.sort((a, b) => b.playedAt - a.playedAt)
  const total = pending.length
  onProgress({ done: 0, total })
  for (const [i, game] of pending.entries()) {
    if (signal?.aborted) return
    const bookPlies = await opts.bookPlies(game)
    const moves = await analyzeMoves(game.moves, engine, { depth: opts.depth, bookPlies })
    if (signal?.aborted) return
    const analyzed = { ...game, moves, analyzedAt: Date.now() }
    await db.games.put(analyzed)
    await onGame?.(analyzed)
    onProgress({ done: i + 1, total })
  }
}
