import { Engine, workerEngine } from './analysis/engine'
import { runQueue, type Progress } from './analysis/queue'
import { db, type Profile } from './db'
import { BAND_DEFAULTS, computeBand } from './profile'
import { generatePuzzles } from './puzzles/generate'
import { sync } from './sync/sync'


let engine: Engine | undefined
const getEngine = () => (engine ??= new Engine(workerEngine()))

export async function saveProfile(users: { lichessUser?: string; chesscomUser?: string }): Promise<Profile> {
  const games = await db.games.toArray()
  const band = computeBand(games)
  const old = await db.profile.get('me')
  const profile: Profile = {
    id: 'me',
    ...users,
    band,
    bandHistory: old?.band === band ? old.bandHistory : [...(old?.bandHistory ?? []), { band, at: Date.now() }],
    ...BAND_DEFAULTS[band],
  }
  await db.profile.put(profile)
  return profile
}

export async function syncAndAnalyze(
  users: { lichessUser?: string; chesscomUser?: string },
  onStatus: (s: string) => void,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<void> {
  onStatus('Fetching games…')
  const added = await sync(users)
  const profile = await saveProfile(users)
  onStatus(`Added ${added.lichess + added.chesscom} games. Analyzing…`)
  await runQueue(getEngine(), { depth: 14, bookPlies: 8 }, onProgress, signal, async game => {
    const puzzles = await generatePuzzles(game, getEngine(), {
      swingThresholdCp: profile.swingThresholdCp,
      marginCp: profile.marginCp,
      depth: 16,
      maxSolutionMoves: 3,
    })
    await db.puzzles.bulkPut(puzzles)
  })
  onStatus('Done.')
}
