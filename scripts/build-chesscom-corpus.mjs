#!/usr/bin/env node
// One-time corpus builder: extends the gate fixture with 13 of
// the reference account's chess.com games from the Punish Trainer import.
//
//   node --experimental-strip-types scripts/build-chesscom-corpus.mjs
//
// Run with node, not bun: the stockfish npm build is an emscripten worker
// shim that bun's runtime trips over (`self.location`), and the gate itself
// runs it under node (vitest).
//
// Why this exists: PT's SQLite stores no per-move evals (only derived missed-
// moment rows), and the Lichess account's 25 games are all already in the
// fixture - so the sanctioned Lichess-API fallback cannot add games. These 13
// games' PGNs come from chess.com's public archive API, and the per-move
// `analysis` arrays are synthesized here with Stockfish (lite-single, 1.5M
// nodes/position, white POV) in exactly the shape Lichess's server analysis
// has in src/sync/fixtures/player_01.ndjson. The gate re-certifies every
// candidate position with depth-16+ searches anyway; these evals only drive
// candidate/judgment detection, exactly like Lichess's do for the other 12.
//
// Output: /tmp/chesscom-corpus.ndjson (13 lines, Lichess-export-shaped).
// Review, then append to src/sync/fixtures/player_01.ndjson.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { Engine } from '../src/analysis/engine.ts'
import { pgnHeader, pgnMoves } from '../src/sync/pgn.ts'

const require = createRequire(import.meta.url)

// The 13 selected games (PT's own analysis counts - blunders/opp_mistakes -
// pick the tactically richest), all played 2026-09, all fetched from
// chess.com's public month archive.
const SELECTED = [
  { id: '900000000001', color: 'white', opponent: 'jdkfisjkdjdo', oppRating: 143 },
  { id: '900000000002', color: 'white', opponent: 'yayanuchiha', oppRating: 152 },
  { id: '900000000003', color: 'black', opponent: 'RisingstarC', oppRating: 288 },
  { id: '900000000004', color: 'black', opponent: 'izuchess8', oppRating: 266 },
  { id: '900000000005', color: 'white', opponent: 'crudefill', oppRating: 161 },
  { id: '900000000006', color: 'white', opponent: 'Player_02', oppRating: 546 },
  { id: '900000000007', color: 'black', opponent: 'markw127', oppRating: 451 },
  { id: '900000000008', color: 'black', opponent: 'ARCHSTONE103', oppRating: 100 },
  { id: '900000000009', color: 'black', opponent: 'radiochess123', oppRating: 318 },
  { id: '900000000010', color: 'black', opponent: 'Vishal1687', oppRating: 309 },
  { id: '900000000011', color: 'white', opponent: 'jmwaterton1', oppRating: 272 },
  { id: '900000000012', color: 'white', opponent: 'jenicutie', oppRating: 161 },
  { id: '900000000013', color: 'black', opponent: 'DaveTheOreo', oppRating: 177 },
]

const NODES = 1_500_000
const DEPTH = 22
const archive = JSON.parse(readFileSync('/tmp/cc-2026-09.json', 'utf8'))
const byUrl = new Map(archive.games.map(g => [g.url, g]))

function statusOf(pgn) {
  const t = pgnHeader(pgn, 'Termination') ?? ''
  if (/checkmate/i.test(t)) return 'mate'
  if (/resignation/i.test(t)) return 'resign'
  if (/time/i.test(t)) return 'outoftime'
  return 'draw'
}

// White-POV analysis entries, one per move, the mated final position omitted
// (Lichess's shape). Positions run through `engine` in order.
async function analyzeGame(engine, moves) {
  const pos = Chess.default()
  const entries = []
  for (const [i, m] of moves.entries()) {
    const move = parseUci(m.uci)
    if (!move) throw new Error(`move ${m.uci} does not parse`)
    pos.play(move)
    if (pos.isEnd()) {
      if (!pos.isCheckmate() && i > 0) {
        // A resignation/timeout final position still gets an eval, like Lichess
        const run = await engine.certify(makeFen(pos.toSetup()), { depth: DEPTH, nodes: NODES, multipv: 1, clearHash: false })
        entries.push(whitePov(run.lines[0].eval, pos.turn))
      }
      break
    }
    const run = await engine.certify(makeFen(pos.toSetup()), { depth: DEPTH, nodes: NODES, multipv: 1, clearHash: false })
    entries.push(whitePov(run.lines[0].eval, pos.turn))
  }
  return entries
}

function whitePov(e, sideToMove) {
  const flip = sideToMove === 'black' ? -1 : 1
  return e.type === 'mate' ? { mate: e.value * flip } : { eval: e.value * flip }
}

async function main() {
  // One engine instance: the stockfish npm build is one-shot per process
  // (a second require in the same process loses its wasm binding), and the
  // gate runs it the same way.
  const sf = await require('stockfish')('lite-single')
  const uci = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
  const engine = new Engine(uci)
  const games = SELECTED.map(sel => {
    const g = byUrl.get(`https://www.chess.com/game/live/${sel.id}`) ?? byUrl.get(`https://www.chess.com/game/daily/${sel.id}`)
    if (!g) throw new Error(`game ${sel.id} not in the month archive`)
    const moves = pgnMoves(g.pgn)
    if (!moves) throw new Error(`game ${sel.id} PGN does not replay`)
    return { sel, g, moves }
  })

  const t0 = Date.now()
  const lines = await Promise.all(
    games.map(async ({ sel, g, moves }) => {
      const analysis = await analyzeGame(engine, moves)
      const utcDate = pgnHeader(g.pgn, 'UTCDate')
      const utcTime = pgnHeader(g.pgn, 'UTCTime')
      const createdAt = Date.parse(`${utcDate}T${utcTime}Z`)
      const result = pgnHeader(g.pgn, 'Result')
      const status = statusOf(g.pgn)
      const eco = pgnHeader(g.pgn, 'ECO')
      const ecoUrl = pgnHeader(g.pgn, 'ECOUrl')
      const openingName = ecoUrl ? decodeURIComponent(ecoUrl.split('/').pop()).replaceAll('-', ' ') : ''
      const me = g[sel.color]
      const line = {
        id: sel.id,
        rated: g.rated,
        variant: 'standard',
        speed: g.time_class,
        perf: g.time_class,
        createdAt,
        lastMoveAt: g.end_time * 1000,
        status,
        source: 'import',
        players: {
          [sel.color]: { user: { name: 'player_01', id: 'player_01' }, rating: me.rating },
          [sel.color === 'white' ? 'black' : 'white']: { user: { name: sel.opponent, id: sel.opponent.toLowerCase() }, rating: sel.oppRating },
        },
        winner: result === '1-0' ? 'white' : result === '0-1' ? 'black' : undefined,
        opening: eco ? { eco, name: openingName } : undefined,
        moves: moves.map(m => m.san).join(' '),
        pgn: g.pgn.trim(),
        analysis,
      }
      console.error(`${sel.id}: ${moves.length} plies, ${analysis.length} evals, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`)
      return JSON.stringify(line)
    }),
  )

  writeFileSync('/tmp/chesscom-corpus.ndjson', `${lines.join('\n')}\n`)
  console.log(`13 games -> /tmp/chesscom-corpus.ndjson in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

main()
