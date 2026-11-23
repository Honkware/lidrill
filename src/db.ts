import type { CertTier, EngineRun, Packet } from './server/packet'
import type { Slot } from './server/render'
import Dexie, { type EntityTable, type Table } from 'dexie'
import type { Card } from 'ts-fsrs'
import type { Perf, Speed } from './lichess/api'
import type { WeakTheme } from './lichess/puzzles'

// 'maia' games were played here against Maia-3; they have no url
export type Site = 'lichess' | 'chesscom' | 'maia'
export type Result = 'win' | 'loss' | 'draw'

// White's point of view. A checkmated position is stored as cp ±10000 so it
// sorts and compares like any other eval.
export interface Eval {
  cp?: number
  mate?: number
}

export type Judgment = 'inaccuracy' | 'mistake' | 'blunder'

export interface Move {
  san: string
  uci: string
  // Filled in by the analyzer: the eval after this move
  eval?: Eval
  judg?: Judgment
  book?: boolean
}

export interface Game {
  id: string // `${site}:${siteGameId}`
  site: Site
  url: string
  pgn: string
  color: 'white' | 'black'
  result: Result
  rating: number // the player's rating at the time, for the band
  opponent?: string // missing on games imported before v5
  opponentRating?: number
  speed: string // bullet/blitz/rapid/classical/daily; daily is kept out of time stats
  eco: string
  opening: string
  playedAt: number
  analyzedAt?: number
  moves: Move[]
  termination: string
  clocks?: number[] // centiseconds left after each move
  accuracy?: number // Lichess accuracy %, when the game was analyzed there
  division?: { middle?: number; end?: number } // plies where middlegame/endgame start
  serverAnalysis?: boolean // evals came from Lichess's analysis
  puzzlesVersion?: number // GENERATOR_VERSION that made its puzzles; missing = 1
}

export interface SyncState {
  site: Site
  user: string
  lastPlayedAt: number
  // Chess.com archive months that can't change any more ("2026/09")
  doneMonths: string[]
}

export type PuzzleType = 'hang' | 'missed-win' | 'conversion' | 'external'
export type PuzzleTag = 'hang' | 'mate' | 'defensive'

export type PuzzleSource = 'own' | 'lichess'

// A board link for a move or square in an explanation, checked on the server
export interface ExplanationLink {
  index: number // where the move or square starts in the text
  text: string
  from?: string
  to: string
  fen?: string // the position the move is played from
  after?: string // and the position after it
}

export interface Explanation {
  text: string
  links: ExplanationLink[]
  version?: number // EXPLAIN_VERSION of the server logic that made it
  tried?: string // UCI of the wrong first try it also explains
  cue?: string // one habit for next time
}

// A "Why?" explanation: the four slots in ref form, with
// the packet that renders them. Text is rendered at serve time, never
// stored, so a renderer change takes effect without asking again.
export interface ExplanationRow {
  id: string // `${puzzleId}|${tried ?? ''}`
  puzzleId: string
  tried?: string // UCI of the first wrong try it also explains
  dedupeKey: string
  packetHash: string
  band: Band
  slots: Slot[]
  floor: boolean // the fixed text, not the narrator's
  models?: string[] // which models the router used, when the narrator wrote it
  certTier?: CertTier // which device certified the packet; rows from before are stamped client-lite by the backfill
  promptVersion: string
  version: number // EXPLAIN_VERSION when it was made
  habitId: string | null // for the next explanations' anti-repeat window; null when no habit fit the packet
  createdAt: number
  packet: Packet
}

export interface Puzzle {
  id: string // `${gameId}:${ply}`, or `lichess:${puzzleId}` for Lichess puzzles
  gameId: string // '' for Lichess puzzles
  // Missing on puzzles made before v5: those are all 'own'. 'lichess' puzzles
  // are the external tier, capped at 30% of a day's queue.
  source?: PuzzleSource
  themes?: string[] // Lichess puzzle themes
  before?: string // Lichess puzzles: the FEN before the opponent's last move, to animate it in
  lastMove?: string
  rating?: number // Lichess puzzle rating
  ply: number // the position before this ply is the puzzle
  fen: string
  played: string // UCI of what the player actually played
  solution: string[] // UCI, player and opponent moves alternating
  explanation?: Explanation | string // the "Why?" text, kept so it's only generated once (string: older, unlinked)
  // "Hold" puzzles: every first move that keeps the position (one-move only)
  alternatives?: string[]
  solutionLen: number // player moves in the solution
  type: PuzzleType
  tag: PuzzleTag
  swingCp: number
  card: Card
}

export type Band = 'beginner' | 'club' | 'advanced'

