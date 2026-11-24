// Sample gate: three real corpus
// puzzles from the committed gate reports - one mate, one material win, one
// quiet position - narrated live and printed with band, source, word counts
// and cost.
//
//   OPENROUTER_API_KEY=… bun scripts/sample-gate.ts [band]
//
// Reads src/server/fixtures/gate-reports.json (the GATE_REUSE corpus; no
// engine work). Picks the first report of each class, narrates it through
// the production pipeline (draft → validate → decompose → floor), and prints
// the rendered explanation.

import { readFileSync } from 'node:fs'
import { buildPacket, validReport } from '../src/server/packet'
import { narrate } from '../src/server/narrate'
import { openRouter } from '../src/server/openrouter'
import { renderText } from '../src/server/render'
import { words, styleBudget } from '../src/server/readability'

const key = process.env.OPENROUTER_API_KEY
if (!key) throw new Error('OPENROUTER_API_KEY is required')
const band = (process.argv[2] as 'beginner' | 'club' | 'advanced') || 'club'

const reports = JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8')) as object[]

const built = reports.flatMap(raw => {
  const r = validReport(JSON.parse(JSON.stringify({ ...raw, band })))
  if (!r) return []
  const b = buildPacket(r)
  return b.ok ? [{ fen: r.fen, packet: b.packet }] : []
})
const swingOf = (p: (typeof built)[number]['packet']) => Math.abs(p.played?.swing?.type === 'cp' ? p.played.swing.value : 0)
const material = built.find(x => x.packet.best.mateIn === null && swingOf(x.packet) >= 300)
const quiet = built.find(x => x.packet.best.mateIn === null && x.packet.didactic.motif === 'none')
// a model-servable mate has a certified threat; take the first if none does
const mate = built.find(x => x.packet.best.mateIn !== null && x.packet.threatStatus === 'certified') ?? built.find(x => x.packet.best.mateIn !== null)
const picked: { className: string; packet: (typeof built)[number]['packet'] }[] = [
  { className: 'mate', packet: mate!.packet },
  { className: 'material', packet: material!.packet },
  { className: 'quiet', packet: quiet!.packet },
]

let cost = 0
for (const { className, packet: p } of picked) {
  const n = await narrate(p, openRouter(key))
  cost += n.cost
  const text = renderText(n.slots, p)
  const whole = Object.values(text).join(' ')
  const count = words(whole).length
  console.log(`\n=== ${className.toUpperCase()} · ${band} · ${n.source}${n.reason ? ` (${n.reason})` : ''} · ${count} words${styleBudget(whole, band) ? ' - OVER BUDGET' : ` (budget ${band === 'beginner' ? 80 : band === 'club' ? 110 : 150})`} · $${n.cost.toFixed(4)} · ${n.models.join(', ')}`)
  for (const s of n.slots) console.log(`${s.slot}: ${text[s.slot]}`)
}
console.log(`\ntotal cost $${cost.toFixed(4)}`)
