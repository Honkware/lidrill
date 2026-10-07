import type { Progress } from './analysis/queue'
import { finishSignIn, signOut, startSignIn } from './auth'
import { backfillPackets } from './backfill'
import { deleteAllData, exportData, importData, sameUser } from './backup'
import { db, type Auth, type Game, type JournalEntry, type Practice, type Profile } from './db'
import { Drill, type Outcome } from './drill'
import { GameView } from './gameview'
import { fetchLook, PREFERENCE_SCOPE } from './lichess/api'
import { fetchStudyLines, listStudies, STUDY_READ_SCOPE, studyCompliance, type StudyInfo } from './lichess/repertoire'
import { STUDY_SCOPE, sendToStudy } from './lichess/study'
import { applyLook, BOARDS, PIECE_SETS } from './look'
import { compliance, openingTable, repertoireTargets, streak, type OpeningRow, type Streak } from './metrics'
import { forgetLichessAccount, getEngine, precertifyDue, saveProfile, syncAndAnalyze } from './pipeline'
import { PracticeRun } from './practice'
import { Replay } from './replay'
import { weekReport, weeklyZeroHang, type WeekReport } from './report'
import { corpus, exportMarks, loadMarks, saveMarks, type Mark } from './precision'
import { sound } from './sound'
import { SignInExpired } from './sync/lichess'
import { dueQueue, saveWhyMissed, type DayQueue } from './train'

export type Screen = 'welcome' | 'today' | 'drill' | 'replay' | 'review' | 'game' | 'games' | 'drills' | 'practice' | 'settings' | 'precision'

export interface Counts {
  games: number
  analyzed: number
  puzzles: number
}

export interface TodayData {
  queue: DayQueue
  streak: Streak
  report: WeekReport
  weeks: { games: number; clean: number }[]
  practice: { conversion: number; defense: number; cleared: number }
  openings: OpeningRow[]
  replayPick?: { game: Game; stops: number }
  puzzlePerf?: { now: number; delta?: number }
  targets: string[]
  compliance?: number
}

export interface ReviewRow {
  game: Game
  journal?: JournalEntry
  puzzles: number
  inaccuracy: number
  mistake: number
  blunder: number
}

// Screens are routed through the URL hash so the phone's back button works
const ROUTED: Screen[] = ['today', 'review', 'games', 'drills', 'settings', 'precision']

export class Ctrl {
  screen: Screen = 'today'
  auth?: Auth
  profile?: Profile
  loaded = false
  counts: Counts = { games: 0, analyzed: 0, puzzles: 0 }
  status = ''
  progress?: Progress
  syncing = false
  error?: string
  notice?: { text: string; href?: string }
  today?: TodayData
  reviewList?: ReviewRow[]
  practiceList?: Practice[]
  drill?: Drill
  session: Outcome[] = [] // today's run so far
  autoNext = readFlag('lidrill.autoNext')
  queueLeft = 0
  replay?: Replay
  gameView?: GameView
  run?: PracticeRun
  studies?: StudyInfo[]
  playedFamilies: string[] = []
  // The human precision pass: claim index and the reviewer's marks
  precisionIndex = 0
  precisionMarks?: import('./precision').Marks
  private queue: string[] = []
  private abort?: AbortController
  private refreshing?: Promise<void>
  private lastRefresh = 0
  private depth = 0
  private loadedKey = ''
  // First load finished: until then screens show placeholders, not "no data"
  ready = false
  readonly redraw: () => void

  constructor(redraw: () => void) {
    this.redraw = redraw
    window.addEventListener('hashchange', () => this.route())
    window.addEventListener('keydown', e => this.onKey(e))
    this.boot()
  }

  private async boot() {
    let after: string | undefined
    try {
      const fresh = await finishSignIn()
      const old = await db.profile.get('me')
      if (fresh && old?.lichessUser && !sameUser(old.lichessUser, fresh.username)) await forgetLichessAccount()
      after = fresh?.after
    } catch (e) {
      this.status = (e as Error).message
    }
    this.auth = await db.auth.get('lichess')
    this.profile = await db.profile.get('me')
    applyLook(this.profile)
    this.loaded = true
    await this.route()
    if (after?.startsWith('study:')) this.sendStudy(after.slice(6))
    if (after === 'look') this.useLichessLook()
    if (after === 'studies') this.loadStudies()
    if (this.auth || this.profile?.chesscomUser) this.sync()
  }

