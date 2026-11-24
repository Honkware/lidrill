import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import { createEmptyCard } from 'ts-fsrs'
import type { Band, Eval, Game, Puzzle, PuzzleTag, PuzzleType } from '../db'
import type { Engine, SearchResult } from '../analysis/engine'
import { fromFen, looseList } from '../server/facts'
import { featureBlock } from '../server/features'
import { motifs } from '../server/motifs'
import { uciLine } from '../server/packet'
import { MAIA_MIN_P, type Findable } from './findable'

export interface GenerateOptions {
  swingThresholdCp: number
  marginCp: number
  depth: number // verification depth, 18-22
  maxSolutionMoves: number
  // The player's band: solutions longer than its ply cap never become
  // puzzles - the position still surfaces in Replay,
  // which stops at the same critical moments
  band?: Band
  // Maia's probability for the answer. Left out, or answering undefined
  // when Maia can't be reached, puzzles are made as before without it.
  findable?: Findable
}

// A puzzle the player can't be shown within a few moves is not a
// puzzle at that band - deep lines route to Replay instead
export const SOLUTION_PLIES_CAP: Record<Band, number> = { beginner: 2, club: 3, advanced: 5 }

// Bumped when the generator finds puzzles it didn't before (2: hold puzzles;
// 3: band ply cap,); older games are then looked at again
export const GENERATOR_VERSION = 3

const MATE_CP = 1000

// Eval as centipawns for the given side, mates squashed to ±1000
export function povCp(e: Eval, color: 'white' | 'black'): number {
  const cp = e.mate !== undefined ? (e.mate > 0 ? MATE_CP : -MATE_CP) : Math.max(-MATE_CP, Math.min(MATE_CP, e.cp ?? 0))
  return color === 'white' ? cp : -cp
}

export interface Candidate {
  ply: number
  fen: string
  played: string
  swingCp: number
  before: number // player's eval before the move
}

// Player moves that dropped at least the threshold, minus the
// quality gates that need no engine: the first ten plies, and positions that
// were already decided either way.
export function findCandidates(game: Game, swingThresholdCp: number): Candidate[] {
  const pos = Chess.default()
  const out: Candidate[] = []
  let prev: Eval | undefined
  game.moves.forEach((m, i) => {
    const ply = i + 1
    const mover = ply % 2 === 1 ? 'white' : 'black'
    const fen = makeFen(pos.toSetup())
    if (mover === game.color && ply > 10 && prev && m.eval && !m.book) {
      const before = povCp(prev, mover)
      const swing = before - povCp(m.eval, mover)
      const decided = Math.abs(before) >= 900 && prev.mate === undefined
      if (swing >= swingThresholdCp && !decided) out.push({ ply, fen, played: m.uci, swingCp: swing, before })
    }
    prev = m.eval ?? prev
    pos.play(parseUci(m.uci)!)
  })
  return out
}

function sanOf(fen: string, uci: string): string {
  const move = parseUci(uci)
  return move ? makeSan(Chess.fromSetup(parseFen(fen).unwrap()).unwrap(), move) : uci
}

const isMate = (r: SearchResult) => r.eval.mate !== undefined && r.eval.mate > 0

// Best move is unique: the gap to the second line clears the band margin, or
// only the best line mates.
export function isUnique(lines: SearchResult[], marginCp: number): boolean {
  const [best, second] = lines
  if (!best) return false
  if (!second) return true // only one legal move: unique but trivial, caller decides
  if (isMate(best) && !isMate(second)) return true
  const toCp = (r: SearchResult) => povCp(r.eval, 'white') // side-to-move view already
  return toCp(best) - toCp(second) >= marginCp
}

// A second line this far ahead also wins: 500 is where verdictOf
// (src/server/packet.ts) starts to call a position winning. The best move is
// then one of several that convert, and a player who picks another is right.
export const ALSO_WINS_CP = 500

// A mate the solution can play out in full is still its own answer, since
// ending the game is not the same as staying ahead. A longer one is only a
// number to the player, so it is compared like any other eval.
export function secondAlsoWins(lines: SearchResult[], maxSolutionMoves: number): boolean {
  const [best, second] = lines
  if (!best || !second) return false
  if (isMate(best) && best.eval.mate! <= maxSolutionMoves) return false
  return povCp(second.eval, 'white') >= ALSO_WINS_CP
}

// A quiet best move with nothing to show for it has to beat the second line
// by a minor piece (300). A smaller edge that only depth finds is not
// something the player can check on the board.
export const QUIET_GAP_CP = 300

// What a player can see in the best move: it takes, checks or promotes, its
// line holds a named pattern (motifs.ts), it attacks something that was not
// loose before or saves something that was, or it changes a feature the
// explanation can name (features.ts)
export function hasPoint(fen: string, pv: string[]): boolean {
  const line = uciLine(fen, pv)?.replay
  const before = fromFen(fen)
  if (!line || !before) return false
  const m = line.moves[0]
  if (m.captured || m.check || m.mate || m.promotion) return true
  if (motifs(line).length) return true
  const after = line.positions[0]
  const them = m.color === 'white' ? 'black' : 'white'
  const squares = (pos: typeof before, color: typeof them) => looseList(pos, color).map(l => l.square)
  const wasLoose = squares(before, them)
  if (squares(after, them).some(sq => !wasLoose.includes(sq))) return true
  const stillLoose = squares(after, m.color)
  if (squares(before, m.color).some(sq => !stillLoose.includes(sq))) return true
  return !!featureBlock(fen, m.fenAfter, 'best')?.deltas.length
}

const gapCp = (lines: SearchResult[]) => povCp(lines[0].eval, 'white') - povCp(lines[1].eval, 'white')

