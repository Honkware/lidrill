import type { DrawShape } from '@lichess-org/chessground/draw'
import { createEmptyCard } from 'ts-fsrs'
import type { Puzzle } from './db'

// Three puzzles for a first visit, before any game is imported. Each is a
// blunder from a game in the test fixtures (src/sync/fixtures), found by the
// app's own generator: `played` is the move in the game and `solution` the
// one Stockfish puts at least two and a half pawns above every other, which
// samples.test.ts checks. The arrows and the explanation are written by
// hand, so a sample needs no engine, account or network. Samples are played
// ungraded and never reach the puzzles table.

export interface Sample {
  puzzle: Puzzle
  arrows: DrawShape[] // on the puzzle position, with "Why?": the move to find in green, a threat in yellow, the game's move in red
  why: string
}

const sample = (n: number, p: Pick<Puzzle, 'ply' | 'before' | 'lastMove' | 'fen' | 'played' | 'solution' | 'tag' | 'swingCp'>, arrows: DrawShape[], why: string): Sample => ({
  puzzle: { ...p, id: `sample:${n}`, gameId: '', source: 'own', solutionLen: 1, type: 'hang', card: createEmptyCard(new Date(0)) },
  arrows,
  why,
})

export const SAMPLES: Sample[] = [
  sample(
    1,
    {
      ply: 28,
      before: '2kr1bnr/1bpqp2p/Np3pp1/3p4/3P1P2/2N1P3/PPP1Q1PP/R1B2RK1 w - - 1 14',
      lastMove: 'c3b5',
      fen: '2kr1bnr/1bpqp2p/Np3pp1/1N1p4/3P1P2/4P3/PPP1Q1PP/R1B2RK1 b - - 2 14',
      played: 'c7c6',
      solution: ['b7a6'],
      tag: 'hang',
      swingCp: 1347,
    },
    [
      { orig: 'b7', dest: 'a6', brush: 'green' },
      { orig: 'b5', dest: 'a7', brush: 'yellow' },
      { orig: 'c7', dest: 'c6', brush: 'red' },
    ],
    'White threatens Na7 mate, because the knight on a6 covers b8. Bxa6 takes that knight for nothing and ends the threat. In the game c6 allowed the mate.',
  ),
  sample(
    2,
    {
      ply: 26,
      before: 'r4rk1/pp4pp/1np2p1n/q1bpp2b/7P/P1NPP3/1PPQ1P1N/R1B1KBR1 w Q - 2 13',
      lastMove: 'c3e2',
      fen: 'r4rk1/pp4pp/1np2p1n/q1bpp2b/7P/P2PP3/1PPQNP1N/R1B1KBR1 b Q - 3 13',
      played: 'a8e8',
      solution: ['a5d2'],
      tag: 'hang',
      swingCp: 1006,
    },
    [
      { orig: 'a5', dest: 'd2', brush: 'green' },
      { orig: 'a8', dest: 'e8', brush: 'red' },
    ],
    "White's knight left c3, so the queen on d2 now attacks the queen on a5, which nothing defends. Qxd2+ trades them. In the game Rae8 left the queen to be taken.",
  ),
  sample(
    3,
    {
      ply: 21,
      before: 'r2q1rk1/1ppbbpp1/p1np1n1p/4p3/BP2P3/P1NP1N2/2P2PPP/R1BQR1K1 b - - 2 10',
      lastMove: 'b7b5',
      fen: 'r2q1rk1/2pbbpp1/p1np1n1p/1p2p3/BP2P3/P1NP1N2/2P2PPP/R1BQR1K1 w - - 0 11',
      played: 'c3b5',
      solution: ['a4b3'],
      tag: 'defensive',
      swingCp: 532,
    },
    [
      { orig: 'a4', dest: 'b3', brush: 'green' },
      { orig: 'b5', dest: 'a4', brush: 'yellow' },
      { orig: 'c3', dest: 'b5', brush: 'red' },
    ],
    'The pawn on b5 attacks the bishop, and b3 is its only safe square. In the game Nxb5 gave up a knight for two pawns.',
  ),
]
