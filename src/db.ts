import Dexie, { type EntityTable } from 'dexie'
import type { Card } from 'ts-fsrs'

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
  speed: string // bullet/blitz/rapid/classical/daily; daily is kept out of time stats
  eco: string
  opening: string
  playedAt: number
  analyzedAt?: number
  moves: Move[]
  termination: string
  clocks?: number[] // centiseconds left after each move
}

export interface SyncState {
  site: Site
  user: string
  lastPlayedAt: number
  // Chess.com archive months that can't change any more ("2026/09")
  doneMonths: string[]
}

export type PuzzleType = 'hang' | 'missed-win' | 'conversion'
export type PuzzleTag = 'hang' | 'mate' | 'defensive'

export interface Puzzle {
  id: string // `${gameId}:${ply}`
  gameId: string
  ply: number // the position before this ply is the puzzle
  fen: string
  played: string // UCI of what the player actually played
  solution: string[] // UCI, player and opponent moves alternating
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
}

export interface Review {
  id?: number
  puzzleId: string
  at: number
  solved: boolean
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
  }
}

export const db = new LidrillDb()
