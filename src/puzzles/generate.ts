import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { createEmptyCard } from 'ts-fsrs'
import type { Eval, Game, Puzzle, PuzzleTag, PuzzleType } from '../db'
import type { Engine, SearchResult } from '../analysis/engine'

export interface GenerateOptions {
  swingThresholdCp: number
  marginCp: number
  depth: number // verification depth, 18-22
  maxSolutionMoves: number
}

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
    if (lines.length < 2 || !isUnique(lines, opts.marginCp)) continue
    const best = lines[0]
    if (best.pv[0] === c.played) continue // engine now likes the played move: not a mistake at depth

    // Recapture-only puzzles teach nothing
    const prevMove = game.moves[c.ply - 2]
    if (prevMove && best.pv[0].slice(2, 4) === prevMove.uci.slice(2, 4) && prevMove.san.includes('x')) continue

    const solution = await extendSolution(c.fen, best, engine, opts)
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
      card: createEmptyCard(),
    })
  }
  return puzzles
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
    const unique = next.length === 1 || isUnique(next, opts.marginCp)
    if (!unique) break
    solution.push(reply, next[0].pv[0])
    pos.play(parseUci(next[0].pv[0])!)
    if (pos.isCheckmate()) break
    line = { ...next[0], pv: [...solution, ...next[0].pv.slice(1)] }
  }
  return solution
}
