import { describe, expect, it } from 'vitest'
import type { Game } from './db'
import { clampLevel, estimateFor, estimates, expectedScore, fetchMove, levelFor, MAX_LEVEL, MIN_LEVEL, ownStarts, speedOf, startEstimate, startLabel, updateEstimate, type Start } from './maia'
import { pgnMoves } from './sync/pgn'

const game = (over: Partial<Game> = {}): Game => ({
  id: 'lichess:g',
  site: 'lichess',
  url: '',
  pgn: '',
  color: 'white',
  result: 'loss',
  rating: 1200,
  speed: 'rapid',
  eco: '',
  opening: 'Italian Game: Giuoco Piano',
  playedAt: 1,
  analyzedAt: 1,
  moves: [],
  termination: '',
  ...over,
})

describe('levelFor', () => {
  it('plays 50 above the estimate', () => {
    expect(levelFor(1500)).toBe(1550)
    expect(levelFor(1437)).toBe(1487)
    expect(expectedScore(1500, 1550)).toBeCloseTo(0.43, 2)
  })
  it('never leaves the measured range', () => {
    expect(levelFor(300)).toBe(MIN_LEVEL)
    expect(levelFor(2900)).toBe(MAX_LEVEL)
    expect(clampLevel(1234.4)).toBe(1234)
  })
})

describe('updateEstimate', () => {
  it('moves up after a win and down after a loss, more for the surprising result', () => {
    expect(updateEstimate(1500, 1550, 1, 20) - 1500).toBe(37)
    expect(1500 - updateEstimate(1500, 1550, 0, 20)).toBe(27)
    expect(updateEstimate(1500, 1500, 0.5, 20)).toBe(1500)
  })
  it('moves twice as far in the first five games', () => {
    expect(updateEstimate(1500, 1550, 1, 0) - 1500).toBe(73)
    expect(updateEstimate(1500, 1550, 1, 4) - 1500).toBe(73)
    expect(updateEstimate(1500, 1550, 1, 5) - 1500).toBe(37)
  })
  // someone who really is `truth` playing whatever level the rule picks
  const settle = (truth: number, est: number, games: (i: number) => number, until: (est: number, i: number) => boolean) => {
    let i = 0
    while (!until(est, i)) est = updateEstimate(est, levelFor(est), expectedScore(truth, levelFor(est)), games(i++))
    return { est, i }
  }
  it('settles where the player scores what the level predicts', () => {
    const { est } = settle(1300, 1900, i => i, (_, i) => i === 200)
    expect(Math.abs(est - 1300)).toBeLessThan(15)
  })
  it('gets a new player 300 off the guess within 100 in 9 games instead of 14', () => {
    expect(settle(1300, 1600, i => i, est => est < 1400).i).toBe(9)
    expect(settle(1300, 1600, () => 20, est => est < 1400).i).toBe(14)
  })
  it('stays within 100 of the range', () => {
    expect(updateEstimate(2400, 2300, 1, 20)).toBe(2400)
    expect(updateEstimate(500, 600, 0, 20)).toBe(500)
  })
})

describe('speedOf', () => {
  it('splits blitz from rapid at 8 minutes of base time plus 40 increments', () => {
    expect(['3+2', '5+0', '5+3', '10+0', '10+5', '15+10'].map(speedOf)).toEqual(['blitz', 'blitz', 'blitz', 'rapid', 'rapid', 'rapid'])
    expect(speedOf('7+2')).toBe('rapid')
    expect(speedOf('7+1')).toBe('blitz')
  })
  it('counts a game without a clock as untimed, as picked or as stored', () => {
    expect(speedOf('unlimited')).toBe('untimed')
    expect(speedOf('untimed')).toBe('untimed')
  })
})

describe('estimates', () => {
  it('reads a single estimate from before the split as the untimed one', () => {
    expect(estimates({ rating: 1420, games: 12 })).toEqual({ untimed: { rating: 1420, games: 12 } })
    expect(estimates({ blitz: { rating: 1300, games: 3 } })).toEqual({ blitz: { rating: 1300, games: 3 } })
    expect(estimates(undefined)).toEqual({})
  })
  it('starts a speed with no games from the one with the most games, else the guess', () => {
    const all = { blitz: { rating: 1300, games: 3 }, untimed: { rating: 1500, games: 9 } }
    expect(estimateFor(all, 'blitz', 1000)).toEqual({ rating: 1300, from: 'blitz' })
    expect(estimateFor(all, 'rapid', 1000)).toEqual({ rating: 1500, from: 'untimed' })
    expect(estimateFor({}, 'rapid', 1000)).toEqual({ rating: 1000, from: undefined })
  })
})

