// The explanation gate without a model: the checks on the saved engine reports
// (src/server/fixtures/gate-reports.json, written by `bun run test:gate`).
// No model is called. For each report at each band it records whether the
// packet would reach the narrator or fall back to the floor, whether the
// floor passes the validator, and which of a fixed set of claim errors the
// validator catches when each is written into the floor's "why" slot.
//
//   bun run gate:offline [--json out.json]
//
// The injected errors are edits to real floor text on real positions, not
// model output, so the catch rates say what the rules can see, not how often
// a model makes each mistake.
import { readFileSync, writeFileSync } from 'node:fs'
import type { Band } from '../src/db'
import { templateFloor } from '../src/server/floor'
import { buildPacket, packetProblems, validReport, type EngineReport, type Packet } from '../src/server/packet'
import { renderRef, type Slot } from '../src/server/render'
import { validateSlots } from '../src/server/slots'

const REPORTS = 'src/server/fixtures/gate-reports.json'
const BANDS: Band[] = ['beginner', 'club', 'advanced']

// Which rule a violation string comes from (prefixes and wording in slots.ts)
const CLASSES: [string, RegExp][] = [
  ['notation', /written out/],
  ['unknown ref', /not a fact id|used but not listed|listed but not used|can't be rendered/],
  ['mate', /no mate is certified/],
  ['pattern name', /^names "|too technical/],
  ['polarity', /belongs to|no subject says/],
  ['forced', /needs the forced certificate/],
  ['best or wins', /"best"\/"wins"/],
  ['stops threat', /c-stops/],
  ['tone', /^tone:/],
  ['question', /no questions/],
  ['readability', /^readability:/],
  ['uncertified threat', /could not be certified|NO_THREAT is only/],
  ['didactic', /must use|why needs|only repeats|habit does not fit|pattern must be about/],
  ['shape', /^slot |^output must|characters outside|: empty|opens a sentence/],
]
const classOf = (v: string) => CLASSES.find(([, re]) => re.test(v))?.[0] ?? 'other'

interface Injection {
  name: string
  expect: string // the class that should fire
  apply(why: Slot, p: Packet, r: EngineReport): Slot | undefined // undefined: not applicable here
}

const add = (s: Slot, text: string, refs: string[] = []): Slot => ({ ...s, text: `${s.text} ${text}`, refs: [...s.refs, ...refs] })
const certified = (p: Packet) => new Set(p.certificates.filter(c => c.type === 'tactical').map(c => c.motif as string))
const hasMate = (p: Packet) => p.certificates.some(c => c.type === 'mate') || p.threat?.consequence.type === 'mate' || [p.played, p.tried].some(f => f?.reply.some(r => r.mate))

const INJECTIONS: Injection[] = [
  {
    name: 'move written out',
    expect: 'notation',
    apply: (s, p) => {
      const san = renderRef('best', p)
      if (!san || !s.text.includes('{ref:best}')) return undefined
      const text = s.text.replace('{ref:best}', san)
      return { ...s, text, refs: text.includes('{ref:best}') ? s.refs : s.refs.filter(r => r !== 'best') }
    },
  },
  { name: 'square written out', expect: 'notation', apply: (s, _, r) => add(s, `The ${r.solution[0].slice(2, 4)} square was weak.`) },
  { name: 'fact id not in packet', expect: 'unknown ref', apply: s => add(s, 'Then {ref:pv99} follows.', ['pv99']) },
  {
    name: 'uncertified pattern',
    expect: 'pattern name',
    apply: (s, p) => {
      const name = ['fork', 'pin', 'skewer'].find(n => !certified(p).has(n))
      return name ? add(s, `You missed a ${name}.`) : undefined
    },
  },
  { name: 'undetectable pattern', expect: 'pattern name', apply: s => add(s, 'The idea was a deflection.') },
  { name: '"only move" without certificate', expect: 'forced', apply: (s, p) => (p.certificates.some(c => c.id === 'c-forced') && p.best.unique ? undefined : add(s, 'The answer was the only move.')) },
  { name: 'mate that is not there', expect: 'mate', apply: (s, p) => (hasMate(p) ? undefined : add(s, 'The line ends in mate.')) },
  { name: '"stops" without certificate', expect: 'stops threat', apply: (s, p) => (p.certificates.some(c => c.id === 'c-stops') ? undefined : add(s, 'The answer stops their plan.')) },
  { name: 'praise label', expect: 'tone', apply: s => add(s, 'The answer was a brilliant move.') },
  { name: 'rhetorical question', expect: 'question', apply: s => add(s, 'Did you see it?') },
  {
    name: 'threat given to the wrong side',
    expect: 'polarity',
    apply: s => {
      for (const [from, to] of [['They threatened {ref:threat}', 'You threatened {ref:threat}'], ['They had NO_THREAT', 'You had NO_THREAT']])
        if (s.text.includes(from)) return { ...s, text: s.text.replace(from, to) }
      return undefined
    },
  },
]

const reports = (JSON.parse(readFileSync(REPORTS, 'utf8')) as unknown[]).map(r => validReport(r))
if (reports.some(r => !r)) throw new Error(`${REPORTS}: a report failed validReport`)

const fallback: Record<string, number> = {}
const refusals: Record<string, number> = {}
let packets = 0
let narrated = 0
let floorOk = 0
let floorOkStrict = 0
const floorViolations: Record<string, number> = {}
const inj = Object.fromEntries(INJECTIONS.map(i => [i.name, { expect: i.expect, applicable: 0, rejected: 0, intended: 0, classes: {} as Record<string, number> }]))
const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1)

for (const report of reports as EngineReport[])
  for (const band of BANDS) {
    const built = buildPacket({ ...report, band })
    if (!built.ok) {
      bump(fallback, `packet not built: ${built.error}`)
      continue
    }
    const p = built.packet
    packets++
    if (packetProblems(p).length) bump(fallback, 'packet self-check')
    else if (p.meta.certification.status !== 'certified') {
      bump(fallback, `not certified (${p.meta.certification.status})`)
      for (const r of p.meta.certification.refusals) bump(refusals, r.replace(/[\d.]+/g, 'N'))
    } else if (p.threatStatus === 'uncertified' && !p.position.check.before) bump(fallback, 'threat not certified')
    else narrated++

    const floor = templateFloor(p)
    const fv = validateSlots({ slots: floor }, p).violations
    if (!fv.length) floorOkStrict++
    // The CI test allows these two on the floor: the fixed text is what is shown in both cases
    if (!fv.filter(v => !/^readability|could not be certified/.test(v)).length) floorOk++
    for (const v of fv) bump(floorViolations, classOf(v))

    const at = floor.findIndex(s => s.slot === 'why')
    for (const i of INJECTIONS) {
      const why = i.apply(floor[at], p, report)
      if (!why) continue
      const slots = floor.map((s, k) => (k === at ? why : s))
      // Only what the edit added counts; the floor's own readability misses don't
      const before = new Set(fv)
      const vs = validateSlots({ slots }, p).violations.filter(v => !before.has(v))
      const o = inj[i.name]
      o.applicable++
      if (vs.length) o.rejected++
      const cls = new Set(vs.map(classOf))
      if (cls.has(i.expect)) o.intended++
      for (const c of cls) bump(o.classes, c)
    }
  }

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a')
const lines = [
  `${reports.length} reports x ${BANDS.length} bands = ${packets} packets (${REPORTS})`,
  `reach the narrator: ${narrated} of ${packets}; floor without a model call: ${packets - narrated}`,
  ...Object.entries(fallback).map(([k, n]) => `  ${k}: ${n}`),
  ...Object.entries(refusals).map(([k, n]) => `    refusal "${k}": ${n}`),
  `floor accepted: ${floorOk} of ${packets} (CI rule), ${floorOkStrict} of ${packets} with every rule counted`,
  ...Object.entries(floorViolations).map(([k, n]) => `  floor ${k} violations: ${n}`),
  'injected claim errors (rejected / caught by the intended rule / applicable):',
  ...INJECTIONS.map(i => {
    const o = inj[i.name]
    const other = Object.entries(o.classes).filter(([c]) => c !== i.expect).map(([c, n]) => `${c} ${n}`).join(', ')
    return `  ${i.name}: ${o.rejected} / ${o.intended} / ${o.applicable} (${pct(o.intended, o.applicable)} by ${i.expect}${other ? `; also ${other}` : ''})`
  }),
]
const total = Object.values(inj).reduce((a, o) => [a[0] + o.rejected, a[1] + o.intended, a[2] + o.applicable], [0, 0, 0])
lines.push(`  all: ${total[0]} / ${total[1]} / ${total[2]}`)
console.log(lines.join('\n'))

const out = process.argv.indexOf('--json')
if (out > 0) writeFileSync(process.argv[out + 1], `${JSON.stringify({ packets, narrated, fallback, refusals, floorOk, floorOkStrict, floorViolations, injections: inj }, null, 2)}\n`)

// Exit non-zero if any injected error slipped through, so CI fails on a regression
if (total[0] < total[2]) process.exit(1)
