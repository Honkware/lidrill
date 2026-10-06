import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Game, type Puzzle } from './db'
import { Replay } from './replay'
import { LINE_REFUSAL } from './server/consistency'
import { buildPacket, type EngineReport, type EngineRun } from './server/packet'

// Wiring: a Turning Points stop's drill carries the consistency hook,
// which collapses a contradicting packet to the game's stored eval line.

const game: Game = {
  id: 'lichess:g1',
  site: 'lichess',
  url: 'u',
  pgn: '',
  color: 'white',
  result: 'win',
  rating: 800,
  speed: 'blitz',
  eco: 'A00',
  opening: 'Test',
  playedAt: 1,
  moves: [
    { san: 'e4', uci: 'e2e4', eval: { cp: 20 } },
    { san: 'e5', uci: 'e7e5', eval: { cp: 15 } },
    { san: 'Nf3', uci: 'g1f3', eval: { cp: 200 } },
  ],
  termination: 'resign',
}

// The position before ply 3: 1. e4 e5
const stop: Puzzle = {
  id: `${game.id}:3`,
  gameId: game.id,
  ply: 3,
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  played: 'g1f3',
  solution: ['d1h5'], // a cheap tactic, the point is the packet wiring
  solutionLen: 1,
  type: 'missed-win',
  tag: 'mate',
  swingCp: 300,
  card: createEmptyCard(),
}

// A certified, stable packet claiming +500 cp (see consistency.test.ts)
const run = (lines: EngineRun['lines']): EngineRun => ({ lines, depth: 24, nodes: 1_000_000, capped: false })
const cp = (value: number) => ({ type: 'cp' as const, value })
const packet = () => {
  const report: EngineReport = {
    schema: 'lidrill-report/1',
    fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
    solution: ['d5c7', 'e8d7', 'c7a8'],
    kind: 'missed-win',
    band: 'club',
    best: [run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(500) }, { pv: ['e1e2'], eval: cp(300) }]), run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(505) }, { pv: ['e1e2'], eval: cp(295) }])],
    threat: [run([{ pv: ['e8e7'], eval: cp(-500) }]), run([{ pv: ['e8e7'], eval: cp(-495) }])],
    played: { uci: 'e1e2', runs: [run([{ pv: ['e8d7'], eval: cp(0) }]), run([{ pv: ['e8d7'], eval: cp(5) }])] },
    habit: { recent: [] },
  }
  const built = buildPacket(report)
  if (!built.ok) throw new Error(built.error)
  return built.packet
}

beforeEach(async () => {
  await db.games.put(game)
  await db.puzzles.put(stop)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => vi.useRealTimers())

describe('Turning Points consistency point', () => {
  it('each stop reconciles its packet against the game’s stored eval line', async () => {
    const replay = new Replay(game, [stop], () => {})
    const el = document.createElement('div')
    document.body.appendChild(el)
    replay.mount(el)
    await vi.advanceTimersByTimeAsync(1000) // arrive at the stop
    expect(replay.state).toBe('stop')
    const consistency = replay.drill!.opts.consistency
    expect(consistency).toBeTypeOf('function')

    // The stored line says +15 cp at ply 3; a packet claiming +500 collapses
    const p = packet()
    expect(p.eval.before.value).toBe(500)
    const collapsed = consistency!(p)
    expect(collapsed.eval.before.value).toBe(15)
    expect(collapsed.meta.certification.refusals).toContain(LINE_REFUSAL)

    // agreement within τ_instab passes through untouched
    const agreeing = packet()
    agreeing.eval.before = { type: 'cp', value: 40, stable: true }
    expect(consistency!(agreeing)).toBe(agreeing)
    replay.destroy()
    el.remove()
  })
})
