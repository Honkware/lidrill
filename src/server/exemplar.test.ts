import { describe, expect, it } from 'vitest'
import type { Band } from '../db'
import { templateFloor } from './floor'
import { MODELS, narrate, type Caller } from './narrate'
import { buildPacket, packetProblems, type Certificate, type EngineReport, type EngineRun, type Packet } from './packet'
import { renderText, type Slot } from './render'
import { STYLE_WORDS, styleBudget, words } from './readability'
import { validateSlots } from './slots'

const run = (lines: EngineRun['lines'], depth = 24): EngineRun => ({ lines, depth, nodes: 1_000_000, capped: false })
const cp = (value: number) => ({ type: 'cp' as const, value })
const mate = (value: number) => ({ type: 'mate' as const, value })

// The exemplar position: White missed Qxh7# (mate in 1, the knight
// on g5 covers the flight squares) and played Nb3, hanging the knight to
// Bxb3. The bad half of the exemplar must floor; the good half must pass
// the validator at B1 unmodified.
const exemplarFen = '7k/5ppp/4b3/6NQ/8/8/3N1PPP/6K1 w - - 0 1'
const exemplarReport = (band: Band = 'beginner'): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: exemplarFen,
  solution: ['h5h7'],
  kind: 'missed-win',
  band,
  best: [run([{ pv: ['h5h7'], eval: mate(1) }]), run([{ pv: ['h5h7'], eval: mate(1) }])],
  played: { uci: 'd2b3', runs: [run([{ pv: ['e6b3'], eval: cp(300) }]), run([{ pv: ['e6b3'], eval: cp(300) }])] },
  habit: { recent: [] },
})

const packetOf = (r: EngineReport): Packet => {
  const b = buildPacket(r)
  if (!b.ok) throw new Error(b.error)
  return b.packet
}

// The mating net, certified: what the queen hits, what the knight covers,
// what nobody guards. (A real packet gets this from a detector; the style
// contract only cares that the claim is anchored to a fact.)
const exemplarPacket = (band: Band = 'beginner'): Packet => {
  const p = packetOf(exemplarReport(band))
  const net: Certificate = {
    id: 'c-net',
    type: 'mate',
    subject: 'best',
    side: 'w',
    targetSide: 'b',
    payload: { lineIds: ['pv0'] },
    text: 'The queen attacks h7. The knight on g5 covers the escape square. No black piece guards h7.',
  }
  p.certificates.push(net)
  p.claimAnchors.push('c-net')
  return p
}

