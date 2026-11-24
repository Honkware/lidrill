import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Ctrl } from './ctrl'
import { db, type Puzzle } from './db'
import { saveProfile } from './pipeline'
import { SAMPLES } from './samples'

// What a visitor with nothing stored gets: a puzzle to play at once, from
// the samples, with nothing written for it. And where every address lands
// for a player with games, the old ones included.

// jsdom has no workers; no search is asked of this one
class NoEngine {
  postMessage() {}
  addEventListener() {}
  terminate() {}
}

const open = async (hash: string) => {
  location.hash = hash
  const ctrl = new Ctrl(() => {})
  await vi.waitFor(() => expect(ctrl.drill).toBeDefined())
  return ctrl
}

// A Ctrl listens on the window for good, so a test takes its listeners off
// again or it would go on routing through the tests after it
const listeners: Parameters<typeof window.addEventListener>[] = []
afterEach(() => {
  for (const [type, f] of listeners.splice(0)) window.removeEventListener(type, f)
  vi.restoreAllMocks()
})

beforeEach(async () => {
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((...args: Parameters<typeof window.addEventListener>) => {
    listeners.push(args)
    add(...args)
  })
  vi.stubGlobal('Worker', NoEngine)
  vi.stubGlobal('scrollTo', () => {})
  // A username starts a sync, which must not leave the machine
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  await Promise.all([db.games.clear(), db.puzzles.clear(), db.reviews.clear(), db.profile.clear(), db.syncQueue.clear()])
})

describe('a first visit', () => {
  it('opens on the first sample puzzle, whatever the address', async () => {
    for (const hash of ['', '#/today', '#/games', '#/settings']) {
      const ctrl = await open(hash)
      expect([ctrl.screen, ctrl.sample, ctrl.drill!.puzzle.id]).toEqual(['drill', true, 'sample:1'])
    }
  })

  it('plays the samples without storing a puzzle, a review or a row to sync', async () => {
    const ctrl = await open('')
    for (const s of SAMPLES) {
      const d = ctrl.drill!
      expect(d.puzzle).toBe(s.puzzle)
      d.go(d.start)
      expect(d.typeMove(d.sanAt(s.puzzle.solution[0]))).toBe(true)
      await vi.waitFor(() => expect(ctrl.answered).toBe(true))
      await ctrl.next()
    }
    expect([ctrl.sessionDone, ctrl.session]).toEqual([true, ['clean', 'clean', 'clean']])
    expect([await db.puzzles.count(), await db.reviews.count(), await db.syncQueue.count()]).toEqual([0, 0, 0])
  })

  it('offers the sign-in once a sample is solved, not after a miss', async () => {
    const ctrl = await open('')
    const d = ctrl.drill!
    d.go(d.start)
    d.viewSolution()
    await vi.waitFor(() => expect(ctrl.answered).toBe(true))
    expect(ctrl.ownGames).toBe(false)
    await ctrl.next()
    const next = ctrl.drill!
    next.go(next.start)
    next.typeMove(next.sanAt(next.puzzle.solution[0]))
    await vi.waitFor(() => expect(ctrl.ownGames).toBe(true))
  })

  it('cannot bury a sample, and keeps its explanation and arrows on a retry', async () => {
    const ctrl = await open('')
    const d = ctrl.drill!
    d.go(d.start)
    d.typeMove(d.sanAt(d.puzzle.solution[0]))
    await vi.waitFor(() => expect(ctrl.answered).toBe(true))
    expect([ctrl.canBury, ctrl.canRetry]).toEqual([false, true])
    ctrl.retry()
    expect(ctrl.drill).not.toBe(d)
    expect([ctrl.drill!.opts.note, ctrl.drill!.opts.arrows, ctrl.drill!.opts.record]).toEqual([SAMPLES[0].why, SAMPLES[0].arrows, false])
    expect(ctrl.session).toEqual(['clean'])
  })

  it('shows the sign-in alone once there are games but no account', async () => {
    await db.games.add({ id: 'lichess:g', site: 'lichess', url: '', pgn: '', color: 'white', result: 'win', rating: 1500, speed: 'rapid', eco: '', opening: '', playedAt: 1, moves: [], termination: '' })
    location.hash = ''
    const ctrl = new Ctrl(() => {})
    await vi.waitFor(() => expect(ctrl.ready).toBe(true))
    expect([ctrl.screen, ctrl.sample, ctrl.drill]).toEqual(['welcome', false, undefined])
  })
})

