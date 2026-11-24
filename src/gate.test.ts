// @vitest-environment node
// The explanation acceptance gate, run by hand:
//
//   GATE=1 [GATE_OUT=out.json] [GATE_COUNT=23] [OPENROUTER_API_KEY=…] bun run test:gate
//
// Builds puzzles from the reference account's games, takes the hardest
// ones, certifies them with Stockfish exactly as the browser does (depth 24,
// 2M nodes, two runs with a cleared hash), builds packets at all three bands
// and runs the narrator against the pinned models. The selection cap
// is applied per band: solutions over the band's ply cap
// (B1 ≤ 2, B2 ≤ 3, Club ≤ 5) are retired from that band's run and counted,
// so the gate measures the post-retirement corpus. Writes every packet,
// draft verdict and rendered explanation to out.json for reading, plus the
// engine reports to src/server/fixtures/gate-reports.json for CI. Without a
// key it stops after the reports (engine-only gate).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { it } from 'vitest'
import { analyzeMoves } from './analysis/analyze'
import { Engine, type CertifyOptions, type UciEngine } from './analysis/engine'
import type { Band, Game, Puzzle } from './db'
import { certifyReport } from './explain'
import { narrate } from './server/narrate'
import { openRouter } from './server/openrouter'
import { buildPacket, packetHash, packetProblems, type EngineReport } from './server/packet'
import { renderText } from './server/render'
import { validateSlots } from './server/slots'
import { templateFloor } from './server/floor'
import { generatePuzzles } from './puzzles/generate'
import { fromLichess } from './sync/lichess'

const require = createRequire(import.meta.url)
const out = process.env.GATE_OUT ?? 'gate-out.json'
const count = Number(process.env.GATE_COUNT ?? 23)

const REPORTS = 'src/server/fixtures/gate-reports.json'

// Stockfish certification of the hardest puzzles in the reference games
async function certifyAll(): Promise<EngineReport[]> {
  const sf = await require('stockfish')('lite-single')
  const uci: UciEngine = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
  const sfEngine = new Engine(uci)
  // Node can't run the threaded build: a node budget stands in for the
  // browser's 15 s budget on one thread (about 7M nodes)
  const nodes = Number(process.env.GATE_NODES ?? 7_000_000)
  const engine = { certify: (fen: string, o: CertifyOptions) => sfEngine.certify(fen, { ...o, movetime: undefined, nodes }), search: sfEngine.search.bind(sfEngine), searchLines: sfEngine.searchLines.bind(sfEngine) } as unknown as Engine

  // player_01's games plus Player_02's (games Lichess already analyzed
  // plus chess.com games with script-synthesized evals - see
  // scripts/build-chesscom-corpus.mjs)
  const games = ['player_01', 'player_02'].flatMap(user =>
    readFileSync(`src/sync/fixtures/${user}.ndjson`, 'utf8')
      .trim()
      .split('\n')
      .map(l => fromLichess(JSON.parse(l), user)!))
    .filter(g => g.serverAnalysis)

  // Lichess's evals are on every move; judgments need no engine
  const noEngine = { search: async () => ({ eval: { cp: 20 }, pv: [], depth: 1, multipv: 1 }) } as unknown as Engine
  const puzzles: (Puzzle & { game: Game })[] = []
  for (const g of games) {
    const moves = await analyzeMoves(g.moves, noEngine, { depth: 1, bookPlies: 8 })
    const game = { ...g, moves, analyzedAt: 1 }
    for (const p of await generatePuzzles(game, engine, { swingThresholdCp: 300, marginCp: 150, depth: 16, maxSolutionMoves: 3 })) puzzles.push({ ...p, game })
    console.error(`${g.id}: ${puzzles.length} puzzles so far`)
  }
  // Hardest first: longest solutions, then the biggest swings (no review history yet)
  const hardest = puzzles.sort((a, b) => b.solutionLen - a.solutionLen || b.swingCp - a.swingCp).slice(0, count)

  const reports: EngineReport[] = []
  const t0 = Date.now()
  for (const [i, p] of hardest.entries()) {
    const t = Date.now()
    const report = await certifyReport(p, [engine], { band: 'beginner', opening: p.game.opening, eco: p.game.eco }, undefined, [])
    reports.push(report)
    console.error(`certified ${i + 1}/${hardest.length} ${p.id} in ${((Date.now() - t) / 1000).toFixed(1)} s`)
  }
  console.error(`certification: ${((Date.now() - t0) / 1000).toFixed(0)} s for ${reports.length} puzzles`)
  mkdirSync('src/server/fixtures', { recursive: true })
  writeFileSync(REPORTS, `${JSON.stringify(reports)}\n`)
  return reports
}

it.runIf(process.env.GATE)('explanation gate', async () => {
  // GATE_REUSE=1 narrates the saved reports again without re-running Stockfish
  const reports: EngineReport[] = process.env.GATE_REUSE && existsSync(REPORTS) ? JSON.parse(readFileSync(REPORTS, 'utf8')) : await certifyAll()

  const key = process.env.OPENROUTER_API_KEY
  const results = []
  let cost = 0
  // Selection cap, applied to the gate candidate set: a
  // solution over the band's ply cap is retired from that band's run - the
  // corpus is counted post-retirement, per band
  const CAP: Record<Band, number> = { beginner: 2, club: 3, advanced: 5 }
  const retired: Record<string, number> = {}
  for (const report of reports)
    for (const band of ['beginner', 'club', 'advanced'] as Band[]) {
      if (report.solution.length > CAP[band]) {
        retired[band] = (retired[band] ?? 0) + 1
        results.push({ fen: report.fen, band, retired: `solution ${report.solution.length} plies over the ${band} cap (${CAP[band]})` })
        continue
      }
      const built = buildPacket({ ...report, band })
      if (!built.ok) {
        results.push({ fen: report.fen, band, error: built.error })
        continue
      }
      const p = built.packet
      p.meta.packetHash = await packetHash({ fen: report.fen, solution: report.solution, band })
      const floor = templateFloor(p)
      const floorCheck = validateSlots({ slots: floor }, p).violations
      const n = key ? await narrate(p, openRouter(key)) : undefined
      cost += n?.cost ?? 0
      results.push({
        fen: report.fen,
        band,
        status: p.meta.certification.status,
        refusals: p.meta.certification.refusals,
        threatStatus: p.threatStatus,
        motif: p.didactic.motif,
        problems: packetProblems(p),
        floorViolations: floorCheck,
        source: n?.source,
        path: n?.path,
        untraced: n?.untraced,
        reason: n?.reason,
        pruned: n?.pruned,
        draftLints: n?.draftLints,
        cuts: n?.cuts,
        calls: n?.calls,
        cost: n?.cost,
        models: n?.models,
        text: renderText(n?.slots ?? floor, p),
        slots: n?.slots ?? floor,
      })
      console.error(`${band} ${report.fen}: ${n?.source ?? 'floor'} ${n?.reason ?? ''}`)
    }
  writeFileSync(out, JSON.stringify({ cost, retired, results }, null, 2))
  console.error(`total narrator cost $${cost.toFixed(4)}`)
}, 6 * 3600_000)