export type MaiaSpeed = 'blitz' | 'rapid' | 'untimed'
export interface Estimate {
  rating: number
  games: number
}

export interface Profile {
  id: 'me'
  lichessUser?: string
  chesscomUser?: string
  band: Band
  bandHistory: { band: Band; at: number }[]
  swingThresholdCp: number
  marginCp: number
  thresholdHistory?: { cp: number; at: number; solveRate: number }[] // calibration audit
  repertoire?: string[] // opening families the plan aims for, once chosen in Settings; the trained openings replaced it
  repertoireStudy?: { id: string; name: string; lines: string[][] } // or a Lichess study's chapters
  openings?: Opening[] // trained in the opening trainer, see openings/
  ratings?: Partial<Record<Speed | 'puzzle', Perf>> // from /api/account when signed in
  weakThemes?: WeakTheme[] // from the Lichess puzzle dashboard
  puzzleActivityAt?: number // newest Lichess puzzle activity already read
  // Strength estimates from games against Maia, one per speed, see maia.ts.
  // A single estimate is the shape from before the split and can still
  // arrive from another device.
  maia?: Partial<Record<MaiaSpeed, Estimate>> | Estimate
  theme?: 'dark' | 'light'
  pieces?: string // piece set key, see look.ts
  board?: string
}

export interface JournalEntry {
  gameId: string
  at: number
  opening: string
  // The worst hang by the band's definition, or none for a zero-hang game
  hung?: { ply: number; san: string; swingCp: number }
  note?: string
  confirmed: boolean
}

export type PracticeKind = 'conversion' | 'defense'

// A conversion or defense drill position
export interface Practice {
  id: string // `${gameId}:${ply}:${kind}`
  gameId: string
  ply: number
  fen: string
  kind: PracticeKind
  startCp: number // engine eval for the player at the start
  streak: number // successes in a row
  attempts: number
  cleared: boolean // 3 in a row
}

// Weekly snapshot of the Lichess puzzle dashboard
export interface PuzzleDashboardSnapshot {
  week: string // ISO date of that week's Monday
  global: { nb: number; firstWins: number; performance: number }
  themes: Record<string, { nb: number; firstWins: number; performance: number }>
}

export interface Review {
  id?: number
  puzzleId: string
  at: number
  solved: boolean
  hinted?: boolean // solved after showing the hint: scheduled Hard, not counted as solved
  whyMissed?: string
  source?: 'queue' | 'replay' // missing on older rows: 'queue'
}

// Stockfish's certification runs for a puzzle, done ahead in idle time so
// "Why?" only has to check the player's wrong try (a cache, not exported)
export interface CertRow {
  puzzleId: string
  version: string
  runs: Record<string, EngineRun[]> // best, threat, played
  createdAt: number
}

// One Turning Points run: its stops are ordinary review rows, so
// the scheduler counts them; this row is the score for the end screen
export interface ReplaySession {
  id?: number
  gameId: string
  at: number
  stops: number[] // review ids
  scoreN: number
  scoreM: number
}

// An opening the player trains, by its defining moves (UCI from the start)
export interface Opening {
  name: string
  color: 'white' | 'black'
  moves: string[]
}

// Highest rank wins a position: a Lichess study the player keeps, then a
// move they added here, then a built-in opening's moves, then what they
// most often play in their games, and last the move the trainer recommends
// where the player has none of their own
export type RepSource = 'rec' | 'games' | 'builtin' | 'own' | 'study'

// The player's move in a position on their own side. fen has no move
// counters, so a position reached by two move orders is one entry.
export interface RepMove {
  fen: string
  uci: string
  source: RepSource
}

// A position in an opening tree with the player to move: recall when the
// repertoire has a move there, "they played this instead" when it doesn't
export interface OpeningCard {
  id: string // the position, as RepMove.fen
  opening: string
  moves: string[] // UCI from the start
  reach: number // chance of getting here from the end of the opening's moves against Maia
  wrong?: boolean // one of the player's games went wrong here
  learnedAt?: number // when a learn line first taught it, for the daily limit
  card: Card
}

// Maia's move probabilities by level and position, a cache
export interface PolicyRow {
  key: string // `${level}|${fen without counters}`
  moves: { uci: string; p: number }[]
}

// Never exported, never logged
export interface Auth {
  id: 'lichess'
  username: string
  token: string
  scopes: string[]
  grantedAt: number
}

