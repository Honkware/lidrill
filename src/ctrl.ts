import type { Progress } from './analysis/queue'
import { finishSignIn, signOut, startSignIn } from './auth'
import { backfillPackets } from './backfill'
import { deleteAllData, exportData, importData, sameUser } from './backup'
import { db, type Auth, type Game, type JournalEntry, type MaiaSpeed, type Opening, type Practice, type PracticeKind, type Profile } from './db'
import { Drill, SessionReview, type Outcome } from './drill'
import { GameView } from './gameview'
import { fetchLook, PREFERENCE_SCOPE } from './lichess/api'
import { fetchStudyLines, listStudies, STUDY_READ_SCOPE, type StudyInfo } from './lichess/repertoire'
import { STUDY_SCOPE, sendToStudy } from './lichess/study'
import { applyLook, BOARDS, PIECE_SETS } from './look'
import { clampLevel, estimateFor, estimates, levelFor, ownStarts, speedOf, startEstimate, updateEstimate, type Start } from './maia'
import { openingTable, streak, type OpeningRow, type Streak } from './metrics'
import { nextAction, type Due, type Next } from './next'
import { addCards, dueCards, learnedKeys, openingsDue, saveTreeCards } from './openings/cards'
import { cachedPolicy, treeLevel } from './openings/policy'
import { mastersFor, recommend } from './openings/recommend'
import { gamesOpenings, posKey, rebuildRepertoire } from './openings/repertoire'
import { LearnRun, learnLine } from './openings/learn'
import { OpeningSession } from './openings/session'
import { SparRun } from './openings/spar'
import { buildTree, coverage, gameCards, unlearned, wentWrong, type Recommend } from './openings/tree'
import { analyzePending, forgetLichessAccount, getEngine, precertifyDue, saveProfile, syncAndAnalyze, warmEngine } from './pipeline'
import { clearGame, clockOf, PlayRun, readChoices, readGame, rematch, writeChoices, type Choices } from './play'
import { nextOpen, PracticeRun } from './practice'
import { Replay } from './replay'
import { movedTo, pageOf, type Moved, type Screen } from './routes'
import { weeklyZeroHang } from './report'
import { corpus, exportMarks, loadMarks, saveMarks, type Mark } from './precision'
import { sound } from './sound'
import { timeProfiles, type TimeProfile } from './time'
import { Countdown, timedSet } from './timed'
import { SignInExpired } from './sync/lichess'
import { serverSync as syncWithServer } from './sync/server'
import { DAILY_CAP, dueQueue, dueToday, saveWhyMissed } from './train'

export type { Screen } from './routes'

// A trained opening on the Drills card: coverage and the positions still to
// learn are filled in once its tree is counted
export interface OpeningStat {
  opening: Opening
  coverage?: number
  fresh?: number
  due: number
  error?: string
}

export interface Counts {
  games: number
  analyzed: number
  puzzles: number
}

export interface TodayData {
  streak: Streak
  weeks: { games: number; clean: number }[]
  puzzlePerf?: { now: number; delta?: number }
}

// What is due now, for Today, Train and the Next button after a session
export interface DueNow extends Due {
  puzzlesDone: number
  openingsDone: number
  latest?: { game: Game; stops: number } // the latest analyzed game with turning points
}

