import { createEmptyCard } from 'ts-fsrs'
import { describe, expect, it } from 'vitest'
import type { Engine } from './analysis/engine'
import type { Puzzle } from './db'
import { explainRequest, lineFacts } from './explain'
import { validate } from './server/explain'

const fen = 'rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6'

describe('lineFacts', () => {
  it('writes SAN and how the line ends for the side to move', () => {
    expect(lineFacts(fen, ['c4f7', 'e8e7', 'c3d5'])).toEqual({ san: ['Bxf7+', 'Ke7', 'Nd5#'], end: 'mate' })
    // Kxd1 dxe5: bishop for knight, level
    expect(lineFacts(fen, ['e1d1', 'd6e5'])).toEqual({ san: ['Kxd1', 'dxe5'], end: 'material even' })
    // Nxd... the knight takes on f7 for nothing: a pawn up for White
    expect(lineFacts(fen, ['e5f7']).end).toBe('material +1')
  })
})

describe('explainRequest', () => {
  it('builds a request the server accepts, with evals from the engine', async () => {
    const engine = { search: async () => ({ eval: { cp: -150 }, pv: ['g8f6', 'd2d3'], depth: 14, multipv: 1 }) } as unknown as Engine
    const p: Puzzle = { id: 'x', gameId: '', ply: 11, fen, played: 'e1d1', solution: ['c4f7', 'e8e7', 'c3d5'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 900, card: createEmptyCard() }
    const req = await explainRequest(p, engine)
    expect(req.best.san.slice(0, 3)).toEqual(['Bxf7+', 'Ke7', 'Nd5#'])
    expect(req.played?.san[0]).toBe('Kxd1')
    expect(req.played?.cp).toBe(150) // the engine's -150 for Black is +150 for White, who just moved
    expect(validate(JSON.parse(JSON.stringify(req)))).toBeTruthy()

    // The player's wrong first try comes along, refuted; the game move doesn't twice
    const withTry = await explainRequest(p, engine, 'c4b5')
    expect(withTry.tried?.san[0]).toBe('Bb5+')
    expect(validate(JSON.parse(JSON.stringify(withTry)))?.tried).toBeTruthy()
    expect((await explainRequest(p, engine, 'e1d1')).tried).toBeUndefined()
  })
})
