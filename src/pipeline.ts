import { bookLength, FALLBACK_BOOK_PLIES } from './analysis/book'
import { Engine, workerEngine } from './analysis/engine'
import { eachWithEngine, runQueue, type Progress } from './analysis/queue'
import { db, type Game, type Profile } from './db'
import { fetchAccount } from './lichess/api'
import { failedPuzzles, fetchActivity, fetchDashboard, fetchThemePuzzles, snapshot, weakThemes } from './lichess/puzzles'
import { journalFor, worst5Cutoff } from './metrics'
import { BAND_DEFAULTS, computeBand } from './profile'
import { findPractice } from './practice'
import { GENERATOR_VERSION, generatePuzzles } from './puzzles/generate'
import { calibrate } from './report'
import { SignInExpired } from './sync/lichess'
import { sync } from './sync/sync'
import { DAILY_CAP } from './train'

export interface Accounts {
  lichessUser?: string
  lichessToken?: string
  chesscomUser?: string
}

// One engine for interactive use (drills), and a pool for background
// analysis: each pool engine takes whole games, so results match a single
// engine while using more of the device's cores. One core is left free for
// the page; four is plenty and keeps phones from cooking.
let engine: Engine | undefined
export const getEngine = () => (engine ??= new Engine(() => workerEngine()))

let pool: Engine[] | undefined
export const poolSize = () => Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
const getPool = () => (pool ??= Array.from({ length: poolSize() }, () => new Engine(workerEngine())))

// Merges into the stored profile and recomputes the band. A band change
// re-defaults the thresholds and is logged in bandHistory.
export async function saveProfile(patch: Partial<Omit<Profile, 'id'>>): Promise<Profile> {
  const old = await db.profile.get('me')
  const merged = { ...old, ...patch }
  const band = computeBand(await db.games.toArray(), merged.ratings)
  const keep = old?.band === band
  const profile: Profile = {
    ...merged,
    id: 'me',
    band,
    bandHistory: keep ? old.bandHistory : [...(old?.bandHistory ?? []), { band, at: Date.now() }],
    swingThresholdCp: keep ? old.swingThresholdCp : BAND_DEFAULTS[band].swingThresholdCp,
    marginCp: keep ? old.marginCp : BAND_DEFAULTS[band].marginCp,
  }
  await db.profile.put(profile)
  return profile
}

// A different Lichess account signed in on this browser. Its games aren't
// ours, so drop the old account's games and puzzles; Chess.com data stays.
export async function forgetLichessAccount(): Promise<void> {
  await db.transaction('rw', [db.games, db.puzzles, db.syncState, db.journal, db.liPuzzle, db.profile, db.practice, db.explanations], async () => {
    await db.practice.filter(p => p.gameId.startsWith('lichess:')).delete()
    await db.explanations.filter(e => e.puzzleId.startsWith('lichess:')).delete()
    await db.games.where('site').equals('lichess').delete()
    await db.puzzles.filter(p => p.gameId.startsWith('lichess:') || p.source === 'lichess').delete()
    await db.journal.filter(j => j.gameId.startsWith('lichess:')).delete()
    await db.syncState.delete('lichess')
    await db.liPuzzle.clear()
    const old = await db.profile.get('me')
    if (old) await db.profile.put({ ...old, ratings: undefined, weakThemes: undefined, puzzleActivityAt: undefined })
  })
}

const NINETY_DAYS = 90 * 24 * 3600 * 1000

// Ratings, puzzle dashboard and failed puzzles. None of it is needed to
// train, so anything but an expired sign-in is skipped quietly.
async function refreshLichess(token: string, now: Date): Promise<Partial<Profile>> {
  const patch: Partial<Profile> = {}
  const quietly = async (f: () => Promise<void>) => {
    try {
      await f()
    } catch (e) {
      if (e instanceof SignInExpired) throw e
      console.warn(e)
    }
  }
  await quietly(async () => {
    patch.ratings = (await fetchAccount(token)).perfs
  })
  await quietly(async () => {
    const dash = await fetchDashboard(token)
    await db.liPuzzle.put(snapshot(dash, now))
    patch.weakThemes = weakThemes(dash)
  })
  await quietly(async () => {
    const old = await db.profile.get('me')
    const since = old?.puzzleActivityAt ?? +now - NINETY_DAYS
    const activity = await fetchActivity(token, since + 1)
    const known = new Set(await db.puzzles.where('id').anyOf(activity.map(a => `lichess:${a.puzzle.id}`)).primaryKeys())
    await db.puzzles.bulkAdd(failedPuzzles(activity, now).filter(p => !known.has(p.id)))
    // Solved on Lichess since: retire the ones not yet started here
    const solved = activity.filter(a => a.win).map(a => `lichess:${a.puzzle.id}`)
    await db.puzzles.where('id').anyOf(solved).filter(p => p.card.reps === 0).delete()
    patch.puzzleActivityAt = Math.max(since, ...activity.map(a => a.date))
  })
  return patch
}

