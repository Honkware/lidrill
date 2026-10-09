#!/usr/bin/env node
// Lichess carries no server analysis on most of Player_02's games
// (request-analysis needs a token we don't have), so this synthesizes the
// per-move `analysis` arrays with Stockfish for chosen games of a
// Lichess-export ndjson file, in exactly the shape the native ones have.
// Same method and settings as scripts/build-chesscom-corpus.mjs (1.5M
// nodes/position, white POV); analyzeGame is imported from there.
//
//   node --experimental-strip-types scripts/synthesize-lichess-evals.mjs <in.ndjson> <id …> [-o out.ndjson]
//
// Run with node, not bun, for the same stockfish-wasm reason as the corpus
// builder.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { Engine } from '../src/analysis/engine.ts'
import { pgnMoves } from '../src/sync/pgn.ts'
import { analyzeGame } from './build-chesscom-corpus.mjs'

const require = createRequire(import.meta.url)

const [input, ...rest] = process.argv.slice(2)
const outFlag = rest.indexOf('-o')
const out = outFlag >= 0 ? rest.splice(outFlag, 2)[1] : input
const ids = new Set(rest)
if (!input || !ids.size) {
  console.error('usage: synthesize-lichess-evals.mjs <in.ndjson> <gameId …> [-o out.ndjson]')
  process.exit(1)
}

async function main() {
  const sf = await require('stockfish')('lite-single')
  const uci = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
  const engine = new Engine(uci)

  const lines = readFileSync(input, 'utf8').trim().split('\n')
  const t0 = Date.now()
  const outLines = await Promise.all(lines.map(async l => {
    const g = JSON.parse(l)
    if (!ids.has(g.id)) return l
    if (g.analysis?.length) throw new Error(`${g.id} already has native analysis - use the export verbatim`)
    const moves = pgnMoves(g.pgn)
    if (!moves) throw new Error(`${g.id} PGN does not replay`)
    // AnalyzeGame replays from the start position; verify the PGN matches
    // the `moves` field Lichess already supplies.
    if (moves.length !== g.moves.split(' ').length) throw new Error(`${g.id}: PGN/moves length mismatch`)
    const analysis = await analyzeGame(engine, moves)
    console.error(`${g.id}: ${moves.length} plies, ${analysis.length} evals, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`)
    return JSON.stringify({ ...g, analysis })
  }))
  writeFileSync(out, `${outLines.join('\n')}\n`)
  console.log(`${ids.size} games analyzed -> ${out} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

main()
