import { db, type Game } from '../db'
import { fetchChesscomGames } from './chesscom'
import { fetchLichessGames } from './lichess'

export interface SyncOptions {
  lichessUser?: string
  lichessToken?: string
  chesscomUser?: string
  fetchFn?: typeof fetch
  now?: Date
}

// Adds games that aren't stored yet. Stored games are never overwritten, so
// re-syncing can't wipe analysis.
async function addNew(games: Game[]): Promise<number> {
  if (!games.length) return 0
  const existing = new Set(await db.games.where('id').anyOf(games.map(g => g.id)).primaryKeys())
  const fresh = games.filter(g => !existing.has(g.id))
  await db.games.bulkAdd(fresh)
  return fresh.length
}

export async function sync(opts: SyncOptions): Promise<{ lichess: number; chesscom: number }> {
  const fetchFn = opts.fetchFn ?? fetch
  const added = { lichess: 0, chesscom: 0 }

  if (opts.lichessUser) {
    const user = opts.lichessUser
    const state = await db.syncState.get('lichess')
    const since = state?.user === user ? state.lastPlayedAt + 1 : undefined
    const games: Game[] = []
    for await (const game of fetchLichessGames(user, since, opts.lichessToken, fetchFn)) games.push(game)
    added.lichess = await addNew(games)
    const last = Math.max(since ?? 0, ...games.map(g => g.playedAt))
    await db.syncState.put({ site: 'lichess', user, lastPlayedAt: last, doneMonths: [] })
  }

  if (opts.chesscomUser) {
    const user = opts.chesscomUser
    const state = await db.syncState.get('chesscom')
    const doneMonths = state?.user === user ? state.doneMonths : []
    const res = await fetchChesscomGames(user, doneMonths, opts.now ?? new Date(), fetchFn)
    added.chesscom = await addNew(res.games)
    const last = Math.max(state?.lastPlayedAt ?? 0, ...res.games.map(g => g.playedAt))
    await db.syncState.put({ site: 'chesscom', user, lastPlayedAt: last, doneMonths: res.doneMonths })
  }

  return added
}