// When the player's own puzzles won't cover the next week, top up with new
// Lichess puzzles in their weak themes. The queue keeps
// these to 30% of a day; this only makes sure some exist.
async function topUpExternal(token: string, profile: Profile, now: Date): Promise<void> {
  const themes = profile.weakThemes?.map(t => t.theme) ?? []
  if (!themes.length) return
  const week = new Date(+now + 7 * 24 * 3600 * 1000)
  const supply = await db.puzzles.where('card.due').belowOrEqual(week).count()
  const unseen = await db.puzzles.filter(p => p.source === 'lichess' && p.card.reps === 0).count()
  if (supply >= 7 * DAILY_CAP || unseen >= 30) return
  for (const theme of themes.slice(0, 3)) {
    try {
      const puzzles = await fetchThemePuzzles(token, theme, 5)
      const known = new Set(await db.puzzles.where('id').anyOf(puzzles.map(p => p.id)).primaryKeys())
      await db.puzzles.bulkAdd(puzzles.filter(p => !known.has(p.id)))
    } catch (e) {
      if (e instanceof SignInExpired) throw e
      console.warn(e)
    }
  }
}

// Journal entries for every analyzed game. Re-run when the band changes,
// since the hang definition depends on it; notes and confirmations stay.
export async function rebuildJournal(profile: Profile): Promise<void> {
  const games = await db.games.filter(g => g.analyzedAt !== undefined).toArray()
  const cutoff = worst5Cutoff(games)
  const old = new Map((await db.journal.toArray()).map(j => [j.gameId, j]))
  await db.journal.bulkPut(games.map(g => journalFor(g, profile.band, cutoff, old.get(g.id))))
}

// New drill positions only: stored ones keep their streaks
async function addPractice(games: Game[]): Promise<void> {
  const found = games.flatMap(findPractice)
  const known = new Set(await db.practice.where('id').anyOf(found.map(p => p.id)).primaryKeys())
  await db.practice.bulkAdd(found.filter(p => !known.has(p.id)))
}

function bookFor(token?: string): (game: Game) => Promise<number> {
  let explorerDown = false
  return async game => {
    if (!token || explorerDown) return FALLBACK_BOOK_PLIES
    try {
      return await bookLength(game.moves, token)
    } catch (e) {
      if (e instanceof SignInExpired) throw e
      // Rate limited or offline: finish this run with the fixed count
      explorerDown = true
      return FALLBACK_BOOK_PLIES
    }
  }
}

export async function syncAndAnalyze(
  accounts: Accounts,
  onStatus: (s: string) => void,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<void> {
  const now = new Date()
  onStatus('Fetching games…')
  const added = await sync(accounts)
  const lichess = accounts.lichessToken ? await refreshLichess(accounts.lichessToken, now) : {}
  const before = await db.profile.get('me')
  let profile = await saveProfile({ lichessUser: accounts.lichessUser, chesscomUser: accounts.chesscomUser, ...lichess })
  const calibrated = calibrate(profile, await db.reviews.toArray(), now)
  if (calibrated) await db.profile.put((profile = calibrated))
  if (before?.band !== profile.band || !(await db.journal.count())) await rebuildJournal(profile)
  if (!(await db.practice.count())) await addPractice(await db.games.filter(g => g.analyzedAt !== undefined).toArray())
  if (accounts.lichessToken) await topUpExternal(accounts.lichessToken, profile, now)

  onStatus(`Added ${added.lichess + added.chesscom} games. Analyzing…`)
  // The Advanced hang depends on all analyzed games, so it's refreshed as
  // games come in and the journal is redone at the end
  let cutoff = worst5Cutoff(await db.games.filter(g => g.analyzedAt !== undefined).toArray())
  let sinceCutoff = 0
  const genOpts = { swingThresholdCp: profile.swingThresholdCp, marginCp: profile.marginCp, depth: 16, maxSolutionMoves: 3 }
  await runQueue(getPool(), { depth: 14, bookPlies: bookFor(accounts.lichessToken) }, onProgress, signal, async (game, eng) => {
    await db.puzzles.bulkPut(await generatePuzzles(game, eng, genOpts))
    await db.games.update(game.id, { puzzlesVersion: GENERATOR_VERSION })
    if (profile.band === 'advanced' && ++sinceCutoff >= 10) {
      cutoff = worst5Cutoff(await db.games.filter(g => g.analyzedAt !== undefined).toArray())
      sinceCutoff = 0
    }
    await db.journal.put(journalFor(game, profile.band, cutoff, await db.journal.get(game.id)))
    await addPractice([game])
  })
  if (profile.band === 'advanced') await rebuildJournal(profile)

  // Games analyzed by an older generator get another look; puzzles they
  // already have keep their schedule
  const stale = (await db.games.filter(g => g.analyzedAt !== undefined && (g.puzzlesVersion ?? 1) < GENERATOR_VERSION).toArray()).sort(
    (a, b) => b.playedAt - a.playedAt,
  )
  let rechecked = 0
  await eachWithEngine(
    stale,
    getPool(),
    async (game, eng) => {
      onStatus(`Looking for more puzzles in games you've already played (${++rechecked}/${stale.length})…`)
      const found = await generatePuzzles(game, eng, genOpts)
      const known = new Set(await db.puzzles.where('gameId').equals(game.id).primaryKeys())
      await db.puzzles.bulkAdd(found.filter(p => !known.has(p.id)))
      await db.games.update(game.id, { puzzlesVersion: GENERATOR_VERSION })
    },
    signal,
  )
  if (signal.aborted) return
  onStatus('Done.')
}
