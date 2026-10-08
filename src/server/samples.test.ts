import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { templateFloor } from './floor'
import { narrate, prune, type Caller } from './narrate'
import { buildPacket, validReport, type EngineReport, type EngineRun, type Packet } from './packet'
import { renderText, type Slot } from './render'
import { validateSlots } from './slots'

// Sample gate fixtures, pinned permanently: the three
// verbatim sample texts from run over the committed gate corpus
// - one mate, one material win, one quiet position, at club - plus the
// seeded failures the rules raise against them.
//
//   sample 1 (mate):     4k1n1/p3n2Q/2p3p1/1p3p2/6q1/1B1bK3/1P1N1PPP/7R
//   sample 2 (material): 4k1n1/p3n2Q/2p3p1/1p1q1p2/1B3K2/3b4/1P1N1PPP/3B3R
//   sample 3 (quiet):    3q3r/2pbn1k1/prn2pp1/1p2b2p/1P2P1P1/PQP4P/1B1NN1B1/K2R1R2

const reports = JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8')) as unknown[]

const packetOf = (raw: unknown, band: 'beginner' | 'club' | 'advanced' = 'club'): Packet => {
  const r = validReport(JSON.parse(JSON.stringify({ ...(raw as object), band })))
  if (!r) throw new Error('report does not validate')
  const b = buildPacket(r)
  if (!b.ok) throw new Error(b.error)
  return b.packet
}

const swingOf = (p: Packet) => Math.abs(p.played?.swing?.type === 'cp' ? p.played.swing.value : 0)
const built = reports.flatMap(raw => {
  try {
    return [{ raw, packet: packetOf(raw) }]
  } catch {
    return []
  }
})

// The same class picks as scripts/sample-gate.ts at club
const sample2 = built.find(x => x.packet.best.mateIn === null && swingOf(x.packet) >= 300)!
const sample3 = built.find(x => x.packet.best.mateIn === null && x.packet.didactic.motif === 'none')!
const sample1 =
  built.find(x => x.packet.best.mateIn !== null && x.packet.threatStatus === 'certified') ?? built.find(x => x.packet.best.mateIn !== null)!