function classify(c: Candidate, prevJudged: boolean, best: SearchResult): { type: PuzzleType; tag: PuzzleTag } {
  const tag: PuzzleTag = isMate(best) ? 'mate' : c.before < 0 ? 'defensive' : 'hang'
  if (prevJudged && c.before >= 200) return { type: 'missed-win', tag }
  if (c.before >= 500) return { type: 'conversion', tag }
  return { type: 'hang', tag }
}

export async function generatePuzzles(game: Game, engine: Engine, opts: GenerateOptions): Promise<Puzzle[]> {
  const puzzles: Puzzle[] = []
  for (const c of findCandidates(game, opts.swingThresholdCp)) {
    const lines = await engine.searchLines(c.fen, opts.depth, 2)
    if (lines.length < 2) continue
    if (!isUnique(lines, opts.marginCp)) {
      const hold = await holdPuzzle(game, c, engine, opts)
      if (hold) puzzles.push(hold)
      continue
    }
    if (secondAlsoWins(lines, opts.maxSolutionMoves)) continue
    const best = lines[0]
    if (gapCp(lines) < QUIET_GAP_CP && !hasPoint(c.fen, best.pv)) continue
    // Engine now likes the played move: not a mistake at depth. Compared as
    // SAN because castling is e1h1 in chessops and e1g1 from Stockfish.
    if (sanOf(c.fen, best.pv[0]) === sanOf(c.fen, c.played)) continue

    // Recapture-only puzzles teach nothing
    const prevMove = game.moves[c.ply - 2]
    if (prevMove && best.pv[0].slice(2, 4) === prevMove.uci.slice(2, 4) && prevMove.san.includes('x')) continue

    const maiaP = await opts.findable?.(game, c.ply, [best.pv[0]])
    if (maiaP !== undefined && maiaP < MAIA_MIN_P) continue

    const solution = await extendSolution(c.fen, best, engine, opts)
    // Over the band cap, this is replay material, not a puzzle
    if (opts.band && solution.length > SOLUTION_PLIES_CAP[opts.band]) continue
    const prevJudged = !!game.moves[c.ply - 2]?.judg
    const { type, tag } = classify(c, prevJudged, best)
    puzzles.push({
      id: `${game.id}:${c.ply}`,
      gameId: game.id,
      ply: c.ply,
      fen: c.fen,
      played: c.played,
      solution,
      solutionLen: Math.ceil(solution.length / 2),
      type,
      tag,
      swingCp: c.swingCp,
      ...(maiaP !== undefined ? { maiaP } : {}),
      card: createEmptyCard(),
    })
  }
  return puzzles
}

// A hang often has two or three moves that save it, so it can't be a
// one-answer puzzle, yet it's exactly what a beginner needs to practise.
// Such a position becomes a "hold" puzzle when 2 or 3 moves stay within the
// band margin of the best one and the played move isn't among them; any of
// them solves it. More than 3 means almost anything works: not a puzzle.
export const MAX_HOLDING_MOVES = 3

async function holdPuzzle(game: Game, c: Candidate, engine: Engine, opts: GenerateOptions): Promise<Puzzle | undefined> {
  const lines = await engine.searchLines(c.fen, opts.depth, MAX_HOLDING_MOVES + 1)
  const best = lines[0]
  if (!best?.pv[0] || isMate(best)) return undefined
  const toCp = (r: SearchResult) => povCp(r.eval, 'white')
  const holding = lines.filter(l => l.pv[0] && toCp(best) - toCp(l) < opts.marginCp).map(l => l.pv[0])
  if (holding.length < 2 || holding.length > MAX_HOLDING_MOVES) return undefined
  const played = sanOf(c.fen, c.played)
  if (holding.some(uci => sanOf(c.fen, uci) === played)) return undefined
  const maiaP = await opts.findable?.(game, c.ply, holding)
  if (maiaP !== undefined && maiaP < MAIA_MIN_P) return undefined
  return {
    id: `${game.id}:${c.ply}`,
    gameId: game.id,
    ply: c.ply,
    fen: c.fen,
    played: c.played,
    solution: [best.pv[0]],
    alternatives: holding,
    solutionLen: 1,
    type: 'hang',
    tag: c.before < 0 ? 'defensive' : 'hang',
    swingCp: c.swingCp,
    ...(maiaP !== undefined ? { maiaP } : {}),
    card: createEmptyCard(),
  }
}

// Follow the forced line: keep adding player moves while each one is still
// unique, up to maxSolutionMoves, or until mate.
async function extendSolution(fen: string, best: SearchResult, engine: Engine, opts: GenerateOptions): Promise<string[]> {
  const solution = [best.pv[0]]
  if (best.eval.mate === 1) return solution
  const setup = parseFen(fen)
  if (setup.isErr) return solution
  const pos = Chess.fromSetup(setup.value).unwrap()
  pos.play(parseUci(best.pv[0])!)
  let line = best
  while (Math.ceil(solution.length / 2) < opts.maxSolutionMoves) {
    const reply = line.pv[solution.length]
    if (!reply || pos.isEnd()) break
    pos.play(parseUci(reply)!)
    const next = await engine.searchLines(makeFen(pos.toSetup()), opts.depth, 2)
    if (!next.length) break
    const unique = next.length === 1 || (isUnique(next, opts.marginCp) && !secondAlsoWins(next, opts.maxSolutionMoves))
    if (!unique) break
    solution.push(reply, next[0].pv[0])
    pos.play(parseUci(next[0].pv[0])!)
    if (pos.isCheckmate()) break
    line = { ...next[0], pv: [...solution, ...next[0].pv.slice(1)] }
  }
  return solution
}
