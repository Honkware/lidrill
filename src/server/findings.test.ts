import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { templateFloor } from './floor'
import { buildPacket, validReport, type Packet } from './packet'
import { renderText, type Slot } from './render'
import { validateSlots } from './slots'

// Fixtures: four mistakes found in a live sample, each kept as a failing
// case (a swing stated twice, pattern order, frames, mismatched habits):
//
//   sample (BEST frame): "Puzzle complete. The move was Rxb4. In the game:
//   Rb7, giving away about three pawns (about a knight or bishop). You played
//   Rxb4, the engine's best move. They threatened axb6, which would win a
//   rook. After Rxb4, Qa2, Kxb1 follow. Meeting the threat: their threat
//   sets the task here. First name their threat, then look for the move that
//   answers it. Next time: When I move, I first look at checks, captures and
//   threats."
//
// 1. the game-move cost line rendered on an affirm frame - it came from the
//    drill's post-solve result card (src/views/drill.ts), which composed its
// own text outside the packet/validator/narrator path where the
//    frame lints live; the surface now gates the line to the miss frame and
//    the validator bans cost language in affirm frames
// 2. V-DUP: "about three pawns (about a knight or bishop)" - one swing
//    rendered in two buckets; mechanical lint, seeded with the exact text
// 3. the pattern slot was a bare gloss with zero position refs
//    ("Meeting the threat: their threat sets the task here…"); ≥1 position
//    ref is now mechanical, instance first, gloss second
// 4. the nextTime was the generic CCT gloss on a threat-meeting puzzle;
//    habit selection is mechanism-keyed - the packet's task meeting the
//    threat selects habit:meet-threat whatever the puzzle family
//
//   bunx vitest run src/server/findings.test.ts

// Same freeze as samples.test.ts: these findings are pinned to the saved
// corpus, so the class picks below read its frozen reports, not the live
// gate output (which grows with the corpus - added Player_02's games)
const reports = JSON.parse(readFileSync('src/server/fixtures/sample-gate-reports.json', 'utf8')) as unknown[]

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

// The same class picks as samples.test.ts at club: a material win (the
// BEST-frame sample's class - sample 2, a certified threat) and the
// quiet threat-meeting position (the sample's pattern/nextTime class)
const sample2 = built.find(x => x.packet.best.mateIn === null && swingOf(x.packet) >= 300)!
const sample3 = built.find(x => x.packet.didactic.glossId === 'gloss:meeting-the-threat')!

// The seeded whatHappened: the result-card sentence, in the BEST frame
const costLine = 'In the game: {ref:played}, giving away about three pawns (about a knight or bishop).'

describe('finding 1 - cost language on an affirm frame', () => {
  const rest: Slot[] = [
    { slot: 'why', text: 'They threatened {ref:threat}. {ref:best} answers it because {ref:c-stops}.', refs: ['threat', 'best', 'c-stops'] },
    { slot: 'pattern', text: 'Here, your {ref:c-motif}. {ref:gloss:discovered-attack}', refs: ['c-motif', 'gloss:discovered-attack'] },
    { slot: 'nextTime', text: '{ref:habit:line-behind}', refs: ['habit:line-behind'] },
  ]

  it('the exact result-card sentence fails in the best frame', () => {
    const p = sample2.packet
    const draft: Slot[] = [{ slot: 'whatHappened', text: `Puzzle complete. The move was {ref:best}. ${costLine}`, refs: ['best', 'played'] }, ...rest]
    const verdict = validateSlots({ slots: draft }, p, { membership: 'best' })
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/the game move's cost belongs to the miss frame/)
    // The same sentence is legal contrast language on a miss - the frame,
    // not the sentence, was the bug
    const miss: Slot[] = [{ slot: 'whatHappened', text: `${costLine} Best was: {ref:best}.`, refs: ['played', 'best'] }, ...rest]
    const missVerdict = validateSlots({ slots: miss }, p)
    expect(missVerdict.violations.join()).not.toMatch(/belongs to the miss frame/)
  })
})