// The verbatim texts (gate-out.json, club)
const sample1Text: Slot[] = [
  { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}.', refs: ['played', 'swing'] },
  { slot: 'why', text: '{ref:best} is met by {ref:pv1}, then {ref:pv2}. In the game, {ref:played} was answered by {ref:pl1}. You had {ref:material}.', refs: ['best', 'pv1', 'pv2', 'played', 'pl1', 'material'] },
  { slot: 'pattern', text: 'Your idea: {ref:c-motif}. {ref:gloss:fork}', refs: ['c-motif', 'gloss:fork'] },
  { slot: 'nextTime', text: '{ref:habit:trade-down}', refs: ['habit:trade-down'] },
]
const sample2Text: Slot[] = [
  { slot: 'whatHappened', text: 'In the game, you played {ref:played}, costing {ref:swing}.', refs: ['played', 'swing'] },
  { slot: 'why', text: 'They threatened {ref:threat}. Instead, your {ref:pv0} meets it because {ref:c-stops}. After their {ref:pv1}, your {ref:pv2} drives their {ref:pv3}.', refs: ['threat', 'pv0', 'c-stops', 'pv1', 'pv2', 'pv3'] },
  { slot: 'pattern', text: '{ref:gloss:discovered-attack} Here, your {ref:c-motif}.', refs: ['gloss:discovered-attack', 'c-motif'] },
  { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'] },
]
const sample3Text: Slot[] = [
  { slot: 'whatHappened', text: 'In the game, your {ref:played} cost {ref:swing}.', refs: ['played', 'swing'] },
  { slot: 'why', text: 'They threatened your position with their {ref:threat}. You needed your {ref:best} because {ref:c-forced}..', refs: ['threat', 'best', 'c-forced'] },
  { slot: 'pattern', text: '{ref:gloss:none}', refs: ['gloss:none'] },
  { slot: 'nextTime', text: '{ref:habit:their-move}', refs: ['habit:their-move'] },
]

describe('samples as permanent fixtures', () => {
  it('the three class picks are the recorded positions', () => {
    expect(sample1.packet.best.mateIn).not.toBeNull()
    expect(sample2.packet.played?.san).toBe('Qd4+')
    expect(sample3.packet.didactic.motif).toBe('none')
  })

  it("sample 2's pattern slot is the positive control", () => {
    const p = sample2.packet
    expect(p.didactic.habitSlotId).toBe('habit:line-behind')
    const compliant: Slot[] = [
      { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}. Answer: {ref:best}.', refs: ['played', 'swing', 'best'] },
      { slot: 'why', text: 'They threatened {ref:threat}. Answer: {ref:best}. {ref:c-stops}.', refs: ['threat', 'best', 'c-stops'] },
      sample2Text[2]!,
      { slot: 'nextTime', text: '{ref:habit:line-behind}', refs: ['habit:line-behind'] },
    ]
    expect(validateSlots({ slots: compliant }, p)).toMatchObject({ ok: true, violations: [] })
  })

  it("sample 2's verbatim whatHappened/why are seeded failures under V-POV and V-LINE", () => {
    const p = sample2.packet
    const verdict = validateSlots({ slots: sample2Text }, p)
    expect(verdict.ok).toBe(false)
    const all = verdict.violations.join('\n')
    // V-POV: "your {ref:pv0}" - the answer is not the player's move
    expect(all).toMatch(/"your" attaches to pv0/)
    expect(all).toMatch(/"your" attaches to pv2/)
    // V-LINE: "drives their Kh3" runs the hunt past the answer with no
    // certified outcome at the end
    expect(all).toMatch(/runs past the answer without ending at the certified outcome/)
  })

  it('V-POV seeds the exact sentence: "The winning choice was your {ref:best}."', () => {
    const p = sample2.packet
    const draft: Slot[] = sample2Text.map(s => (s.slot === 'whatHappened' ? { slot: 'whatHappened', text: 'The winning choice was your {ref:best}.', refs: ['best'] } : s))
    const verdict = validateSlots({ slots: draft }, p)
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/"your" attaches to best - possessives attach only to the game move/)
  })

  it('V-SWING prunes an orphaned magnitude: "lost 3.7 pawns" must bind to its certificate', () => {
    const p = sample2.packet
    expect(p.played?.swing).toMatchObject({ type: 'cp' })
    expect(renderText([sample2Text[0]!], p).whatHappened).toContain('3.7 pawns')
    const slots: Slot[] = [
      { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}. That drive cost you 3.7 pawns.', refs: ['played', 'swing'] },
      sample2Text[1]!,
      sample2Text[2]!,
      sample2Text[3]!,
    ]
    const claims = {
      claims: [
        { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}.', refs: ['played', 'swing'], tense: 'past' },
        { slot: 'whatHappened', text: 'That drive cost you 3.7 pawns.', refs: ['played'], tense: 'past' },
      ],
    }
    const pruned = prune(slots, claims, p)!
    // The bound magnitude stays; the orphaned one is cut
    expect(pruned.removed).toBe(1)
    expect(pruned.slots.find(s => s.slot === 'whatHappened')!.text).not.toMatch(/That drive/)
  })

  it('through the pipeline, sample 2 verbatim fails repair and floors', async () => {
    const p = sample2.packet
    const canned: Caller = async c => ({ json: c.pass === 'decompose' ? null : { slots: sample2Text }, cost: 0.001, model: c.model })
    const n = await narrate(p, canned)
    expect(n.source).toBe('floor')
    expect(n.reason).toMatch(/repair failed/)
  })

  it('the deep-uncertified-mate floor is a seeded failure: bounded form, no line past the mate', () => {
    // A direct mate in 1: the certified line is the single move, so any
    // floor that walks plies beyond it is incoherent
    const run = (lines: EngineRun['lines']): EngineRun => ({ lines, depth: 24, nodes: 1_000_000, capped: false })
    const report: EngineReport = {
      schema: 'lidrill-report/1',
      fen: '7k/5ppp/4b3/6NQ/8/8/3N1PPP/6K1 w - - 0 1',
      solution: ['h5h7'],
      kind: 'missed-win',
      band: 'club',
      best: [run([{ pv: ['h5h7'], eval: { type: 'mate', value: 1 } }]), run([{ pv: ['h5h7'], eval: { type: 'mate', value: 1 } }])],
      played: { uci: 'd2b3', runs: [run([{ pv: ['e6b3'], eval: { type: 'cp', value: 300 } }]), run([{ pv: ['e6b3'], eval: { type: 'cp', value: 300 } }])] },
      habit: { recent: [] },
    }
    const p = packetOf(report)
    // The old floor shape walked plies past the certified mate line
    const oldFloor = templateFloor(p).map(s => (s.slot === 'why' ? { ...s, text: 'After {ref:best} and {ref:pv1}, {ref:pv2} follows: {ref:c-mate}.', refs: ['best', 'pv1', 'pv2', 'c-mate'] } : s))
    const verdict = validateSlots({ slots: oldFloor }, p)
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/past the certified mate line/)
    // The new floor is bounded - no line at all, "mate in at most 1"
    const floor = renderText(templateFloor(p), p)
    expect(floor.why).toContain('mate in at most 1')
    expect(floor.why).not.toContain('and')
    expect(validateSlots({ slots: templateFloor(p) }, p).violations.filter(v => !/^readability/.test(v))).toEqual([])
  })

  it('the threat-certified floor is a seeded failure: never "no named pattern"', () => {
    const p = sample3.packet
    expect(p.threatStatus).toBe('certified')
    expect(p.didactic.glossId).toBe('gloss:meeting-the-threat')
    const verdict = validateSlots({ slots: sample3Text }, p)
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/pattern must use gloss:meeting-the-threat/)
    // The new floor names the meeting-the-threat gloss and passes
    const floor = renderText(templateFloor(p), p)
    expect(floor.pattern).toContain('Meeting the threat')
    expect(validateSlots({ slots: templateFloor(p) }, p).violations.filter(v => !/^readability/.test(v))).toEqual([])
  })

  it('mate floor shape is a seeded V-LINE failure; the new floors pass', () => {
    // Sample 1's verbatim floor why ended the line at a non-outcome move
    const verdict = validateSlots({ slots: sample1Text }, sample1.packet)
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/runs past the answer/)
    for (const { packet } of [sample1, sample2, sample3]) {
      const violations = validateSlots({ slots: templateFloor(packet) }, packet).violations.filter(v => !/^readability|could not be certified/.test(v))
      expect(violations, packet.position.fenBefore).toEqual([])
    }
  })
})
