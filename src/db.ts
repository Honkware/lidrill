import Dexie, { type EntityTable } from 'dexie'

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

class LidrillDb extends Dexie {
  games!: EntityTable<Game, 'id'>
  syncState!: EntityTable<SyncState, 'site'>

  constructor() {
    super('lidrill')
    this.version(1).stores({
      games: 'id, site, playedAt, analyzedAt',
      syncState: 'site',
    })
  }
}

export const db = new LidrillDb()
