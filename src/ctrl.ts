import type { Progress } from './analysis/queue'
import { db, type Profile } from './db'
import { Drill } from './drill'
import { syncAndAnalyze } from './pipeline'
import { dueQueue, saveWhyMissed } from './train'

export type Screen = 'today' | 'drill' | 'sync'

export interface Counts {
  games: number
  analyzed: number
  puzzles: number
  due: number
}

export class Ctrl {
  screen: Screen = 'today'
  profile?: Profile
  counts: Counts = { games: 0, analyzed: 0, puzzles: 0, due: 0 }
  status = ''
  progress?: Progress
  syncing = false
  drill?: Drill
  queueLeft = 0
  private queue: string[] = []
  private abort?: AbortController
  readonly redraw: () => void

  constructor(redraw: () => void) {
    this.redraw = redraw
    this.refresh()
  }

  async refresh() {
    this.profile = await db.profile.get('me')
    const [games, analyzed, puzzles, due] = await Promise.all([
      db.games.count(),
      db.games.filter(g => g.analyzedAt !== undefined).count(),
      db.puzzles.count(),
      dueQueue().then(q => q.length),
    ])
    this.counts = { games, analyzed, puzzles, due }
    if (!this.profile && this.screen === 'today') this.screen = 'sync'
    this.redraw()
  }

  go(screen: Screen) {
    if (screen !== 'drill') this.stopDrill()
    this.screen = screen
    this.redraw()
    this.refresh()
  }

  async sync(lichessUser: string, chesscomUser: string) {
    if (this.syncing) return
    this.syncing = true
    this.abort = new AbortController()
    const users = { lichessUser: lichessUser.trim() || undefined, chesscomUser: chesscomUser.trim() || undefined }
    try {
      await syncAndAnalyze(
        users,
        s => ((this.status = s), this.redraw()),
        p => {
          this.progress = p
          this.refresh()
        },
        this.abort.signal,
      )
    } catch (e) {
      this.status = (e as Error).message
    }
    this.syncing = false
    this.refresh()
  }

  stopSync() {
    this.abort?.abort()
    this.status = 'Stopped. Analysis picks up where it left off next time.'
    this.redraw()
  }

  async startDrill() {
    this.queue = (await dueQueue()).map(p => p.id)
    this.screen = 'drill'
    this.next()
  }

  async next() {
    this.stopDrill()
    const id = this.queue.shift()
    this.queueLeft = this.queue.length
    const puzzle = id && (await db.puzzles.get(id))
    if (!puzzle) return this.go('today')
    this.drill = new Drill(puzzle, this.redraw)
    this.redraw()
  }

  saveWhy(text: string) {
    if (this.drill?.reviewId !== undefined) saveWhyMissed(this.drill.reviewId, text)
  }

  private stopDrill() {
    this.drill?.destroy()
    this.drill = undefined
  }
}