describe('finding 2 - V-DUP: one swing, one bucket', () => {
  it('the exact double-bucket text is a violation, in every frame', () => {
    const p = sample2.packet
    for (const frame of [{ membership: 'miss' as const }, { membership: 'best' as const }]) {
      const what: Slot =
        frame.membership === 'miss'
          ? { slot: 'whatHappened', text: `${costLine} Best was: {ref:best}.`, refs: ['played', 'best'] }
          : { slot: 'whatHappened', text: `You played {ref:best}, the engine's best move. ${costLine}`, refs: ['best', 'played'] }
      const draft: Slot[] = [what, ...sample2Rest()]
      const verdict = validateSlots({ slots: draft }, p, frame)
      expect(verdict.ok, frame.membership).toBe(false)
      expect(verdict.violations.join(), frame.membership).toMatch(/one swing renders once/)
    }
  })

  it('the same magnitude ref twice in one sentence is a violation', () => {
    const p = sample2.packet
    const draft: Slot[] = [
      { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing} - about {ref:swing} gone. Best was: {ref:best}.', refs: ['played', 'swing', 'best'] },
      ...sample2Rest(),
    ]
    const verdict = validateSlots({ slots: draft }, p)
    expect(verdict.violations.join()).toMatch(/one swing renders once/)
  })

  it('one bucket phrasing passes', () => {
    const p = sample2.packet
    const draft: Slot[] = [{ slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}. Best was: {ref:best}.', refs: ['played', 'swing', 'best'] }, ...sample2Rest()]
    expect(validateSlots({ slots: draft }, p).violations.filter(v => !/^readability/.test(v))).toEqual([])
  })
})

describe('finding 3 - the pattern slot needs its position ref', () => {
  it('the verbatim bare gloss (zero position refs) is a seeded failure', () => {
    const p = sample3.packet
    expect(p.didactic.glossId).toBe('gloss:meeting-the-threat')
    const draft: Slot[] = [
      { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}. Best was: {ref:best}.', refs: ['played', 'swing', 'best'] },
      { slot: 'why', text: 'They threatened {ref:threat}. {ref:best} answers it.', refs: ['threat', 'best'] },
      { slot: 'pattern', text: '{ref:gloss:meeting-the-threat}', refs: ['gloss:meeting-the-threat'] },
      { slot: 'nextTime', text: '{ref:habit:meet-threat}', refs: ['habit:meet-threat'] },
    ]
    const verdict = validateSlots({ slots: draft }, p)
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/bare definition with no position ref/)
  })

  it('gloss-first with an instance present fails; instance-first passes', () => {
    const p = sample2.packet
    const glossFirst: Slot[] = sample2Rest().map(s => (s.slot === 'pattern' ? { slot: 'pattern', text: '{ref:gloss:discovered-attack} Here, your {ref:c-motif}.', refs: ['gloss:discovered-attack', 'c-motif'] } : s))
    const what: Slot[] = [{ slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}. Best was: {ref:best}.', refs: ['played', 'swing', 'best'] }]
    expect(validateSlots({ slots: [...what, ...glossFirst] }, p).violations.join()).toMatch(/instance first, gloss second/)
    expect(validateSlots({ slots: [...what, ...sample2Rest()] }, p).violations.filter(v => !/^readability/.test(v))).toEqual([])
  })

  it('the floor opens the pattern with the instance, then the gloss', () => {
    const floor = renderText(templateFloor(sample3.packet), sample3.packet)
    expect(floor.pattern).toContain('Meeting the threat')
    expect(floor.pattern.startsWith('Meeting the threat')).toBe(false)
    expect(validateSlots({ slots: templateFloor(sample3.packet) }, sample3.packet).violations.filter(v => !/^readability/.test(v))).toEqual([])
  })
})

describe('finding 4 - mechanism-keyed habit selection', () => {
  it("a threat-meeting puzzle's packet carries the meet-threat habit, not the generic CCT gloss", () => {
    const p = sample3.packet
    expect(p.didactic.glossId).toBe('gloss:meeting-the-threat')
    expect(p.didactic.habitSlotId).toBe('habit:meet-threat')
    const floor = templateFloor(p)
    expect(floor.find(s => s.slot === 'nextTime')?.refs).toEqual(['habit:meet-threat'])
  })
})

// The remaining slots for a compliant sample-2 draft (instance-first pattern)
function sample2Rest(): Slot[] {
  return [
    { slot: 'why', text: 'They threatened {ref:threat}. {ref:best} answers it because {ref:c-stops}.', refs: ['threat', 'best', 'c-stops'] },
    { slot: 'pattern', text: 'Here, your {ref:c-motif}. {ref:gloss:discovered-attack}', refs: ['c-motif', 'gloss:discovered-attack'] },
    { slot: 'nextTime', text: '{ref:habit:line-behind}', refs: ['habit:line-behind'] },
  ]
}