// The good half of the exemplar, in ref form: every move and square the
// exemplar's prose shows is a {ref:…} here - the narrator can write no other.
const goodExemplar = (): Slot[] => [
  {
    slot: 'whatHappened',
    text: 'In the game, {ref:played} cost you {ref:swing}. This position has a direct win. {ref:best} gives {ref:c-mate}.',
    refs: ['played', 'swing', 'best', 'c-mate'],
  },
  { slot: 'why', text: '{ref:c-net}.', refs: ['c-net'] },
  { slot: 'pattern', text: 'Your knight guards the flight square: {ref:c-mate}.', refs: ['c-mate'] },
  { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'] },
]

// The bad half: bare "in the game", an uncosted game move, no best move,
// jargon-free vagueness in the pattern slot, a filler habit, and no
// trigger anchor anywhere.
const badExemplar = (): Slot[] => [
  {
    slot: 'whatHappened',
    text: 'You had the initiative in the game. In the game, {ref:played} cost you {ref:swing}.',
    refs: ['played', 'swing'],
  },
  { slot: 'why', text: 'The attack played itself once the pressure built.', refs: [] },
  { slot: 'pattern', text: 'Strong players feel these things instinctively.', refs: [] },
  { slot: 'nextTime', text: 'Trust your gut and play what feels natural.', refs: [] },
]

describe('exemplar pair', () => {
  it('the fixture packet is certified, a mate in 1, with the exemplar didactic sets', () => {
    const p = exemplarPacket()
    expect(p.meta.certification.status).toBe('certified')
    expect(p.best.mateIn).toBe(1)
    expect(p.threatStatus).toBe('uncertified') // no threat runs: mate in 1 makes them moot
    expect(p.didactic.requiredRefs.whatHappened).toEqual(['played', 'best', 'swing|c-punish'])
    expect(p.didactic.requiredRefs.why).toEqual([]) // mate in 1: no threat requirement
    expect(p.didactic.requiredRefs.pattern).toEqual(['c-mate'])
    expect(p.didactic.habitSlotId).toBe('habit:cct-scan')
    expect(packetProblems(p)).toEqual([])
  })

  it('the good half passes the validator at B1 unmodified', () => {
    const p = exemplarPacket('beginner')
    const verdict = validateSlots({ slots: goodExemplar() }, p)
    expect(verdict).toMatchObject({ ok: true, violations: [] })
  })

  it('the good half renders the exemplar within the B1 style budget', () => {
    const p = exemplarPacket('beginner')
    const text = renderText(goodExemplar(), p)
    const whole = Object.values(text).join(' ')
    expect(words(whole).length).toBeLessThanOrEqual(STYLE_WORDS.beginner)
    expect(styleBudget(whole, 'beginner')).toBeUndefined()
    expect(text.whatHappened).toBe('In the game, Nb3 cost you a mate in 1. This position has a direct win. Qxh7# gives mate in at most 1.')
    expect(text.why).toBe('The queen attacks h7. The knight on g5 covers the escape square. No black piece guards h7.')
    expect(text.pattern).toBe('Your knight guards the flight square: mate in at most 1.')
    expect(text.nextTime).toBe('When I move, I first look at checks, captures and threats.')
  })

  it('the good half also fits club and advanced; above B1 the mechanism minimum is the only addition', () => {
    for (const band of ['club', 'advanced'] as const) {
      const p = exemplarPacket(band)
      const verdict = validateSlots({ slots: goodExemplar() }, p)
      // M-COUNT: B2/B3 need two mechanism refs, the exemplar why has one
      expect(verdict.ok, band).toBe(false)
      expect(verdict.violations.join(), band).toMatch(/needs at least 2 steps/)
    }
  })

  it('the bad half floors: bare "in the game", no term, filler habit, no trigger anchor', () => {
    const p = exemplarPacket('beginner')
    const verdict = validateSlots({ slots: badExemplar() }, p)
    expect(verdict.ok).toBe(false)
    const all = verdict.violations.join('\n')
    expect(all).toMatch(/"the game" with no game fact/) // bare "in the game"
    expect(all).toMatch(/abstraction/) // unanchored abstraction (initiative / attack / pressure)
    expect(all).toMatch(/pattern must use c-mate/) // no certified term in the pattern slot
    expect(all).toMatch(/nextTime must use habit:cct-scan/) // filler habit, not the library one
  })

  it('through the pipeline: the bad half fails repair and serves the floor; the good half is model-served', async () => {
    const p = exemplarPacket('beginner')
    const canned = (drafts: unknown[]): Caller => async c => ({ json: drafts.shift() ?? null, cost: 0.001, model: c.model })
    const bad = await narrate(p, canned([{ slots: badExemplar() }, { slots: badExemplar() }]))
    expect(bad).toMatchObject({ source: 'floor', calls: 2 })
    expect(bad.reason).toMatch(/repair failed/)

    const claims = {
      claims: [
        { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}.', refs: ['played', 'swing'], tense: 'past' },
        { slot: 'whatHappened', text: 'This position has a direct win.', refs: [], tense: 'none' },
        { slot: 'whatHappened', text: '{ref:best} gives {ref:c-mate}.', refs: ['best', 'c-mate'], tense: 'past' },
        { slot: 'why', text: '{ref:c-net}.', refs: ['c-net'], tense: 'past' },
        { slot: 'pattern', text: 'Your knight guards the flight square: {ref:c-mate}.', refs: ['c-mate'], tense: 'present' },
        { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'], tense: 'none' },
      ],
    }
    const caller: Caller = async c => ({ json: c.pass === 'decompose' ? claims : { slots: goodExemplar() }, cost: 0.001, model: c.model })
    const good = await narrate(p, caller)
    expect(good).toMatchObject({ source: 'model', pruned: 0 })
    expect(good.models).toEqual([MODELS.draft.model, MODELS.lint.model])
  })

  it('the floor for the exemplar packet stays inside the style budget too', () => {
    const p = exemplarPacket('beginner')
    const floor = templateFloor(p)
    expect(validateSlots({ slots: floor }, p).violations).toEqual([])
    const whole = Object.values(renderText(floor, p)).join(' ')
    expect(styleBudget(whole, 'beginner')).toBeUndefined()
  })
})
