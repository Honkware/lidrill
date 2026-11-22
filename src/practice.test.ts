import { describe, expect, it } from 'vitest'
import type { Engine } from './analysis/engine'
import type { Game, Practice } from './db'
import { findPractice, PracticeRun, verdict } from './practice'
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

// A drill against a scripted opponent: the fetch stands in for the Maia
// endpoint, and the engine always says the player is 6 pawns up and would
// answer Nc6.
describe('PracticeRun', () => {
  const practice: Practice = {
    id: 'lichess:p:2:conversion',
    gameId: 'lichess:p',
    ply: 2,
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    kind: 'conversion',
    startCp: 600,
    streak: 0,
    attempts: 0,
    cleared: false,
  }
  const maia = { level: 1500, moves: ['e2e4', 'e7e5'] }
  const engine = { search: async () => ({ eval: { cp: -600 }, pv: ['b8c6'], depth: 10, multipv: 1 }) } as unknown as Engine

  // Answers from a list; once it runs out the request itself fails, as it
  // does offline
  function scripted(...answers: string[]) {
    const asked: { moves: string[]; level: number }[] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)) as { moves: string[]; level: number })
      const answer = answers.shift()
      if (!answer) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ move: answer }))
    }) as typeof fetch
    return { asked, fetchFn }
  }

  async function play(run: PracticeRun, move: string) {
    run.typeMove(move)
    await expect.poll(() => run.state).toBe('your-move')
  }

  it('plays Maia\'s reply and sends it the whole game so far', async () => {
    const { asked, fetchFn } = scripted('g8f6', 'f8c5')
    const run = new PracticeRun(practice, engine, () => {}, maia, fetchFn)
    await play(run, 'Nf3')
    await play(run, 'Nc3')
    expect(asked).toEqual([
      { moves: ['e2e4', 'e7e5', 'g1f3'], level: 1500 },
      { moves: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'b1c3'], level: 1500 },
    ])
    expect([run.last, run.lastBy, run.cp]).toEqual(['Bc5', 'Maia', 600])
  })

  it('takes the engine\'s reply when Maia cannot be reached', async () => {
    const run = new PracticeRun(practice, engine, () => {}, maia, scripted().fetchFn)
    await play(run, 'Nf3')
    expect([run.last, run.lastBy]).toEqual(['Nc6', 'Stockfish'])
  })

  it('takes the engine\'s reply when Maia answers with an illegal move', async () => {
    const run = new PracticeRun(practice, engine, () => {}, maia, scripted('e8e6').fetchFn)
    await play(run, 'Nf3')
    expect([run.last, run.lastBy]).toEqual(['Nc6', 'Stockfish'])
  })

  it('uses the engine for the whole drill when the game is missing', async () => {
    const { asked, fetchFn } = scripted('g8f6')
    const run = new PracticeRun(practice, engine, () => {}, undefined, fetchFn)
    await play(run, 'Nf3')
    expect([run.opponent, run.last, run.lastBy, asked]).toEqual(['Stockfish', 'Nc6', 'Stockfish', []])
  })
})
