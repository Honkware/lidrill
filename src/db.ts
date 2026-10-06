import Dexie, { type EntityTable } from 'dexie'
import type { Card } from 'ts-fsrs'
import type { Perf, Speed } from './lichess/api'
import type { WeakTheme } from './lichess/puzzles'

export type Site = 'lichess' | 'chesscom'
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

export interface Profile {
  id: 'me'
  lichessUser?: string
  chesscomUser?: string
  band: Band
  bandHistory: { band: Band; at: number }[]
  swingThresholdCp: number
  marginCp: number
  thresholdHistory?: { cp: number; at: number; solveRate: number }[] // calibration audit
  repertoire?: string[] // opening families the plan aims for, editable in Settings
  repertoireStudy?: { id: string; name: string; lines: string[][] } // or a Lichess study's chapters
  ratings?: Partial<Record<Speed | 'puzzle', Perf>> // from /api/account when signed in
  weakThemes?: WeakTheme[] // from the Lichess puzzle dashboard
  puzzleActivityAt?: number // newest Lichess puzzle activity already read
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
}

// Never exported, never logged
export interface Auth {
  id: 'lichess'
  username: string
  token: string
  scopes: string[]
  grantedAt: number
}

class LidrillDb extends Dexie {
  games!: EntityTable<Game, 'id'>
  syncState!: EntityTable<SyncState, 'site'>
  puzzles!: EntityTable<Puzzle, 'id'>
  profile!: EntityTable<Profile, 'id'>
  reviews!: EntityTable<Review, 'id'>
  auth!: EntityTable<Auth, 'id'>
  explorer!: EntityTable<{ key: string; moves: Record<string, number> }, 'key'>
  journal!: EntityTable<JournalEntry, 'gameId'>
  liPuzzle!: EntityTable<PuzzleDashboardSnapshot, 'week'>
  practice!: EntityTable<Practice, 'id'>

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
  }
}

export const db = new LidrillDb()