export interface ReviewRow {
  game: Game
  journal?: JournalEntry
  puzzles: number
  inaccuracy: number
  mistake: number
  blunder: number
}

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
  due?: DueNow
  nextUp?: Next
  reviewList?: ReviewRow[]
  openingRows: OpeningRow[] = [] // the record per opening, under the games
  timeProfiles: TimeProfile[] = [] // blitz and rapid, the one with more games first
  practiceList?: Practice[]
  drill?: Drill
  drills: Drill[] = [] // this session's completed puzzles, kept for review
  review = new SessionReview()
  session: Outcome[] = [] // today's run so far
  sessionDone = false // the run is over and its summary is on screen
  autoNext = readFlag('lidrill.autoNext')
  queueLeft = 0
  // A "Move under a clock" session: seconds per puzzle, and the screen to go
  // back to. Nothing in it is recorded, so it ends with a reload.
  timed?: { from: Screen; limits: Map<string, number>; outs: number }
  countdown?: Countdown
  replay?: Replay
  gameView?: GameView
  private gamePly?: number // where the next game opens, when not at the start
  run?: PracticeRun
  // Positions played one after another with Try again or Next position,
  // for the squares at the end
  practiceRun: { practice: Practice; won: boolean }[] = []
  private keepPracticeRun = false
  play?: PlayRun
  playStarts: Start[] = [] // positions from the player's own games a Maia game can start from
  maiaGames: Game[] = [] // for the level history on the card
  playLevel?: number // a level picked by hand; undefined follows the estimate
  playChoices = readChoices()
  playPuzzles?: string[] // ids of the puzzles the last finished Maia game produced, once analyzed
  playPicking = false // the list of own-game starts is open on the card
  private playFrom: Start | boolean = false
  private maiaStart = 1000
  studies?: StudyInfo[]
  playedFamilies: string[] = []
  openingStats: OpeningStat[] = []
  openingPicking = false
  gamesOpenings: Opening[] = [] // the player's most played openings, offered beside the built-in ones
  openingSet?: OpeningSession
  learn?: LearnRun
  learnRound = 0
  learnError?: string
  spar?: SparRun
  sparRound = 0
  private openingsTouched = 0 // bumped when an opening screen closes, so the card recounts
  private counting?: Promise<void>
  private countAgain?: Game[]
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
    window.addEventListener('online', () => void this.serverSync())
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
    this.startServerSync()
    // Warm the interactive engine in the background so drills and practice
    // don't pay the wasm startup cost on the first move.
    warmEngine()
  }

  get signedOut() {
    return !this.auth && !this.profile?.chesscomUser
  }

  // Screens are routed through the URL hash so the phone's back button
  // works: #/games, #/game/<id>, #/replay/<id>, #/practice/<id>, #/drill, #/play
  private async route() {
    const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/')
    const arg = decodeURIComponent(rest.join('/'))
    const moved = movedTo(name)
    if (moved) return location.replace(`#/${moved}`)
    this.teardown()
    if (name !== 'drill') this.timed = undefined
    if (this.signedOut) this.screen = 'welcome'
    else if (name === 'game' && arg) await this.openGame(arg)
    else if (name === 'replay' && arg) await this.openReplay(arg)
    else if (name === 'practice' && arg) await this.openPractice(arg)
    else if (name === 'drill') await this.openDrill()
    else if (name === 'play') await this.openPlay()
    else if (name === 'opening') await this.openOpenings(arg || undefined)
    else if (name === 'learn' && arg) await this.openLearn(arg)
    else if (name === 'spar' && arg) await this.openSpar(arg)
    else this.screen = pageOf(name)
    if (this.screen === 'precision' && this.precisionMarks === undefined) this.precisionMarks = loadMarks()
    this.redraw()
    window.scrollTo(0, 0)
    await this.refresh(true)
  }

  go(screen: Screen | Moved, arg?: string) {
    this.depth++
    const hash = `#/${screen}${arg ? `/${encodeURIComponent(arg)}` : ''}`
    if (location.hash === hash) this.route()
    else location.hash = hash
  }

  // Back within the app, or to `fallback` when the screen was opened directly
  back(fallback: Screen | Moved = 'today') {
    if (this.depth > 0) {
      this.depth--
      history.back()
    } else this.go(fallback)
  }

  private teardown() {
    this.drill?.destroy()
    this.drill = undefined
    this.countdown?.destroy()
    this.countdown = undefined
    this.replay?.destroy()
    this.replay = undefined
    this.gameView?.destroy()
    this.gameView = undefined
    this.run?.destroy()
    this.run = undefined
    this.play?.destroy()
    this.play = undefined
    if (this.openingSet || this.learn || this.spar) this.openingsTouched++
    this.openingSet?.board.destroy()
    this.openingSet = undefined
    this.learn?.destroy()
    this.learn = undefined
    this.learnError = undefined
    this.spar?.destroy()
    this.spar = undefined
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
    const [games, analyzed, puzzles, reviews, journal, practice, repertoire] = await Promise.all([
      db.games.count(),
      db.games.where('analyzedAt').above(0).count(),
      db.puzzles.count(),
      db.reviews.count(),
      db.journal.count(),
      db.practice.count(),
      db.repertoire.count(),
    ])
    this.counts = { games, analyzed, puzzles }
    const openings = this.profile?.openings?.map(o => `${o.color}:${o.name}`).join()
    const version = [games, analyzed, puzzles, reviews, journal, practice, repertoire, openings, this.profile?.band, this.profile?.repertoire?.join(), this.profile?.repertoireStudy?.id, this.openingsTouched, new Date().toDateString()].join('|')
    const key = `${this.screen}:${version}`
    if (key !== this.loadedKey) {
      const all = ['today', 'games', 'settings', 'drills', 'openings'].includes(this.screen) ? await db.games.toArray() : []
      const done = all.filter(g => g.analyzedAt !== undefined)
      if (this.screen === 'today') {
        await this.loadToday()
        this.maiaStart = startEstimate(this.profile?.ratings, all)
      }
      if (this.screen === 'games') await this.loadGames(all, done)
      if (this.screen === 'games' || this.screen === 'drills') this.timeProfiles = timeProfiles(all)
      if (this.screen === 'drills') {
        this.playStarts = ownStarts(all)
        this.maiaGames = all.filter(g => g.site === 'maia')
        this.maiaStart = startEstimate(this.profile?.ratings, all)
      }
      if (this.screen === 'drills' || this.screen === 'openings') {
        this.gamesOpenings = gamesOpenings(all)
        void this.countOpenings(all)
      }
      if (this.screen === 'settings')
        this.playedFamilies = openingTable(all.filter(g => g.site !== 'maia'))
          .filter(r => r.family !== 'Unknown')
          .slice(0, 10)
          .map(r => r.family)
      this.loadedKey = key
      if (this.screen !== 'welcome') await this.loadDue()
    }
    // Streaks change without the count changing, and the list is small
    if (this.screen === 'drills' || this.screen === 'practice') this.practiceList = await db.practice.toArray()
    this.ready = true
    this.redraw()
  }

  private async loadToday() {
    const now = new Date()
    const journal = await db.journal.toArray()
    const snaps = (await db.liPuzzle.toArray()).sort((a, b) => a.week.localeCompare(b.week))
    const [prev, last] = [snaps.at(-2), snaps.at(-1)]
    this.today = {
      streak: streak(journal),
      weeks: weeklyZeroHang(journal, now),
      puzzlePerf: last && { now: last.global.performance, delta: prev && last.global.performance - prev.global.performance },
    }
  }

  private async loadDue() {
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const [day, open, practice, own, openingsDone] = await Promise.all([
      dueToday(now),
      openingsDue(now),
      db.practice.toArray(),
      db.puzzles.filter(p => p.source !== 'lichess').toArray(),
      db.openingCards.filter(c => !!c.card.last_review && +new Date(c.card.last_review) >= startOfDay).count(),
    ])
    const stops = new Map<string, number>()
    for (const p of own) stops.set(p.gameId, (stops.get(p.gameId) ?? 0) + 1)
    const games = (await db.games.bulkGet([...stops.keys()])).filter((g): g is Game => g?.analyzedAt !== undefined)
    const game = games.sort((a, b) => b.playedAt - a.playedAt)[0]
    const latest = game && { game, stops: stops.get(game.id)! }
    const replayed = !!game && (await db.replaySessions.where('gameId').equals(game.id).count()) > 0
    const openOf = (kind: PracticeKind) => practice.filter(p => p.kind === kind && !p.cleared).length
    this.due = {
      game: !!readGame(),
      puzzles: day.remaining,
      puzzlesDone: day.doneToday,
      reviews: open.due,
      fresh: open.fresh,
      openingsDone,
      turning: latest && !replayed ? latest.stops : 0,
      latest,
      conversion: openOf('conversion'),
      defense: this.profile?.band === 'beginner' ? 0 : openOf('defense'),
    }
    this.nextUp = nextAction(this.due)
  }

  // Starts what nextAction says is next. Read again first, since the
  // session that just ended may have changed it.
  async goNext() {
    await this.loadDue()
    const due = this.due!
    switch (this.nextUp!.go) {
      case 'game':
        return this.go('play')
      case 'puzzles':
        return this.startDrill()
      case 'reviews':
        return this.go('opening')
      case 'learn': {
        const o = this.openingStats.find(r => r.fresh)?.opening
        return o ? this.go('learn', `${o.color}:${o.name}`) : this.go('openings')
      }
      case 'turning':
        return this.go('replay', due.latest!.game.id)
      case 'conversion':
      case 'defense':
        return this.nextPosition(this.nextUp!.go as PracticeKind)
      case 'play':
        return this.startPlay(false)
    }
  }

  // --- openings ---

  get openingNames(): string[] {
    return (this.profile?.openings ?? []).map(o => o.name)
  }

  // The trees are built against Maia at the player's rapid estimate, else
  // their estimate at any speed
  get openingLevel(): number {
    return treeLevel(estimateFor(estimates(this.profile?.maia), 'rapid', this.maiaStart).rating)
  }

  // Masters' moves when signed in to Lichess, else Stockfish's alone
  private get recommender(): Recommend {
    const masters = mastersFor(this.auth?.token)
    return moves => recommend(moves, masters, getEngine())
  }

  // Rebuilds the repertoire, makes cards from the player's games and counts
  // each opening's tree. Maia's answers and the recommended moves are
  // stored, so after the first time this is mostly local; the card fills in
  // one opening at a time.
  private async countOpenings(games: Game[]): Promise<void> {
    // A change while counting (an opening added) is counted straight after
    if (this.counting) return void (this.countAgain = games)
    this.counting = (async () => {
      const openings = this.profile?.openings ?? []
      const rep = await rebuildRepertoire(openings, this.profile?.repertoireStudy?.lines ?? [], games.filter(g => g.site !== 'maia'))
      const analyzed = games.filter(g => g.analyzedAt !== undefined)
      const wrong = wentWrong(analyzed)
      await addCards(analyzed.flatMap(g => gameCards(g, rep, openings, wrong)))
      const policy = cachedPolicy(this.openingLevel)
      const rec = this.recommender
      this.openingStats = openings.map(opening => ({ opening, due: 0 }))
      for (const row of this.openingStats) {
        try {
          const tree = await buildTree(row.opening, rep, policy, rec)
          await db.repertoire.bulkPut(tree.recs)
          await saveTreeCards(tree.nodes, row.opening.name, wrong)
          const learned = await learnedKeys(tree.nodes.map(n => posKey(n.fen)))
          row.coverage = coverage(tree.nodes, learned)
          row.fresh = new Set(unlearned(tree.nodes, learned).map(n => posKey(n.fen))).size
        } catch (e) {
          row.error = (e as Error).message
        }
        row.due = (await dueCards([row.opening.name])).length
        this.redraw()
      }
      this.redraw()
    })().finally(() => {
      this.counting = undefined
      const again = this.countAgain
      this.countAgain = undefined
      if (again) void this.countOpenings(again)
    })
  }

  toggleOpeningPicking() {
    this.openingPicking = !this.openingPicking
    this.redraw()
  }

  async toggleOpening(o: Opening) {
    const now = this.profile?.openings ?? []
    const has = now.some(x => x.name === o.name && x.color === o.color)
    const openings = has ? now.filter(x => x.name !== o.name || x.color !== o.color) : [...now, o]
    this.profile = await saveProfile({ openings })
    this.refresh(true)
  }

  private async repertoireMap(): Promise<Map<string, string>> {
    return new Map((await db.repertoire.toArray()).map(r => [r.fen, r.uci]))
  }

  // Due cards for every trained opening, or for one ('white:Italian Game')
  private async openOpenings(arg?: string) {
    this.screen = 'opening'
    const names = arg ? (this.profile?.openings ?? []).filter(o => `${o.color}:${o.name}` === arg).map(o => o.name) : this.openingNames
    const rep = await this.repertoireMap()
    const cards = (await dueCards(names)).filter(c => rep.has(c.id))
    this.openingSet = new OpeningSession(cards, rep, getEngine(), this.redraw)
  }

  // The next line of an opening to learn. A count still running is waited
  // for, since it may be finding the recommended moves this walk needs.
  private async openLearn(arg: string) {
    const opening = this.profile?.openings?.find(o => `${o.color}:${o.name}` === arg)
    if (!opening) return void (this.screen = 'drills')
    this.screen = 'learn'
    this.learnError = undefined
    this.redraw()
    await this.counting
    try {
      const tree = await buildTree(opening, await this.repertoireMap(), cachedPolicy(this.openingLevel), this.recommender)
      await db.repertoire.bulkPut(tree.recs)
      await saveTreeCards(tree.nodes, opening.name)
      const learned = await learnedKeys(tree.nodes.map(n => posKey(n.fen)))
      const left = new Set(unlearned(tree.nodes, learned).map(n => posKey(n.fen))).size
      this.learn = new LearnRun(opening, learnLine(opening, tree.nodes, learned), learned, left, this.redraw)
    } catch (e) {
      this.learnError = (e as Error).message
    }
  }

  async learnAgain() {
    const o = this.learn?.opening
    this.learn?.destroy()
    this.learn = undefined
    this.learnRound++
    if (o) await this.openLearn(`${o.color}:${o.name}`)
    this.redraw()
  }

  // arg is 'white:Italian Game': an opening's name can come up for both colours
  private async openSpar(arg: string) {
    const opening = this.profile?.openings?.find(o => `${o.color}:${o.name}` === arg)
    if (!opening) return void (this.screen = 'drills')
    if (!this.profile?.maia) this.maiaStart = startEstimate(this.profile?.ratings, await db.games.toArray())
    this.screen = 'spar'
    const cards = await db.openingCards.where('opening').equals(opening.name).toArray()
    this.spar = new SparRun(opening, await this.repertoireMap(), cards, cachedPolicy(this.openingLevel), getEngine(), this.redraw)
  }

  // A new game on a new board: the round is part of the board's key
  async sparAgain() {
    const o = this.spar?.opening
    this.spar?.destroy()
    this.spar = undefined
    this.sparRound++
    if (o) await this.openSpar(`${o.color}:${o.name}`)
    this.redraw()
  }

  // Games against Maia stay out of the opening table
  private async loadGames(all: Game[], analyzed: Game[]) {
    const journal = new Map((await db.journal.toArray()).map(j => [j.gameId, j]))
    this.openingRows = openingTable(all.filter(g => g.site !== 'maia'), journal).slice(0, 8)
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

  // --- server sync ---

  private serverSyncTimer?: ReturnType<typeof setInterval>
  private serverSyncing?: Promise<void>

  // Push dirty rows and pull newer ones on sign-in, after every game sync,
  // every 5 minutes, and when the network comes back. Fire-and-forget:
  // failures wait for the next pass, only an expired sign-in propagates.
  private startServerSync() {
    if (this.auth) void this.serverSync()
    if (!this.auth || this.serverSyncTimer) return
    this.serverSyncTimer = setInterval(() => void this.serverSync(), 5 * 60 * 1000)
  }

  private stopServerSync() {
    clearInterval(this.serverSyncTimer)
    this.serverSyncTimer = undefined
  }

  private async serverSync(): Promise<void> {
    if (!this.auth || this.serverSyncing) return this.serverSyncing
    this.serverSyncing = (async () => {
      const r = await syncWithServer(this.auth!.token)
      if (r.pulled) await this.refresh(true)
    })()
      .catch(async e => {
        await this.signInExpired(e)
        if (!(e instanceof SignInExpired)) console.warn('server sync:', e)
      })
      .finally(() => (this.serverSyncing = undefined))
    return this.serverSyncing
  }

  // --- account ---

  signIn() {
    startSignIn()
  }

  async signOut() {
    this.stopSync()
    this.stopServerSync()
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
    this.startServerSync()
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
    this.status = 'Stopped. The next sync resumes the analysis.'
    this.redraw()
  }

  // --- daily puzzles ---

  async startDrill() {
    this.timed = undefined
    this.queue = (await dueQueue()).puzzles.map(p => p.id)
    this.session = []
    this.sessionDone = false
    this.drills = []
    this.review.reset()
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
    this.countdown?.destroy()
    this.countdown = undefined
    await this.nextPuzzle()
    this.redraw()
  }

  private async nextPuzzle() {
    const id = this.queue.shift()
    this.queueLeft = this.queue.length
    const puzzle = id ? await db.puzzles.get(id) : undefined
    if (!puzzle) {
      if (!this.session.length) return this.go('today')
      sound.notify()
      this.sessionDone = true
      return this.loadDue()
    }
    this.drill = new Drill(puzzle, this.redraw, {
      record: !this.timed,
      engine: getEngine(),
      onFinish: outcome => {
        this.session.push(outcome)
        const drill = this.drill
        if (drill) {
          this.drills.push(drill)
          this.review.onComplete()
        }
        if (this.autoNext && (outcome === 'clean' || outcome === 'hinted'))
          setTimeout(() => this.drill === drill && this.next(), 700)
      },
    })
    const timed = this.timed
    if (timed) this.countdown = new Countdown(timed.limits.get(puzzle.id)!, this.drill, this.redraw, () => timed.outs++)
  }

  // The player's own puzzles against their think time, from the time
  // profile on Review or the card on Drills
  async startTimed(from: Screen) {
    const games = await db.games.toArray()
    const profiles = timeProfiles(games)
    if (!profiles.length) return
    const set = timedSet(await db.puzzles.toArray(), new Map(games.map(g => [g.id, g])), profiles, DAILY_CAP)
    if (!set.length) return void ((this.notice = { text: 'No puzzles from your games yet.' }), this.redraw())
    this.timed = { from, limits: new Map(set.map(p => [p.id, p.limit])), outs: 0 }
    this.queue = set.map(p => p.id)
    this.session = []
    this.sessionDone = false
    this.drills = []
    this.review.reset()
    this.go('drill')
  }

  // The puzzle on screen: the live one, or the completed one being reviewed
  get displayDrill(): Drill | undefined {
    return this.review.viewing === undefined ? this.drill : this.drills[this.review.viewing]
  }

  // Read-only step back through the session's completed puzzles
  sessionBack() {
    this.review.back()
    this.redraw()
  }

  sessionForward() {
    this.review.forward()
    this.redraw()
  }

  // A missed puzzle from the summary, read-only; Next steps on from it and
  // back to the summary after the last
  viewPuzzle(i: number) {
    this.review.viewing = i
    this.redraw()
  }

  setAutoNext(on: boolean) {
    this.autoNext = on
    writeFlag('lidrill.autoNext', on)
  }

  // Lichess's puzzle keys: arrows or j/k to step, Home/End, f to flip, n to
  // move on
  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return
    const d = this.screen === 'drill' ? this.displayDrill : this.screen === 'replay' ? this.replay?.drill : undefined
    if (!d) return
    const key = e.key
    if (d.state === 'view' && (key === 'ArrowLeft' || key === 'k')) d.go(d.cursor - 1)
    else if (d.state === 'view' && (key === 'ArrowRight' || key === 'j')) d.go(d.cursor + 1)
    else if (d.state === 'view' && key === 'Home') d.go(d.start)
    else if (d.state === 'view' && key === 'End') d.go(d.nodes.length - 1)
    else if (key === 'f') d.flip()
    else if (this.screen === 'drill' && d.state === 'view' && key === 'n') {
      if (this.review.viewing !== undefined) this.sessionForward()
      else this.next()
    }
    else return
    e.preventDefault()
  }

  saveWhy(text: string) {
    if (this.drill?.reviewId !== undefined) saveWhyMissed(this.drill.reviewId, text)
  }

  // --- review, replay, drills ---

  private async openGame(id: string) {
    const game = await db.games.get(id)
    if (!game) return void (this.screen = 'games')
    this.screen = 'game'
    this.gameView = new GameView(game, this.redraw, this.gamePly)
    this.gamePly = undefined
    this.gameView.journal = await db.journal.get(id)
    this.gameView.puzzles = await db.puzzles.where('gameId').equals(id).toArray()
  }

  openGameAt(id: string, ply: number) {
    this.gamePly = ply
    this.go('game', id)
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
    if (!game) return void (this.screen = 'games')
    this.screen = 'replay'
    this.replay = new Replay(game, stops, this.redraw, getEngine())
  }

  // The replay's own session is saved by the last stop, so by the time the
  // score shows the turning points are no longer next
  continueReplay() {
    const r = this.replay!
    r.continue()
    if (r.state === 'done') void this.loadDue().then(this.redraw)
  }

  private async openPractice(id: string) {
    const practice = await db.practice.get(id)
    if (!practice) return void (this.screen = 'drills')
    const game = await db.games.get(practice.gameId)
    const maia = game && { level: this.maiaLevel, moves: game.moves.slice(0, practice.ply).map(m => m.uci) }
    this.screen = 'practice'
    if (!this.keepPracticeRun) this.practiceRun = []
    this.keepPracticeRun = false
    this.run = new PracticeRun(practice, getEngine(), this.redraw, maia)
  }

  // A finished position joins the run when the next one is started from it
  private chainPractice() {
    const r = this.run
    if (!r) return
    if (r.state === 'won' || r.state === 'lost') this.practiceRun.push({ practice: r.practice, won: r.state === 'won' })
    this.keepPracticeRun = true
  }

  // The next open position of a kind after the one on screen
  async nextPosition(kind: PracticeKind) {
    const p = nextOpen(await db.practice.toArray(), kind, this.run?.practice.id)
    if (!p) return
    this.chainPractice()
    this.go('practice', p.id)
  }

  async retryPractice() {
    const id = this.run?.practice.id
    this.chainPractice()
    this.run?.destroy()
    this.run = undefined
    this.redraw()
    if (id) {
      await this.openPractice(id)
      this.redraw()
    }
  }

  // --- games against Maia ---

  // The speed of the time control picked on the card, and its estimate
  get maiaSpeed(): MaiaSpeed {
    return speedOf(this.playChoices.time)
  }

  get maiaEstimate(): { rating: number; from?: MaiaSpeed; games: number } {
    const all = estimates(this.profile?.maia)
    const from = estimateFor(all, this.maiaSpeed, this.maiaStart)
    return { ...from, games: from.from ? all[from.from]!.games : 0 }
  }

  get maiaRating(): number {
    return this.maiaEstimate.rating
  }

  // The estimate at the speed of a given time control ("10+0", "untimed"),
  // which after a game can differ from the one picked on the card
  maiaRatingAt(time: string): number {
    return estimateFor(estimates(this.profile?.maia), speedOf(time), this.maiaStart).rating
  }

  get maiaLevel(): number {
    return this.playLevel ?? levelFor(this.maiaRating)
  }

  // Moves the level by hand; 0 goes back to following the estimate
  stepMaiaLevel(by: number) {
    this.playLevel = by === 0 ? undefined : clampLevel(this.maiaLevel + by)
    this.redraw()
  }

  setPlayChoice(c: Partial<Choices>) {
    this.playChoices = { ...this.playChoices, ...c }
    writeChoices(this.playChoices)
    this.redraw()
  }

  // A new game from the Drills card replaces one left unfinished. from is a
  // start from the player's games, true for any of them, false for move 1.
  startPlay(from: Start | boolean) {
    clearGame()
    this.playFrom = from
    this.playPicking = false
    this.go('play')
  }

  togglePlayPicking() {
    this.playPicking = !this.playPicking
    this.redraw()
  }

  private async openPlay() {
    this.screen = 'play'
    this.playPuzzles = undefined
    if (!this.profile?.maia) this.maiaStart = startEstimate(this.profile?.ratings, await db.games.toArray())
    const saved = readGame()
    if (saved) {
      this.play = new PlayRun(saved.opts, this.redraw, run => void this.finishPlay(run), fetch, Date.now, saved)
      return
    }
    const start = this.playFrom === true ? this.playStarts[Math.floor(Math.random() * this.playStarts.length)] : this.playFrom || undefined
    const { time, color: side, pace } = this.playChoices
    // A position from an own game keeps its side whatever was chosen
    const color = start?.color ?? (side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : side)
    this.play = new PlayRun({ level: this.maiaLevel, color, rating: this.maiaRating, start, clock: clockOf(time), pace }, this.redraw, run => void this.finishPlay(run))
  }

  // A game given up in the first few moves is thrown away. Any other is
  // stored, moves the estimate, and goes through the same analysis as an
  // imported game, which is where its puzzles come from.
  private async finishPlay(run: PlayRun) {
    if (run.tooShort) return void this.loadDue().then(this.redraw)
    const game = run.toGame(Date.now())
    await db.games.add(game)
    const score = run.result === 'win' ? 1 : run.result === 'draw' ? 0.5 : 0
    const all = estimates(this.profile?.maia)
    const speed = speedOf(game.speed)
    const games = all[speed]?.games ?? 0
    const next = { rating: updateEstimate(run.opts.rating, run.opts.level, score, games), games: games + 1 }
    this.profile = await saveProfile({ maia: { ...all, [speed]: next } })
    // Set once the profile has the new estimate, which the screen shows
    run.saved = game
    await this.loadDue()
    this.redraw()
    await this.analyzeNow()
    if (this.play !== run) return
    const done = await db.games.get(game.id)
    if (done?.analyzedAt) {
      run.saved = done
      this.playPuzzles = (await db.puzzles.where('gameId').equals(game.id).sortBy('ply')).map(p => p.id)
    }
    this.redraw()
  }

  // Straight from the finished game, without going back to the Drills card
  rematch() {
    const o = this.play!.opts
    const opts = rematch(o, this.maiaRatingAt(o.clock ? `${o.clock.base / 60}+${o.clock.inc}` : 'untimed'))
    this.play!.destroy()
    this.playPuzzles = undefined
    this.play = new PlayRun(opts, this.redraw, run => void this.finishPlay(run))
    this.redraw()
    window.scrollTo(0, 0)
  }

  // A session of just these puzzles on the daily drill screen
  solvePuzzles(ids: string[]) {
    this.timed = undefined
    this.queue = [...ids]
    this.session = []
    this.sessionDone = false
    this.drills = []
    this.review.reset()
    this.go('drill')
  }

  // Analysis without a sync, which would first have to reach Lichess or
  // Chess.com. While a sync is running the game waits for the next one.
  private async analyzeNow() {
    if (this.syncing || !this.profile) return
    this.syncing = true
    this.abort = new AbortController()
    try {
      await analyzePending(this.profile, this.auth?.token, p => ((this.progress = p), this.refresh()), this.abort.signal)
    } catch (e) {
      await this.signInExpired(e)
      console.warn(e)
    }
    this.syncing = false
    await this.refresh(true)
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
      const missing = !pieces && look.pieceSet ? ` Piece set "${look.pieceSet}" is not in lidrill, so the pieces are unchanged.` : ''
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
      if (!this.studies.length) this.notice = { text: 'No studies on Lichess.' }
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
    if (!confirm("Delete all games, puzzles and history from this browser? This can't be undone.")) return
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
