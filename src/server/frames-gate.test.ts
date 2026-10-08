// @vitest-environment node
// Gate re-run (gate-report contract, solve
// frames), run by hand:
//
//   GATE7=1 OPENROUTER_API_KEY=… bunx vitest run src/server/frames-gate.test.ts
//
// Part A - the committed corpus mate position (sample-1 class, club) solved
// three ways. Corpus truth: both corpus mates floor by design at every band
// (position 3's threat never certifies; position 5's certification is
// refused), and every corpus acceptance set is a singleton - selection
// margins (≥ 80 cp) are far wider than τ_accept (30 cp), and neither mate
// admits a second certified mating move (verified to depth 26, MultiPV 8).
// So the corpus part demonstrates the per-frame FLOORS, with the also-good
// membership injected (the engine's own #2 line) and labeled as such.
//
// Part B - a mate-in-1 with two certified mating moves (back rank, two
// rooks), certified live in this run at the server tier (two depth-24 runs,
// MultiPV 4, hash cleared), where the acceptance set genuinely has two
// members - best / also-good / miss all reach the model for real.
//
// Every frame prints full verbatim slot text (no ellipses), per-slot word
// counts, the lints that fired, source (model or floor) and cost. The round
// also re-confirms open items (floors, corpus over-cap
// count in plies, mechanism-matched habits).
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { Engine, type UciEngine } from '../analysis/engine'
import { narrate, type Narration } from './narrate'
import { openRouter } from './openrouter'
import { buildPacket, validReport, type EngineReport, type EngineRun, type Packet } from './packet'
import { renderText, SLOTS, type Slot } from './render'
import { words } from './readability'
import { templateFloor } from './floor'
import { validateSlots, type FrameContext } from './slots'

const BAND = 'club'
const require = createRequire(import.meta.url)
const reports = JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8')) as unknown[]

const packetOf = (raw: unknown): Packet | undefined => {
  const r = validReport(JSON.parse(JSON.stringify({ ...(raw as object), band: BAND })))
  if (!r) return undefined
  const b = buildPacket(r)
  return b.ok ? b.packet : undefined
}
const built = reports.flatMap(raw => {
  const p = packetOf(raw)
  return p ? [p] : []
})

const show = (label: string, p: Packet, slots: Slot[], n: Narration, frame: FrameContext) => {
  const text = renderText(slots, p)
  const lints = validateSlots({ slots }, p, frame).violations
  console.log(`\n=== ${label} ===`)
  console.log(`band: ${BAND} · frame: ${n.frame} · source: ${n.source}${n.reason ? ` (${n.reason})` : ''} · models: [${n.models.join(', ')}] · calls: ${n.calls} · cost: $${n.cost.toFixed(5)}`)
  if (lints.length) console.log(`lints fired: ${lints.join(' | ')}`)
  // Diagnostic: the lints the
  // accepted draft carried, and every claim the prune cut with the check
  // that fired - a floored packet names its firing check, with the claim
  if (n.draftLints !== undefined) console.log(`draft lints: ${n.draftLints.length ? n.draftLints.join(' | ') : '(none - draft validated clean)'}`)
  if (n.draft) for (const s of n.draft) console.log(`draft ${s.slot}: ${s.text}`)
  if (n.cuts?.length) console.log(`claims cut:\n${n.cuts.map(c => `  [${c.check}] "${c.claim}"`).join('\n')}`)
  for (const name of SLOTS) {
    const t = text[name]
    if (t === undefined) continue
    console.log(`${name} (${words(t).length} words): ${t}`)
  }
  return { label, frame: n.frame, source: n.source, reason: n.reason, cost: n.cost, models: n.models, calls: n.calls, lints, draftLints: n.draftLints, cuts: n.cuts, text, words: Object.fromEntries(SLOTS.map(s => [s, words(text[s] ?? '')])) }
}

