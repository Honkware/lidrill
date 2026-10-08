// Flake loop: replay the haiku decompose pass over gate packets
// until the 2/3-run flake surfaces, with per-call telemetry.
//
//   OPENROUTER_API_KEY=sk-… bun scripts/decompose-flake-loop.mjs [calls]
//
// Sends the byte-identical prompt narrate() sends (decomposeAskFor), through
// the instrumented openRouter caller, and buckets every outcome. Read-only
// with respect to the codebase: no fix is chosen until the taxonomy prints.

const calls = Number(process.argv[2] ?? 20)
const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error('OPENROUTER_API_KEY is not set')
  process.exit(1)
}

const { readFileSync } = await import('node:fs')
const { buildPacket, validReport } = await import('../src/server/packet.ts')
const { templateFloor } = await import('../src/server/floor.ts')
const { promptView, MODELS, SYSTEM_V2, CLAIM_SCHEMA, decomposeAskFor } = await import('../src/server/narrate.ts')
const { openRouter } = await import('../src/server/openrouter.ts')

const reports = JSON.parse(readFileSync(new URL('../src/server/fixtures/gate-reports.json', import.meta.url), 'utf8'))
// A spread of packet shapes: certified fork-ish positions the decompose pass
// actually sees in gate runs
const packets = []
for (const raw of reports) {
  const r = validReport(JSON.parse(JSON.stringify({ ...raw, band: 'club' })))
  if (!r) continue
  const b = buildPacket(r)
  if (b.ok && b.packet.meta.certification.status === 'certified' && packets.length < 4) packets.push(b.packet)
}
if (!packets.length) throw new Error('no certified gate packets')

const telemetry = []
const call = openRouter(key, 45_000, t => telemetry.push(t))
let total = 0
const t0 = Date.now()
for (let i = 0; i < calls; i++) {
  const p = packets[i % packets.length]
  const slots = templateFloor(p) // a real ref-form explanation to split
  const user = decomposeAskFor(JSON.stringify(promptView(p)), slots)
  const r = await call({ pass: 'decompose', model: MODELS.lint.model, temperature: MODELS.lint.temperature, maxTokens: MODELS.lint.maxTokens, system: SYSTEM_V2, user, schema: CLAIM_SCHEMA })
  total += r.cost ?? 0
}
const wall = Date.now() - t0

const buckets = {}
for (const t of telemetry) {
  const bucket = t.outcome
  buckets[bucket] = buckets[bucket] ?? { n: 0, latencies: [], finish: {} }
  buckets[bucket].n++
  buckets[bucket].latencies.push(t.latencyMs)
  if (t.finish) buckets[bucket].finish[t.finish] = (buckets[bucket].finish[t.finish] ?? 0) + 1
}
console.log(`\n=== ${calls} decompose calls, wall ${(wall / 1000).toFixed(1)}s, cost $${total.toFixed(4)} ===`)
for (const [outcome, b] of Object.entries(buckets)) {
  const avg = (b.latencies.reduce((a, x) => a + x, 0) / b.n).toFixed(0)
  const max = Math.max(...b.latencies)
  console.log(`${outcome}: ${b.n} · latency avg ${avg}ms max ${max}ms · finish ${JSON.stringify(b.finish)}`)
}
const failures = telemetry.filter(t => t.outcome !== 'ok')
if (failures.length) console.log('\nfailures:', JSON.stringify(failures, null, 1))