describe('startEstimate', () => {
  it('uses the Lichess blitz rating when there is one', () => {
    expect(startEstimate({ blitz: { rating: 1432, games: 80 }, rapid: { rating: 1600, games: 9 } }, [game()])).toBe(1432)
  })
  it('falls back to the median rating of imported games, ignoring games against Maia', () => {
    const games = [game({ rating: 900 }), game({ rating: 1100 }), game({ rating: 1000 }), game({ site: 'maia', rating: 2000 }), game({ site: 'maia', rating: 2000 })]
    expect(startEstimate(undefined, games)).toBe(1000)
    expect(startEstimate(undefined, [])).toBe(1000)
  })
})

describe('ownStarts', () => {
  const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O O-O 7. Re1 a6 8. Bb3 Ba7 9. h3 h6 10. Nbd2 Re8 11. Nf1 Be6'
  const analyzed = (book: number, cp: number, over: Partial<Game> = {}) =>
    game({ moves: pgnMoves(pgn)!.map((m, i) => ({ ...m, book: i < book, eval: i < book ? undefined : { cp } })), ...over })

  it('starts on the player\'s first turn after the book moves', () => {
    const [white] = ownStarts([analyzed(8, 20)])
    expect(white.moves.map(m => m.san).at(-1)).toBe('d6')
    expect(white.moves).toHaveLength(10)
    const [black] = ownStarts([analyzed(8, 20, { color: 'black' })])
    expect(black.moves).toHaveLength(9)
    expect(black.color).toBe('black')
  })
  it('skips games where one side was already more than a pawn ahead', () => {
    expect(ownStarts([analyzed(8, 180)])).toEqual([])
    expect(ownStarts([analyzed(8, -100)])).toHaveLength(1)
  })
  it('skips unanalyzed games, games against Maia and games that end soon after the opening', () => {
    expect(ownStarts([analyzed(8, 0, { analyzedAt: undefined })])).toEqual([])
    expect(ownStarts([analyzed(8, 0, { site: 'maia' })])).toEqual([])
    expect(ownStarts([analyzed(14, 0)])).toEqual([])
  })
})

describe('startLabel', () => {
  const start = (over: Partial<Start> = {}): Start => ({ gameId: 'g', color: 'white', opening: 'Italian Game: Giuoco Piano', playedAt: 1, moves: Array(10).fill({ san: 'e4', uci: 'e2e4' }), ...over })

  it('names the opening family, the move about to be played and the side', () => {
    expect(startLabel(start())).toBe('Italian Game, move 6, you were White')
    expect(startLabel(start({ color: 'black', moves: start().moves.slice(1) }))).toBe('Italian Game, move 5, you were Black')
  })
  it('says your game when the opening has no name', () => {
    expect(startLabel(start({ opening: '' }))).toBe('Your game, move 6, you were White')
  })
})

describe('fetchMove', () => {
  it('posts the game and the level and returns the move', async () => {
    let sent: unknown
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ move: 'e7e5' }))
    }) as typeof fetch
    expect(await fetchMove(['e2e4'], 1500, undefined, fetchFn)).toEqual({ move: 'e7e5', think: 0 })
    expect(sent).toEqual({ moves: ['e2e4'], level: 1500 })
  })
  it('sends the clock with Maia\'s time left and returns how long a person would think', async () => {
    let sent: unknown
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ move: 'e7e5', think: 4.2 }))
    }) as typeof fetch
    expect(await fetchMove(['e2e4'], 1500, { base: 300, inc: 3, left: 287.4 }, fetchFn)).toEqual({ move: 'e7e5', think: 4.2 })
    expect(sent).toEqual({ moves: ['e2e4'], level: 1500, clock: { base: 300, inc: 3, left: 287.4 } })
  })
  it('fails with the server\'s message, or a plain one when there is no JSON', async () => {
    const limited = (async () => new Response(JSON.stringify({ error: 'Too many moves at once. Try again in a minute.' }), { status: 429 })) as typeof fetch
    await expect(fetchMove([], 1500, undefined, limited)).rejects.toThrow('Too many moves')
    const down = (async () => new Response('<html>', { status: 404 })) as typeof fetch
    await expect(fetchMove([], 1500, undefined, down)).rejects.toThrow('Maia isn’t available')
  })
})
