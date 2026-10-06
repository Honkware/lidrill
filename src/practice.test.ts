import { describe, expect, it } from 'vitest'
import type { Game } from './db'
import { findPractice, verdict } from './practice'
import { pgnMoves } from './sync/pgn'

const game = (pgn: string, evals: number[], extra: Partial<Game>): Game => ({
  id: 'lichess:p',
  site: 'lichess',
  url: '',
  pgn,
  color: 'white',
  result: 'draw',
  rating: 1200,
  speed: 'rapid',
  eco: '',
  opening: '',
  playedAt: 1,
  analyzedAt: 1,
  moves: pgnMoves(pgn)!.map((m, i) => ({ ...m, eval: { cp: evals[i] ?? 0 } })),
  termination: 'draw',
  ...extra,
})

describe('findPractice', () => {
  // black drops the queen on move 2 and white later only draws
  const pgn = '1. e4 e5 2. Qh5 Qh4 3. Qxh4 Nc6 4. Qh3 Nf6 5. Nc3 d6 6. d3 Be7'
  it('finds a conversion position in a game that wasn\'t won', () => {
    const evals = [30, 30, 30, 900, 900, 900, 900, 900, 900, 900, 900, 900]
    const [p] = findPractice(game(pgn, evals, { result: 'draw' }))
    expect(p.kind).toBe('conversion')
    // lead held 4 plies from ply 5 (3.Qxh4): first player-to-move point after that is ply 8
    expect(p.ply).toBe(8)
    expect(findPractice(game(pgn, evals, { result: 'win' }))).toEqual([])
  })
})

describe('verdict', () => {
  it('converts at +10, fails below +2', () => {
    expect(verdict('conversion', 600, 1100, 3)).toBe('won')
    expect(verdict('conversion', 600, 150, 3)).toBe('lost')
    expect(verdict('conversion', 600, 600, 3)).toBeUndefined()
  })
  it('defends by holding within a pawn of the start', () => {
    expect(verdict('defense', -300, -550, 2)).toBe('lost')
    expect(verdict('defense', -300, -350, 12)).toBe('won')
    expect(verdict('defense', -300, -350, 5)).toBeUndefined()
  })
})
