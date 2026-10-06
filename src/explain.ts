import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import type { Engine } from './analysis/engine'
import { db, type Puzzle } from './db'
import type { ExplainRequest, LineFacts } from './server/explain'

// Client side of "Why?": what Stockfish says about the puzzle, sent to
// lidrill's /api/explain, which words it. The answer is stored on the puzzle.

const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 }

const material = (pos: Chess, color: 'white' | 'black') => {
  let sum = 0
  for (const [, p] of pos.board) sum += (p.color === color ? 1 : -1) * VALUE[p.role]
  return sum
}

// Plays the line and describes how it ends for the side to move at the start
export function lineFacts(fen: string, ucis: string[]): LineFacts {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap()
  const me = pos.turn
  const start = material(pos, me)
  const san: string[] = []
  for (const uci of ucis.slice(0, 16)) {
    const move = parseUci(uci)
    if (!move || !pos.isLegal(move)) break
    san.push(makeSan(pos, move))
    pos.play(move)
  }
  const d = material(pos, me) - start
  const end = pos.isCheckmate() ? 'mate' : pos.isStalemate() ? 'stalemate' : d ? `material ${d > 0 ? '+' : '−'}${Math.abs(d)}` : 'material even'
  return { san, end }
}

// The engine's line from fen, and its eval for the side NOT to move there
// (the side that just moved), clamped like the rest of lidrill
async function pv(engine: Engine | undefined, fen: string, plies: number): Promise<{ moves: string[]; cp?: number }> {
  if (!engine) return { moves: [] }
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap()
  if (pos.isEnd()) return { moves: [] }
  const r = await engine.search(fen, 14)
  const mover = r.eval.mate !== undefined ? (r.eval.mate > 0 ? 10000 : -10000) : (r.eval.cp ?? 0)
  return { moves: r.pv.slice(0, plies), cp: -Math.max(-10000, Math.min(10000, mover)) }
}

function after(fen: string, ucis: string[]): string {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap()
  for (const u of ucis) pos.play(parseUci(u)!)
  return makeFen(pos.toSetup())
}

export async function explainRequest(p: Puzzle, engine?: Engine): Promise<ExplainRequest> {
  // The solution, carried a few moves further so the payoff is visible
  const firstEval = (await pv(engine, after(p.fen, p.solution.slice(0, 1)), 0)).cp
  const tail = p.solution.length < 6 ? (await pv(engine, after(p.fen, p.solution), 6 - p.solution.length)).moves : []
  const req: ExplainRequest = { fen: p.fen, best: { ...lineFacts(p.fen, [...p.solution, ...tail]), cp: firstEval } }
  if (p.played) {
    const reply = await pv(engine, after(p.fen, [p.played]), 6)
    req.played = { ...lineFacts(p.fen, [p.played, ...reply.moves]), cp: reply.cp }
  }
  if (p.alternatives) req.holding = p.alternatives.map(u => lineFacts(p.fen, [u]).san[0])
  if (p.themes?.length) req.themes = p.themes.filter(t => /^[a-zA-Z]{2,32}$/.test(t)).slice(0, 12)
  return req
}

export async function explain(p: Puzzle, engine?: Engine): Promise<string> {
  if (p.explanation) return p.explanation
  const res = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await explainRequest(p, engine)),
  })
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
  if (!res.ok || !data.text) throw new Error(data.error ?? 'No explanation right now. Try again later.')
  await db.puzzles.update(p.id, { explanation: data.text })
  p.explanation = data.text
  return data.text
}
