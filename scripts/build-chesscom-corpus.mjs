#!/usr/bin/env node
// Corpus builder: converts chess.com games into the
// Lichess-export ndjson shape the gate fixture uses, synthesizing the
// per-move `analysis` arrays with Stockfish (lite-single, 1.5M
// nodes/position, white POV). Used for player_01's 13 games (2026-09, PT
// import) and Player_02's games.
//
//   node --experimental-strip-types scripts/build-chesscom-corpus.mjs <player> <archive.json>[,<archive.json>…] [id …] [-o out.ndjson]
//
// Run with node, not bun: the stockfish npm build is an emscripten worker
// shim that bun's runtime trips over (`self.location`), and the gate itself
// runs it under node (vitest).
//
// Why this exists: chess.com's API carries no per-move evals, so they are
// synthesized here in exactly the shape Lichess's server analysis has. The
// gate re-certifies every candidate position with depth-16+ searches anyway;
// these evals only drive candidate/judgment detection, exactly like
// Lichess's do for the other games.
//
// With no ids, every game in the archives where <player> played is converted
// (pass the ids to skip games already in the fixture from the opponent's
// side, e.g. Player_02's 900000000006 which lives in player_01.ndjson).
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { Engine } from '../src/analysis/engine.ts'
import { pgnHeader, pgnMoves } from '../src/sync/pgn.ts'

const require = createRequire(import.meta.url)

const NODES = 1_500_000
const DEPTH = 22

function statusOf(pgn) {
  const t = pgnHeader(pgn, 'Termination') ?? ''
  if (/checkmate/i.test(t)) return 'mate'
  if (/resignation/i.test(t)) return 'resign'
  if (/time/i.test(t)) return 'outoftime'
  return 'draw'
}

// White-POV analysis entries, one per move, the mated final position omitted
// (Lichess's shape). Positions run through `engine` in order.
// Exported for scripts/synthesize-lichess-evals.mjs.
export async function analyzeGame(engine, moves) {
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

// Exported for scripts/synthesize-lichess-evals.mjs.
function whitePov(e, sideToMove) {
  const flip = sideToMove === 'black' ? -1 : 1
  return e.type === 'mate' ? { mate: e.value * flip } : { eval: e.value * flip }
}

async function main() {
  const [player, ...rest] = process.argv.slice(2)
  const outFlag = rest.indexOf('-o')
  const out = outFlag >= 0 ? rest.splice(outFlag, 2)[1] : '/tmp/chesscom-corpus.ndjson'
  const archives = rest.shift()?.split(',') ?? []
  const ids = rest
  if (!player || !archives.length) {
    console.error('usage: build-chesscom-corpus.mjs <player> <archive.json>[,…] [gameId …] [-o out.ndjson]')
    process.exit(1)
  }
  const games = []
  for (const path of archives) {
    const archive = JSON.parse(readFileSync(path, 'utf8'))
    games.push(...archive.games)
  }
  const byId = new Map(games.map(g => [g.url.match(/(\d+)$/)?.[1] ?? g.url, g]))

  // One engine instance: the stockfish npm build is one-shot per process
  // (a second require in the same process loses its wasm binding), and the
  // gate runs it the same way.
  const sf = await require('stockfish')('lite-single')
  const uci = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
  const engine = new Engine(uci)
  const wanted = ids.length ? ids : byId.keys()
  const selected = [...wanted].map(id => {
    const g = byId.get(id)
    if (!g) throw new Error(`game ${id} not in the month archive(s)`)
    const moves = pgnMoves(g.pgn)
    if (!moves) throw new Error(`game ${id} PGN does not replay`)
    const color = g.white.username.toLowerCase() === player.toLowerCase() ? 'white' : 'black'
    if (g[color].username.toLowerCase() !== player.toLowerCase()) throw new Error(`game ${id} is not ${player}'s`)
    const them = g[color === 'white' ? 'black' : 'white']
    return { id, color, opponent: them.username, oppRating: them.rating, g, moves }
  })

  const t0 = Date.now()
  const lines = await Promise.all(
    selected.map(async sel => {
      const { g } = sel
      const analysis = await analyzeGame(engine, sel.moves)
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
          [sel.color]: { user: { name: player, id: player.toLowerCase() }, rating: me.rating },
          [sel.color === 'white' ? 'black' : 'white']: { user: { name: sel.opponent, id: sel.opponent.toLowerCase() }, rating: sel.oppRating },
        },
        winner: result === '1-0' ? 'white' : result === '0-1' ? 'black' : undefined,
        opening: eco ? { eco, name: openingName } : undefined,
        moves: sel.moves.map(m => m.san).join(' '),
        pgn: g.pgn.trim(),
        analysis,
      }
      console.error(`${sel.id}: ${sel.moves.length} plies, ${analysis.length} evals, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`)
      return JSON.stringify(line)
    }),
  )

  writeFileSync(out, `${lines.join('\n')}\n`)
  console.log(`${selected.length} games -> ${out} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// Importing this module for analyzeGame must not run main (the stockfish npm
// build is one-shot per process; helper users bring their own engine).
if (process.argv[1] === fileURLToPath(import.meta.url)) main()

export { whitePov }
