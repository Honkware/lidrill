import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import { describe, expect, it } from 'vitest'
import type { Game, Opening } from '../db'
import { pgnMoves } from '../sync/pgn'
import type { Reply } from './policy'
import { keyOf } from './repertoire'
import { buildTree, coverage, gameCards, unlearned, wentWrong } from './tree'

// The tree on a small opening with stated probabilities. The opening runs
// to 6. O-O in the Giuoco Pianissimo, so Black's 6th and 7th moves are the
// only branching before the depth (White's 8th move) is past.

const opening: Opening = {
  name: 'Italian Game',
  color: 'white',
  moves: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6 e1h1'.split(' '),
}
const o = opening.moves.join(' ')

// Kf8 is under the 5% cut, so its position is never reached
const replies: Record<string, Reply[]> = {
  [o]: [
    { uci: 'a7a6', p: 0.5 },
    { uci: 'e8h8', p: 0.3 },
    { uci: 'h7h6', p: 0.17 },
    { uci: 'e8f8', p: 0.03 },
  ],
  [`${o} a7a6 a2a4`]: [
    { uci: 'e8h8', p: 0.6 },
    { uci: 'c5a7', p: 0.4 },
  ],
  [`${o} e8h8 f1e1`]: [{ uci: 'a7a6', p: 1 }],
  [`${o} h7h6 f1e1`]: [{ uci: 'e8h8', p: 1 }],
}
const policy = async (moves: string[]) => {
  const r = replies[moves.join(' ')]
  if (!r) throw new Error(`not scripted: ${moves.join(' ')}`)
  return r
}

const keyAfter = (ucis: string) => {
  const pos = Chess.default()
  for (const u of ucis.split(' ')) pos.play(parseUci(u)!)
  return keyOf(pos)
}

// 6...a6 7.a4 O-O 8.Re1 and 6...O-O 7.Re1 a6 8.a4; nothing after 6...h6 or 7...Ba7
const known = () =>
  new Map([
    [keyAfter(`${o} a7a6`), 'a2a4'],
    [keyAfter(`${o} a7a6 a2a4 e8h8`), 'f1e1'],
    [keyAfter(`${o} e8h8`), 'f1e1'],
    [keyAfter(`${o} e8h8 f1e1 a7a6`), 'a2a4'],
  ])

const recs: Record<string, string> = {
  [`${o} h7h6`]: 'f1e1',
  [`${o} h7h6 f1e1 e8h8`]: 'a2a4',
  [`${o} a7a6 a2a4 c5a7`]: 'f1e1',
}
const recommend = async (moves: string[]) => recs[moves.join(' ')]

describe('buildTree', () => {
  it('stops where the repertoire has no move and nothing is recommended', async () => {
    const tree = await buildTree(opening, known(), policy)
    expect(tree.nodes).toHaveLength(6)
    expect(tree.nodes.filter(n => !n.answer).map(n => n.moves.at(-1))).toEqual(['c5a7', 'h7h6'])
    expect(tree.nodes.some(n => n.moves.includes('e8f8'))).toBe(false)
  })

  it('walks on past a recommended move and keeps the ones it found', async () => {
    const rep = known()
    const tree = await buildTree(opening, rep, policy, recommend)
    expect(tree.nodes).toHaveLength(7)
    expect(tree.nodes.every(n => n.answer)).toBe(true)
    expect(tree.recs.map(r => r.uci)).toEqual(['f1e1', 'f1e1', 'a2a4'])
    expect(rep.get(keyAfter(`${o} h7h6 f1e1 e8h8`))).toBe('a2a4')
  })
})

describe('coverage', () => {
  const node = (fen: string, reach: number, answer?: string) => ({ fen, moves: [], reach, answer })
  const nodes = [node(keyAfter('e2e4'), 0.6, 'e7e5'), node(keyAfter('d2d4'), 0.3, 'd7d5'), node(keyAfter('c2c4'), 0.1)]

  it("is the learned share of the player's turns, each weighted by its chance", () => {
    expect(coverage(nodes, new Set([keyAfter('e2e4')]))).toBeCloseTo(0.6, 6)
    expect(coverage(nodes, new Set())).toBe(0)
    expect(coverage([], new Set())).toBe(1)
  })

  it('leaves a learned position out of what is new, and a position with no move to learn', () => {
    expect(unlearned(nodes, new Set([keyAfter('e2e4')])).map(n => n.answer)).toEqual(['d7d5'])
  })
})

describe('gameCards', () => {
  const game = (pgn: string, judgedAt?: number): Game => {
    const moves = pgnMoves(pgn)!
    if (judgedAt !== undefined) moves[judgedAt] = { ...moves[judgedAt], judg: 'mistake' }
    return { id: 'lichess:g', site: 'lichess', url: '', pgn, color: 'white', result: 'loss', rating: 1500, speed: 'rapid', eco: '', opening: '', playedAt: 1, moves, termination: '' }
  }
  const italian: Opening = { name: 'Italian Game', color: 'white', moves: opening.moves.slice(0, 5) }
  const c3 = new Map([[keyAfter('e2e4 e7e5 g1f3 b8c6 f1c4 f8c5'), 'c2c3']])

  it('makes a card where the player first left their repertoire', () => {
    const cards = gameCards(game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. Nc3 d6'), c3, [italian], new Set())
    expect(cards).toEqual([{ fen: expect.stringMatching(/^r1bqk1nr/), moves: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5'.split(' '), opening: 'Italian Game' }])
  })

  it('makes a card where the repertoire had nothing and the player went wrong, and none outside the openings', () => {
    // 5. Ng5 judged a mistake, after 4. c3 from the repertoire
    const g = game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. Ng5 O-O', 8)
    const wrong = wentWrong([g])
    expect([...wrong]).toEqual([keyAfter('e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6')])
    expect(gameCards(g, c3, [italian], wrong).map(c => c.moves.length)).toEqual([8])
    expect(gameCards(game('1. d4 d5 2. c4 e6'), c3, [italian], new Set())).toEqual([])
  })
})