  get signedOut() {
    return !this.auth && !this.profile?.chesscomUser
  }

  // #/review, #/game/<id>, #/replay/<id>, #/practice/<id>, #/drill
  private async route() {
    const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/')
    const arg = decodeURIComponent(rest.join('/'))
    this.teardown()
    if (this.signedOut) this.screen = 'welcome'
    else if (name === 'game' && arg) await this.openGame(arg)
    else if (name === 'replay' && arg) await this.openReplay(arg)
    else if (name === 'practice' && arg) await this.openPractice(arg)
    else if (name === 'drill') await this.openDrill()
    else this.screen = ROUTED.includes(name as Screen) ? (name as Screen) : 'today'
    if (this.screen === 'precision' && this.precisionMarks === undefined) this.precisionMarks = loadMarks()
    this.redraw()
    window.scrollTo(0, 0)
    await this.refresh(true)
  }

  go(screen: Screen, arg?: string) {
    this.depth++
    const hash = `#/${screen}${arg ? `/${encodeURIComponent(arg)}` : ''}`
    if (location.hash === hash) this.route()
    else location.hash = hash
  }

  // Back within the app, or to `fallback` when the screen was opened directly
  back(fallback: Screen = 'today') {
    if (this.depth > 0) {
      this.depth--
      history.back()
    } else this.go(fallback)
  }

  private teardown() {
    this.drill?.destroy()
    this.drill = undefined
    this.replay?.destroy()
    this.replay = undefined
    this.gameView?.destroy()
    this.gameView = undefined
    this.run?.destroy()
    this.run = undefined
  }

