// One-off measurement: puzzle-generation yield per game-with-evaluations
// on the gate fixture corpus, bucketed by solution plies. Mirrors certifyAll's
// generation exactly (same analyzeMoves noEngine pass, same generatePuzzles
// options) but stops before certification.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { analyzeMoves } from '../src/analysis/analyze'
import { Engine, type CertifyOptions, type UciEngine } from '../src/analysis/engine'
import type { Puzzle } from '../src/db'
import { generatePuzzles } from '../src/puzzles/generate'
import { fromLichess } from '../src/sync/lichess'

const require = createRequire(import.meta.url)
// The Stockfish WASM loader expects a browser-ish global (vitest provides
// one; plain bun does not)
;(globalThis as Record<string, unknown>).self ??= globalThis
;(globalThis as Record<string, unknown>).location ??= { hash: '' }
const sf = await require('stockfish')('lite-single')
const uci: UciEngine = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
const sfEngine = new Engine(uci)
const nodes = 7_000_000
const engine = { certify: (fen: string, o: CertifyOptions) => sfEngine.certify(fen, { ...o, movetime: undefined, nodes }), search: sfEngine.search.bind(sfEngine), searchLines: sfEngine.searchLines.bind(sfEngine) } as unknown as Engine

const games = readFileSync('src/sync/fixtures/player_01.ndjson', 'utf8')
  .trim().split('\n')
  .map(l => fromLichess(JSON.parse(l), 'player_01')!)
  .filter(g => g.serverAnalysis)
const noEngine = { search: async () => ({ eval: { cp: 20 }, pv: [], depth: 1, multipv: 1 }) } as unknown as Engine

const puzzles: Puzzle[] = []
for (const g of games) {
  const moves = await analyzeMoves(g.moves, noEngine, { depth: 1, bookPlies: 8 })
  const game = { ...g, moves, analyzedAt: 1 }
  for (const p of await generatePuzzles(game, engine, { swingThresholdCp: 300, marginCp: 150, depth: 16, maxSolutionMoves: 3 })) puzzles.push(p)
}
const buckets: Record<string, number> = {}
for (const p of puzzles) buckets[p.solution.length] = (buckets[p.solution.length] ?? 0) + 1
const inCap = (c: number) => puzzles.filter(p => p.solution.length <= c).length
const summary = {
  gamesInFixture: 38,
  gamesWithEvaluations: games.length,
  totalPuzzles: puzzles.length,
  buckets,
  inCapBeginner2: inCap(2),
  inCapClub3: inCap(3),
  inCapAdvanced5: inCap(5),
}
console.log(JSON.stringify(summary, null, 2))
writeFileSync('scripts/puzzle-yield.json', `${JSON.stringify(summary, null, 2)}\n`)
