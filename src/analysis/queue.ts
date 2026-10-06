import { db } from '../db'
import { analyzeMoves, type AnalyzeOptions } from './analyze'
import type { Engine } from './engine'

export interface Progress {
  done: number
  total: number
}

// Newest games first, so the trainer can start before the backlog is done
//Each game is saved as soon as it's analyzed; stopping
// mid-game loses only that game's work.
export async function runQueue(
  engine: Engine,
  opts: AnalyzeOptions,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const pending = await db.games.filter(g => g.analyzedAt === undefined).toArray()
  pending.sort((a, b) => b.playedAt - a.playedAt)
  const total = pending.length
  onProgress({ done: 0, total })
  for (const [i, game] of pending.entries()) {
    if (signal?.aborted) return
    const moves = await analyzeMoves(game.moves, engine, opts)
    if (signal?.aborted) return
    await db.games.update(game.id, { moves, analyzedAt: Date.now() })
    onProgress({ done: i + 1, total })
  }
}