it.runIf(process.env.GATE7)('gate: one corpus mate position, three frames', async () => {
  const key = process.env.OPENROUTER_API_KEY!
  if (!key) throw new Error('OPENROUTER_API_KEY is required for gate')
  const call = openRouter(key)
  const results: unknown[] = []
  let total = 0

  // --- Part A: the corpus mate position -----------------------------------
  const mate = built.find(x => x.best.mateIn !== null)!
  console.log(`PART A - corpus position: ${mate.position.fenBefore}`)
  console.log(`best: ${mate.best.san} (${mate.best.uci}, mate in ${mate.best.mateIn}) · acceptanceSet: [${mate.acceptanceSet.join(', ')}] · threat: ${mate.threatStatus} · certification: ${mate.meta.certification.status}`)
  const corpusRuns: { label: string; move?: string; membership: 'best' | 'set' | 'miss' }[] = [
    { label: 'best', move: mate.best.uci, membership: 'best' },
    { label: 'also-good (membership injected - this corpus has no certified set move)', move: mate.alternatives[0]?.uci, membership: 'set' },
    { label: 'miss', move: mate.alternatives.at(-1)?.uci, membership: 'miss' },
  ]
  for (const run of corpusRuns) {
    const frame: FrameContext = { membership: run.membership, solvingRef: run.move && run.move !== mate.best.uci ? (mate.alternatives.find(a => a.uci === run.move)?.id ?? undefined) : 'best' }
    const n = await narrate(mate, call, { move: run.move, membership: run.membership })
    total += n.cost
    results.push(show(`${run.label} - solving move ${run.move ?? 'none'}`, mate, n.slots, n, frame))
  }

  // --- Part B: a live-certified hold puzzle with two mating holds ---------
  // A hold puzzle is where the also-good frame genuinely fires in production:
  // selection margins refuse non-unique missed-wins, while holds are
  // certified with every holding move in the acceptance set.
  console.log('\nPART B - live certification: back-rank mate-in-1, two mating holds')
  const sf = await require('stockfish')('lite-single')
  const uci: UciEngine = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
  const engine = new Engine(uci)
  const fen = '6k1/5ppp/8/8/8/8/8/R2Q2K1 w - - 0 1' // Ra8# and Qd8# - two certified mating holds
  const toRaw = (rs: { eval: { cp?: number; mate?: number }; pv: string[] }[]): EngineRun['lines'] => rs.map(r => ({ pv: r.pv.slice(0, 16), eval: r.eval.mate !== undefined ? { type: 'mate' as const, value: r.eval.mate } : { type: 'cp' as const, value: r.eval.cp ?? 0 } }))
  const run1 = await engine.searchLines(fen, 24, 4)
  sf.sendCommand('setoption name Clear Hash')
  const run2 = await engine.searchLines(fen, 24, 4)
  const mates = [...new Set([...run1, ...run2].filter(r => r.eval.mate !== undefined && r.eval.mate > 0).map(r => r.pv[0]))].slice(0, 2)
  if (mates.length < 2) throw new Error(`expected two mating moves, got [${mates.join(', ')}]`)
  const report: EngineReport = {
    schema: 'lidrill-report/1',
    fen,
    solution: [mates[0]!],
    holding: mates,
    kind: 'hold',
    band: BAND,
    best: [
      { lines: toRaw(run1), depth: 24, nodes: 1_000_000, capped: false },
      { lines: toRaw(run2), depth: 24, nodes: 1_000_000, capped: false },
    ],
    habit: { recent: [] },
  }
  const built2 = buildPacket(report)
  if (!built2.ok) throw new Error(built2.error)
  const p2 = built2.packet
  console.log(`position: ${fen}`)
  console.log(`best: ${p2.best.san} (${p2.best.uci}, mate in ${p2.best.mateIn}) · holding: [${p2.holding.map(h => h.san).join(', ')}] · acceptanceSet: [${p2.acceptanceSet.join(', ')}] · certification: ${p2.meta.certification.status}`)
  if (p2.acceptanceSet.length < 2) throw new Error('the live certification did not produce a two-member acceptance set')
  const setMove = p2.acceptanceSet[1]!
  const wrong = p2.alternatives.find(a => !p2.acceptanceSet.includes(a.uci))?.uci ?? 'a1b1'
  const liveRuns: { label: string; move?: string; membership: 'best' | 'set' | 'miss' }[] = [
    { label: 'best', move: p2.best.uci, membership: 'best' },
    { label: 'also-good', move: setMove, membership: 'set' },
    { label: 'miss', move: wrong, membership: 'miss' },
  ]
  for (const run of liveRuns) {
    const frame: FrameContext = { membership: run.membership, solvingRef: run.move && run.move !== p2.best.uci ? (p2.alternatives.find(a => a.uci === run.move)?.id ?? undefined) : 'best' }
    const n = await narrate(p2, call, { move: run.move, membership: run.membership })
    total += n.cost
    results.push(show(`${run.label} - solving move ${run.move ?? 'none'}`, p2, n.slots, n, frame))
  }

  // --- open items, re-confirmed in this round ---------------------
  console.log('\n=== open items ===')
  // (a) mate floor bounded form + no mismatched gloss, over every corpus packet
  let bounded = true
  let glossOk = true
  for (const q of built) {
    const floor = renderText(templateFloor(q), q)
    if (q.certificates.some(c => c.id === 'c-mate' && c.subject === 'best') && !/mate in at most \d+/.test(floor.why + floor.pattern)) bounded = false
    if (floor.pattern.includes('Meeting the threat') !== (q.didactic.glossId === 'gloss:meeting-the-threat')) glossOk = false
  }
  console.log(`mate floor bounded form (all ${built.length} corpus packets): ${bounded ? 'CONFIRMED' : 'BROKEN'}`)
  console.log(`no mismatched meeting-the-threat gloss: ${glossOk ? 'CONFIRMED' : 'BROKEN'}`)
  // (b) over-cap corpus count, in plies (B1 ≤ 2, B2 ≤ 3, Club ≤ 5)
  const caps: [string, number][] = [['beginner', 2], ['club', 3], ['advanced', 5]]
  for (const [band, cap] of caps) {
    const over = reports.filter(r => (r as { solution: string[] }).solution.length > cap).length
    console.log(`over ${band} cap (${cap} plies): ${over} of ${reports.length}`)
  }
  // (c) mechanism habit for threat-meeting: threat-certified packets carry a
  // mechanism habit in the floor nextTime, or omit the slot
  const threatPackets = built.filter(q => q.threatStatus === 'certified')
  const habitOk = threatPackets.every(q => {
    const next = templateFloor(q).find(s => s.slot === 'nextTime')
    return !next || next.refs.some(r => r.startsWith('habit:'))
  })
  console.log(`threat-meeting floors carry a mechanism habit or omit nextTime (${threatPackets.length} threat-certified packets): ${habitOk ? 'CONFIRMED' : 'BROKEN'}`)
  console.log(`\ntotal narrator cost: $${total.toFixed(5)}`)
  writeFileSync('gate7-out.json', JSON.stringify({ band: BAND, totalCost: total, results }, null, 2))
}, 30 * 60_000)
