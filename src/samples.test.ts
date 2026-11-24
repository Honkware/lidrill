// @vitest-environment node
// The Node build of Stockfish thinks it's in a browser under jsdom.
import { createRequire } from 'node:module'
import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { parseSquare, parseUci } from 'chessops/util'
import { describe, expect, it } from 'vitest'
import { Engine, type UciEngine } from './analysis/engine'
import { SAMPLES } from './samples'

// The first-visit puzzles are shown with no engine behind them, so what
// they claim is checked here: every stored move is legal, and the move to
// find is Stockfish's by a margin nobody would argue with.

const require = createRequire(import.meta.url)

const MARGIN_CP = 250
const DEPTH = 16

const at = (fen: string) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap()

// Plays the moves, failing on the first illegal one
function play(fen: string, ucis: string[]): Chess {
  const pos = at(fen)
  for (const uci of ucis) {
    const move = parseUci(uci)!
    expect(pos.isLegal(move), `${uci} in ${makeFen(pos.toSetup())}`).toBe(true)
    pos.play(move)
  }
  return pos
}

describe('sample puzzles', () => {
  it('there are three, with ids that cannot be a stored puzzle', () => {
    expect(SAMPLES.map(s => s.puzzle.id)).toEqual(['sample:1', 'sample:2', 'sample:3'])
  })

  it("the opponent's last move leads to the puzzle position", () => {
    for (const { puzzle: p } of SAMPLES) expect(makeFen(play(p.before!, [p.lastMove!]).toSetup())).toBe(p.fen)
  })

  it('the game move and the solution are legal, and differ', () => {
    for (const { puzzle: p } of SAMPLES) {
      play(p.fen, [p.played])
      play(p.fen, p.solution)
      expect(p.solution[0]).not.toBe(p.played)
    }
  })

  it('the first arrow is the move to find and every arrow starts on a piece', () => {
    for (const { puzzle: p, arrows } of SAMPLES) {
      expect(`${arrows[0].orig}${arrows[0].dest}`).toBe(p.solution[0])
      const pos = at(p.fen)
      for (const a of arrows) expect(pos.board.get(parseSquare(a.orig)!), a.orig).toBeDefined()
    }
  })

  it('what the explanations say happened in the games is on the board', () => {
    const [mate, queen, knight] = SAMPLES.map(s => s.puzzle)
    expect(play(mate.fen, [mate.played, 'b5a7']).isCheckmate()).toBe(true)
    play(queen.fen, [queen.played, 'd2a5'])
    play(knight.fen, [knight.played, 'a6b5', 'a4b5'])
  })

  it('Stockfish picks each solution, at least two and a half pawns clear of the next move', async () => {
    const sf = await require('stockfish')('lite-single')
    const uci: UciEngine = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
    const engine = new Engine(uci)
    for (const { puzzle: p } of SAMPLES) {
      const [best, next] = await engine.searchLines(p.fen, DEPTH, 2)
      expect(best.pv[0]).toBe(p.solution[0])
      // No sample is a mate, so both lines are in centipawns
      expect(best.eval.cp! - next.eval.cp!).toBeGreaterThanOrEqual(MARGIN_CP)
    }
  }, 60_000)
})