describe('with an account', () => {
  const due: Puzzle = {
    id: 'p:1', gameId: '', ply: 11, fen: 'rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6',
    played: 'e1d1', solution: ['c4f7', 'e8e7', 'c3d5'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 900, card: createEmptyCard(new Date(0)),
  }

  const land = async (hash: string) => {
    location.hash = hash
    const ctrl = new Ctrl(() => {})
    await vi.waitFor(() => expect(ctrl.ready).toBe(true))
    return [ctrl.screen, location.hash]
  }

  beforeEach(() => saveProfile({ chesscomUser: 'someone' }))

  it('opens Train on the board while a puzzle is due, from the bare address, #/train and the old #/drills', async () => {
    await db.puzzles.put(due)
    for (const hash of ['', '#/train', '#/drills', '#/nowhere']) expect(await land(hash)).toEqual(['drill', '#/drill'])
  })

  it('keeps the old Today as the overview on Train, puzzles due or not', async () => {
    await db.puzzles.put(due)
    expect(await land('#/today')).toEqual(['train', '#/train/day'])
    await db.puzzles.clear()
    expect(await land('#/today')).toEqual(['train', '#/train/day'])
  })

  it('opens Train on the overview when nothing is due', async () => {
    expect(await land('')).toEqual(['train', ''])
    expect(await land('#/train')).toEqual(['train', '#/train'])
  })

  it('still opens every page by its old address', async () => {
    await db.puzzles.put(due)
    for (const name of ['play', 'games', 'settings', 'precision', 'openings', 'conversion', 'defense']) expect(await land(`#/${name}`)).toEqual([name, `#/${name}`])
    expect(await land('#/review')).toEqual(['games', '#/games'])
  })

  it('pressing Train on the board keeps the puzzle that was on it', async () => {
    await db.puzzles.bulkPut([due, { ...due, id: 'p:2' }])
    location.hash = ''
    const ctrl = new Ctrl(() => {})
    await vi.waitFor(() => expect(ctrl.drill).toBeDefined())
    const { id } = ctrl.drill!.puzzle
    location.hash = '#/train'
    await vi.waitFor(() => expect(location.hash).toBe('#/drill'))
    await vi.waitFor(() => expect(ctrl.drill).toBeDefined())
    expect([ctrl.drill!.puzzle.id, ctrl.queueLeft]).toEqual([id, 1])
  })

  it('burying the puzzle on the board moves on, and Undo puts it back as the next', async () => {
    await db.puzzles.bulkPut([due, { ...due, id: 'p:2' }])
    location.hash = ''
    const ctrl = new Ctrl(() => {})
    await vi.waitFor(() => expect(ctrl.drill).toBeDefined())
    const { id } = ctrl.drill!.puzzle
    await ctrl.bury()
    expect([(await db.puzzles.get(id))!.buried, ctrl.drill!.puzzle.id === id, ctrl.queueLeft, ctrl.notice?.text]).toEqual([true, false, 0, 'Buried.'])
    ctrl.notice!.undo!()
    await vi.waitFor(() => expect(ctrl.notice).toBeUndefined())
    expect([(await db.puzzles.get(id))!.buried, ctrl.queueLeft]).toEqual([undefined, 1])
    await ctrl.next()
    expect(ctrl.drill!.puzzle.id).toBe(id)
  })

  it('a buried puzzle no longer opens the board', async () => {
    await db.puzzles.put({ ...due, buried: true })
    expect(await land('#/train')).toEqual(['train', '#/train'])
  })
})