  // Cheap enough to run often, but analysis reports progress per game, so
  // it's throttled while syncing
  async refresh(force = false) {
    if (!force && Date.now() - this.lastRefresh < 1500) return
    if (this.refreshing) return this.refreshing
    this.lastRefresh = Date.now()
    this.refreshing = this.load().finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

  // Counts are cheap (indexes); the full game list and the stats built on
  // it are only re-read when something changed since the last look, so
  // switching tabs during a long analysis stays instant.
  private async load() {
    this.profile = await db.profile.get('me')
    const [games, analyzed, puzzles, reviews, journal, practice] = await Promise.all([
      db.games.count(),
      db.games.where('analyzedAt').above(0).count(),
      db.puzzles.count(),
      db.reviews.count(),
      db.journal.count(),
      db.practice.count(),
    ])
    this.counts = { games, analyzed, puzzles }
    const version = [games, analyzed, puzzles, reviews, journal, practice, this.profile?.band, this.profile?.repertoire?.join(), this.profile?.repertoireStudy?.id, new Date().toDateString()].join('|')
    const key = `${this.screen}:${version}`
    if (key !== this.loadedKey) {
      const all = this.screen === 'today' || this.screen === 'review' || this.screen === 'settings' ? await db.games.toArray() : []
      const done = all.filter(g => g.analyzedAt !== undefined)
      if (this.screen === 'today' && this.profile) await this.loadToday(all, done, this.profile)
      if (this.screen === 'review') await this.loadReview(done)
      if (this.screen === 'settings')
        this.playedFamilies = openingTable(all)
          .filter(r => r.family !== 'Unknown')
          .slice(0, 10)
          .map(r => r.family)
      this.loadedKey = key
    }
    // Streaks change without the count changing, and the list is small
    if (this.screen === 'drills') this.practiceList = await db.practice.toArray()
    this.ready = true
    this.redraw()
  }

  private async loadToday(games: Game[], analyzed: Game[], profile: Profile) {
    const now = new Date()
    const journal = await db.journal.toArray()
    const reviews = await db.reviews.toArray()
    const own = await db.puzzles.filter(p => p.source !== 'lichess').toArray()
    const stopsByGame = new Map<string, number>()
    for (const p of own) stopsByGame.set(p.gameId, (stopsByGame.get(p.gameId) ?? 0) + 1)
    const latest = [...analyzed].sort((a, b) => b.playedAt - a.playedAt).find(g => stopsByGame.has(g.id))
    const snaps = (await db.liPuzzle.toArray()).sort((a, b) => a.week.localeCompare(b.week))
    const [prev, last] = [snaps.at(-2), snaps.at(-1)]
    const targets = repertoireTargets(games, profile.band, profile.repertoire)
    const practice = await db.practice.toArray()
    const open = (kind: string) => practice.filter(p => p.kind === kind && !p.cleared).length
    this.today = {
      queue: await dueQueue(now),
      streak: streak(journal),
      report: weekReport(games, journal, reviews, profile, now),
      weeks: weeklyZeroHang(journal, now),
      practice: { conversion: open('conversion'), defense: open('defense'), cleared: practice.filter(p => p.cleared).length },
      openings: openingTable(games, new Map(journal.map(j => [j.gameId, j]))).slice(0, 8),
      replayPick: latest && { game: latest, stops: stopsByGame.get(latest.id)! },
      puzzlePerf: last && { now: last.global.performance, delta: prev && last.global.performance - prev.global.performance },
      targets,
      compliance: profile.repertoireStudy ? studyCompliance(games, profile.repertoireStudy.lines) : compliance(games, targets),
    }
  }

  private async loadReview(analyzed: Game[]) {
    const journal = new Map((await db.journal.toArray()).map(j => [j.gameId, j]))
    const puzzles = new Map<string, number>()
    for (const p of await db.puzzles.toArray()) if (p.gameId) puzzles.set(p.gameId, (puzzles.get(p.gameId) ?? 0) + 1)
    this.reviewList = [...analyzed]
      .sort((a, b) => b.playedAt - a.playedAt)
      .map(game => {
        const mine = game.moves.filter((_, i) => (i % 2 === 0) === (game.color === 'white'))
        const count = (j: string) => mine.filter(m => m.judg === j).length
        return {
          game,
          journal: journal.get(game.id),
          puzzles: puzzles.get(game.id) ?? 0,
          inaccuracy: count('inaccuracy'),
          mistake: count('mistake'),
          blunder: count('blunder'),
        }
      })
  }

  // --- account ---

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
      if (this.screen === 'welcome') this.go('games')
      this.sync()
    } else this.refresh(true)
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
      await this.signInExpired(e)
      this.status = this.error = (e as Error).message
    }
    this.syncing = false
    this.refresh(true)
    if (!this.abort.signal.aborted) {
      void precertifyDue(this.abort.signal)
      // One-time migration: stamp tiers on old rows and upload packets
      // in throttled idle slices (status shares the sync line)
      void backfillPackets(s => ((this.status = s), this.redraw()), this.abort.signal)
    }
  }

  private async signInExpired(e: unknown) {
    if (!(e instanceof SignInExpired)) return
    await db.auth.delete('lichess')
    this.auth = undefined
    if (!this.profile?.chesscomUser) this.go('welcome')
  }

  stopSync() {
    if (!this.syncing) return
    this.abort?.abort()
    this.status = 'Stopped. Analysis picks up where it left off next time.'
    this.redraw()
  }

  // --- daily puzzles ---

  async startDrill() {
    this.queue = (await dueQueue()).puzzles.map(p => p.id)
    this.session = []
    this.go('drill')
  }

  private async openDrill() {
    this.screen = 'drill'
    if (!this.queue.length) this.queue = (await dueQueue()).puzzles.map(p => p.id)
    await this.nextPuzzle()
  }

  async next() {
    this.drill?.destroy()
    this.drill = undefined
    await this.nextPuzzle()
    this.redraw()
  }

  private async nextPuzzle() {
    const id = this.queue.shift()
    this.queueLeft = this.queue.length
    const puzzle = id ? await db.puzzles.get(id) : undefined
    if (!puzzle) {
      sound.notify() // the daily queue is done
      this.notice = { text: 'Done for today.' }
      return this.go('today')
    }
    this.drill = new Drill(puzzle, this.redraw, {
      record: true,
      engine: getEngine(),
      onFinish: outcome => {
        this.session.push(outcome)
        const drill = this.drill
        if (this.autoNext && (outcome === 'clean' || outcome === 'hinted'))
          setTimeout(() => this.drill === drill && this.next(), 700)
      },
    })
  }

  setAutoNext(on: boolean) {
    this.autoNext = on
    writeFlag('lidrill.autoNext', on)
  }

  // Lichess's puzzle keys: arrows or j/k to step, Home/End, f to flip, n to
  // move on
  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return
    const d = this.screen === 'drill' ? this.drill : this.screen === 'replay' ? this.replay?.drill : undefined
    if (!d) return
    const key = e.key
    if (d.state === 'view' && (key === 'ArrowLeft' || key === 'k')) d.go(d.cursor - 1)
    else if (d.state === 'view' && (key === 'ArrowRight' || key === 'j')) d.go(d.cursor + 1)
    else if (d.state === 'view' && key === 'Home') d.go(d.start)
    else if (d.state === 'view' && key === 'End') d.go(d.nodes.length - 1)
    else if (key === 'f') d.flip()
    else if (this.screen === 'drill' && d.state === 'view' && key === 'n') this.next()
    else return
    e.preventDefault()
  }

  saveWhy(text: string) {
    if (this.drill?.reviewId !== undefined) saveWhyMissed(this.drill.reviewId, text)
  }

  // --- review, replay, drills ---

  private async openGame(id: string) {
    const game = await db.games.get(id)
    if (!game) return void (this.screen = 'review')
    this.screen = 'game'
    this.gameView = new GameView(game, this.redraw)
    this.gameView.journal = await db.journal.get(id)
    this.gameView.puzzles = await db.puzzles.where('gameId').equals(id).toArray()
  }

  async saveJournal(patch: Partial<Pick<JournalEntry, 'note' | 'confirmed'>>) {
    const gameId = this.gameView?.game.id ?? this.replay?.game.id
    if (!gameId) return
    const entry = await db.journal.get(gameId)
    if (!entry) return
    const updated = { ...entry, ...patch, note: patch.note !== undefined ? patch.note.trim() || undefined : entry.note }
    await db.journal.put(updated)
    if (this.gameView) this.gameView.journal = updated
    this.redraw()
  }

  private async openReplay(id: string) {
    const game = await db.games.get(id)
    const stops = await db.puzzles.where('gameId').equals(id).toArray()
    if (!game) return void (this.screen = 'review')
    this.screen = 'replay'
    this.replay = new Replay(game, stops, this.redraw, getEngine())
  }

  private async openPractice(id: string) {
    const practice = await db.practice.get(id)
    if (!practice) return void (this.screen = 'drills')
    this.screen = 'practice'
    this.run = new PracticeRun(practice, getEngine(), this.redraw)
  }

  async retryPractice() {
    const id = this.run?.practice.id
    this.run?.destroy()
    this.run = undefined
    this.redraw()
    if (id) {
      await this.openPractice(id)
      this.redraw()
    }
  }

  // --- Lichess extras that need one more scope ---

  hasScope(scope: string) {
    return !!this.auth?.scopes.includes(scope)
  }

  async sendStudy(gameId: string) {
    if (!this.auth) return
    if (!this.hasScope(STUDY_SCOPE)) return void startSignIn([...this.auth.scopes, STUDY_SCOPE], `study:${gameId}`)
    const game = await db.games.get(gameId)
    const stops = (await db.puzzles.where('gameId').equals(gameId).toArray()).sort((a, b) => a.ply - b.ply)
    if (!game || !stops.length) return
    this.notice = { text: 'Creating the study…' }
    this.redraw()
    try {
      const href = await sendToStudy(game, stops, this.auth.token)
      this.notice = { text: 'Study created on Lichess.', href }
    } catch (e) {
      await this.signInExpired(e)
      this.notice = { text: (e as Error).message }
    }
    this.redraw()
  }

  async useLichessLook() {
    if (!this.auth) return
    if (!this.hasScope(PREFERENCE_SCOPE)) return void startSignIn([...this.auth.scopes, PREFERENCE_SCOPE], 'look')
    try {
      const look = await fetchLook(this.auth.token)
      const pieces = PIECE_SETS.find(p => p.key === look.pieceSet)?.key
      const board = look.theme?.startsWith('wood') ? 'walnut' : BOARDS.find(b => look.theme?.startsWith(b.key))?.key
      await this.setLook({ pieces, board, theme: look.dark === false ? 'light' : 'dark' })
      const missing = !pieces && look.pieceSet ? ` lidrill doesn't have "${look.pieceSet}", so the pieces stay as they are.` : ''
      this.notice = { text: `Using your Lichess look.${missing}` }
    } catch (e) {
      await this.signInExpired(e)
      this.notice = { text: (e as Error).message }
    }
    this.redraw()
  }

  async loadStudies() {
    if (!this.auth) return
    if (!this.hasScope(STUDY_READ_SCOPE)) return void startSignIn([...this.auth.scopes, STUDY_READ_SCOPE], 'studies')
    try {
      this.studies = await listStudies(this.auth.username, this.auth.token)
      if (!this.studies.length) this.notice = { text: "You don't have any studies on Lichess yet." }
    } catch (e) {
      await this.signInExpired(e)
      this.notice = { text: (e as Error).message }
    }
    this.redraw()
  }

  async useStudy(study: StudyInfo | undefined) {
    if (!study) {
      this.profile = await saveProfile({ repertoireStudy: undefined })
      return this.refresh(true)
    }
    if (!this.auth) return
    try {
      const lines = await fetchStudyLines(study.id, this.auth.token)
      if (!lines.length) return void ((this.notice = { text: `"${study.name}" has no chapters that start from the opening position.` }), this.redraw())
      this.profile = await saveProfile({ repertoireStudy: { ...study, lines } })
      this.studies = undefined
      this.notice = { text: `Using "${study.name}": ${lines.length} lines.` }
    } catch (e) {
      await this.signInExpired(e)
      this.notice = { text: (e as Error).message }
    }
    this.refresh(true)
  }

  // --- settings ---

  async setLook(patch: Partial<Pick<Profile, 'theme' | 'pieces' | 'board'>>) {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    this.profile = await saveProfile(clean)
    applyLook(this.profile)
    this.redraw()
  }

  async setPlan(patch: Partial<Pick<Profile, 'repertoire'>>) {
    this.profile = await saveProfile(patch)
    this.refresh(true)
  }

  // Up to four families; none selected means lidrill picks them
  async toggleRepertoire(family: string) {
    const now = this.profile?.repertoire ?? []
    const next = now.includes(family) ? now.filter(f => f !== family) : [...now, family].slice(-4)
    await this.setPlan({ repertoire: next.length ? next : undefined })
  }

  async exportFile() {
    const data = await exportData()
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `lidrill-${data.exportedAt.slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async importFile(file: File) {
    try {
      await importData(await file.text(), this.auth?.username)
      this.profile = await db.profile.get('me')
      applyLook(this.profile)
      this.notice = { text: 'Imported.' }
    } catch (e) {
      this.notice = { text: e instanceof SyntaxError ? "That file isn't a lidrill export." : (e as Error).message }
    }
    this.refresh(true)
  }

  async deleteEverything() {
    if (!confirm('Delete all games, puzzles and history from this browser? This can’t be undone.')) return
    this.stopSync()
    await deleteAllData()
    this.profile = undefined
    applyLook()
    this.notice = { text: 'Deleted.' }
    this.go(this.auth ? 'today' : 'welcome')
  }

  dismissNotice() {
    this.notice = undefined
    this.redraw()
  }

  // --- human precision pass ---

  precisionMark(id: string, mark: Mark) {
    const marks = { ...(this.precisionMarks ?? loadMarks()) }
    if (marks[id] === mark) delete marks[id] // the same verdict again clears it
    else marks[id] = mark
    this.precisionMarks = marks
    saveMarks(marks)
    this.redraw()
  }

  precisionReset() {
    if (!confirm('Clear every mark and start the pass over?')) return
    this.precisionMarks = {}
    saveMarks({})
    this.precisionIndex = 0
    this.redraw()
  }

  precisionExport() {
    const data = exportMarks(corpus, this.precisionMarks ?? {})
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `lidrill-precision-${data.generatedAt.slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

// Per-browser preferences; storage can be off (private mode), which just
// means the default
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // not saved; fine
  }
}