// Tables replicated to the lidrill server: everything
// the export carries except explanations (those live in the packet KV) and
// caches. `auth` (the token) is never synced.
export const SYNC_TABLES = ['games', 'puzzles', 'reviews', 'profile', 'syncState', 'journal', 'liPuzzle', 'practice', 'replaySessions', 'repertoire', 'openingCards'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

// Auto-increment keys don't exist at hook time (Dexie assigns them after the
// add resolves), so those tables are queued explicitly at their write sites
export const SYNC_AUTO_ID: SyncTable[] = ['reviews', 'replaySessions']

// Every synced table's primary-key field, for the sync queue
export const SYNC_ID: Record<SyncTable, string> = {
  games: 'id',
  puzzles: 'id',
  reviews: 'id',
  profile: 'id',
  syncState: 'site',
  journal: 'gameId',
  liPuzzle: 'week',
  practice: 'id',
  replaySessions: 'id',
  repertoire: 'fen',
  openingCards: 'id',
}

// A row was written locally and hasn't reached the server yet. `at` is the
// write time; the server compares it against what it has (newer wins).
export interface SyncQueueEntry {
  table: SyncTable
  key: string
  at: number
}

// Sync watermarks and one-shot flags for the server pass
export interface ServerMetaEntry {
  key: string
  value: number
}

class LidrillDb extends Dexie {
  games!: EntityTable<Game, 'id'>
  syncState!: EntityTable<SyncState, 'site'>
  puzzles!: EntityTable<Puzzle, 'id'>
  profile!: EntityTable<Profile, 'id'>
  reviews!: EntityTable<Review, 'id'>
  auth!: EntityTable<Auth, 'id'>
  explorer!: EntityTable<{ key: string; moves: Record<string, number>; opening?: { eco: string; name: string } }, 'key'>
  journal!: EntityTable<JournalEntry, 'gameId'>
  liPuzzle!: EntityTable<PuzzleDashboardSnapshot, 'week'>
  practice!: EntityTable<Practice, 'id'>
  explanations!: EntityTable<ExplanationRow, 'id'>
  replaySessions!: EntityTable<ReplaySession, 'id'>
  certs!: EntityTable<CertRow, 'puzzleId'>
  syncQueue!: Table<SyncQueueEntry, [string, string]>
  serverMeta!: EntityTable<ServerMetaEntry, 'key'>
  repertoire!: EntityTable<RepMove, 'fen'>
  openingCards!: EntityTable<OpeningCard, 'id'>
  policy!: EntityTable<PolicyRow, 'key'>

  constructor() {
    super('lidrill')
    this.version(1).stores({
      games: 'id, site, playedAt, analyzedAt',
      syncState: 'site',
    })
    this.version(2).stores({
      puzzles: 'id, gameId, card.due, type',
      profile: 'id',
    })
    this.version(3).stores({
      reviews: '++id, puzzleId, at',
    })
    this.version(4).stores({
      auth: 'id',
    })
    this.version(5).stores({
      explorer: 'key',
      journal: 'gameId, at',
      liPuzzle: 'week',
      practice: 'id, gameId, kind',
    })
    this.version(6).stores({
      explanations: 'id, puzzleId, createdAt, dedupeKey',
      replaySessions: '++id, gameId, at',
      certs: 'puzzleId, createdAt',
    })
    this.version(7).stores({
      syncQueue: '[table+key], table',
      serverMeta: 'key',
    })
    this.version(8).stores({
      repertoire: 'fen',
      openingCards: 'id, card.due, opening',
      policy: 'key',
    })
  }
}

export const db = new LidrillDb()

// Queue every local write to a synced table so the server pass pushes just
// the dirty rows. A failed push keeps its entries for
// the next pass; deletions aren't queued (v1 has no tombstones - rows are
// only ever added or updated).
let stampingSuspended = false

// Applying pulled rows writes with the server's data; those writes must not
// re-queue themselves for push.
export async function withoutSyncQueue<T>(f: () => Promise<T>): Promise<T> {
  stampingSuspended = true
  try {
    return await f()
  } finally {
    stampingSuspended = false
  }
}

// Queue a locally-written row for the next server push. The Dexie hooks
// below call this for tables whose key exists at write time; the
// auto-increment tables (SYNC_AUTO_ID) call it at their write sites, where
// the generated id is known. ignoreTransaction: hooks run inside the write's
// transaction, which doesn't cover the syncQueue store.
export async function queueSyncRow(table: SyncTable, key: string | number): Promise<void> {
  if (stampingSuspended) return
  await Dexie.ignoreTransaction(async () => {
    await db.syncQueue.put({ table, key: String(key), at: Date.now() })
  })
}

for (const name of SYNC_TABLES.filter(t => !SYNC_AUTO_ID.includes(t))) {
  db.table(name).hook('creating', (pk, _obj) => {
    if (pk !== undefined) void queueSyncRow(name, String(pk))
  })
  db.table(name).hook('updating', (mods, pk) => {
    void queueSyncRow(name, String(pk))
    return mods
  })
}
