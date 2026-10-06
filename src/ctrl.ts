import type { Progress } from './analysis/queue'
import { finishSignIn, signOut, startSignIn } from './auth'
import { db, type Auth, type Profile } from './db'
import { Drill } from './drill'
import { forgetLichessAccount, saveProfile, syncAndAnalyze } from './pipeline'
import { SignInExpired } from './sync/lichess'
import { dueQueue, saveWhyMissed } from './train'

export type Screen = 'welcome' | 'today' | 'drill' | 'sync'

export interface Counts {
  games: number
  analyzed: number
  puzzles: number
  due: number
}

export class Ctrl {
  screen: Screen = 'today'
  auth?: Auth
  profile?: Profile
  loaded = false
  counts: Counts = { games: 0, analyzed: 0, puzzles: 0, due: 0 }
  status = ''
  progress?: Progress
  syncing = false
  error?: string
  drill?: Drill
  queueLeft = 0
  private queue: string[] = []
  private abort?: AbortController
  readonly redraw: () => void

  constructor(redraw: () => void) {
    this.redraw = redraw
    this.boot()
  }

  private async boot() {
    try {
      const fresh = await finishSignIn()
      const old = await db.profile.get('me')
      if (fresh && old?.lichessUser && old.lichessUser !== fresh.username) await forgetLichessAccount()
    } catch (e) {
      this.status = (e as Error).message
    }
    this.auth = await db.auth.get('lichess')
    this.profile = await db.profile.get('me')
    this.loaded = true
    if (this.auth || this.profile?.chesscomUser) this.sync()
    else this.screen = 'welcome'
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
    this.redraw()
  }

  go(screen: Screen) {
    if (screen !== 'drill') this.stopDrill()
    this.screen = screen
    this.redraw()
    this.refresh()
  }

  signIn() {
    startSignIn()
  }

  async signOut() {
    this.stopSync()
    await signOut()
    this.auth = undefined
    this.status = ''
    this.go(this.profile?.chesscomUser ? 'today' : 'welcome')
  }

  // Chess.com is optional and username-only: its API has no sign-in
  async setChesscom(user: string) {
    const chesscomUser = user.trim() || undefined
    this.profile = await saveProfile({ lichessUser: this.auth?.username, chesscomUser })
    if (chesscomUser) {
      if (this.screen === 'welcome') this.go('sync')
      this.sync()
    } else this.refresh()
  }

  async sync() {
    if (this.syncing) return
    this.syncing = true
    this.error = undefined
    this.abort = new AbortController()
    try {
      await syncAndAnalyze(
        { lichessUser: this.auth?.username, lichessToken: this.auth?.token, chesscomUser: this.profile?.chesscomUser },
        s => ((this.status = s), this.redraw()),
        p => {
          this.progress = p
          this.refresh()
        },
        this.abort.signal,
      )
    } catch (e) {
      if (e instanceof SignInExpired) {
        await db.auth.delete('lichess')
        this.auth = undefined
        if (!this.profile?.chesscomUser) this.screen = 'welcome'
      }
      this.status = this.error = (e as Error).message
    }
    this.syncing = false
    this.refresh()
  }

  stopSync() {
    if (!this.syncing) return
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
