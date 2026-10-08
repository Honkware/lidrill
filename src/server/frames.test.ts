import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { explainCacheKey, explainFrameOf } from './explainCache'
import { templateFloor } from './floor'
import { promptView, type Caller } from './narrate'
import { acceptanceOf, buildPacket, membershipOf, packetProblems, solvingRefOf, validReport, type EngineReport, type EngineRun, type Packet } from './packet'
import { renderText } from './render'
import { validateSlots } from './slots'

// Fixtures, pinned: the acceptance set
//the
// frame lints ("cost you" and the retired "Answer:" legal only in the miss
// frame; the also-good frame opens "Your move works."), the per-frame floors,
// and the frame in the explanation cache key.
//
//   bun test src/server/frames.test.ts

const run = (lines: EngineRun['lines'], depth = 24): EngineRun => ({ lines, depth, nodes: 1_000_000, capped: false })
const cp = (value: number) => ({ type: 'cp' as const, value })
const mate = (value: number) => ({ type: 'mate' as const, value })

// A knight fork wins the rook; the game move Ke2 let it go; no threat. The
// second MultiPV line is 480 cp - inside τ_accept of 500 - so Ke2 is in the
// acceptance set and the also-good frame has a certified move to name.
const forkFen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const setReport = (over: Partial<EngineReport> = {}): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: forkFen,
  solution: ['d5c7', 'e8d7', 'c7a8'],
  kind: 'missed-win',
  band: 'club',
  best: [run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(500) }, { pv: ['e1e2'], eval: cp(480) }]), run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(505) }, { pv: ['e1e2'], eval: cp(490) }])],
  threat: [run([{ pv: ['a8a1'], eval: cp(-500) }, { pv: ['a8b8'], eval: cp(-510) }]), run([{ pv: ['a8a1'], eval: cp(-505) }, { pv: ['a8b8'], eval: cp(-515) }])],
  played: { uci: 'e1e2', runs: [run([{ pv: ['a8a2'], eval: cp(0) }]), run([{ pv: ['a8a2'], eval: cp(10) }])] },
  habit: { recent: [] },
  ...over,
})

const packetOf = (r: EngineReport): Packet => {
  const b = buildPacket(r)
  if (!b.ok) throw new Error(b.error)
  return b.packet
}

const p = packetOf(setReport())

// A compliant also-good draft over the same packet
const setDraft = (open = 'Your move works. '): { slots: { slot: string; text: string; refs: string[] }[] } => ({
  slots: [
    { slot: 'whatHappened', text: `${open}{ref:alt1} holds up - the engine's first choice is {ref:best}, {ref:c-acc1}.`, refs: ['alt1', 'best', 'c-acc1'] },
    { slot: 'why', text: 'They had NO_THREAT, so you were free to play {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook.', refs: ['c-nothreat', 'best', 'pv1', 'pv2'] },
    { slot: 'pattern', text: 'Your idea: {ref:c-motif}. {ref:gloss:fork}', refs: ['c-motif', 'gloss:fork'] },
    { slot: 'nextTime', text: '{ref:habit:two-targets}', refs: ['habit:two-targets'] },
  ],
})

describe('acceptance set', () => {
  it('accepts any move within τ_accept = 30 cp of best; best first, ≤ 3', () => {
    expect(p.acceptanceSet).toEqual(['d5c7', 'e1e2'])
    expect(p.acceptanceSet.length).toBeLessThanOrEqual(3)
    // The certified gap rides as a packet fact for the also-good frame
    const acc = p.certificates.find(c => c.type === 'acceptance')
    expect(acc).toMatchObject({ id: 'c-acc1', subject: 'alt1' })
    expect(acc!.text).toBe('worth only about 0.2 pawns more')
    expect(p.claimAnchors).toContain('c-acc1')
    expect(packetProblems(p)).toEqual([])
  })

  it('a move outside the window stays out; a disagreeing second opinion excludes', () => {
    const a = run([{ pv: ['a1a2'], eval: cp(500) }, { pv: ['b1b2'], eval: cp(400) }, { pv: ['c1c2'], eval: cp(490) }])
    expect(acceptanceOf(a, undefined, 'a1a2')).toEqual(['a1a2', 'c1c2']) // 400 is 100 cp out; 490 is in
    // The second run rates c1c2 outside the window: excluded
    const b = run([{ pv: ['a1a2'], eval: cp(500) }, { pv: ['c1c2'], eval: cp(440) }])
    expect(acceptanceOf(run([{ pv: ['a1a2'], eval: cp(500) }, { pv: ['c1c2'], eval: cp(490) }]), b, 'a1a2')).toEqual(['a1a2'])
  })

  it('any certified mate counts when best is mate', () => {
    const a = run([{ pv: ['h5h7'], eval: mate(1) }, { pv: ['h5g6'], eval: mate(2) }, { pv: ['a1a2'], eval: cp(0) }])
    const b = run([{ pv: ['h5h7'], eval: mate(1) }, { pv: ['h5g6'], eval: mate(3) }])
    expect(acceptanceOf(a, b, 'h5h7')).toEqual(['h5h7', 'h5g6'])
    // The gap certificate uses mate distance, not pawns
    const matePacket = packetOf({
      ...setReport(),
      fen: '7k/5ppp/4b3/6NQ/8/8/3N1PPP/6K1 w - - 0 1',
      solution: ['h5h7'],
      best: [a, b],
      played: { uci: 'd2b3', runs: [run([{ pv: ['e6b3'], eval: cp(300) }]), run([{ pv: ['e6b3'], eval: cp(300) }])] },
    })
    expect(matePacket.acceptanceSet).toEqual(['h5h7', 'h5g6'])
    expect(matePacket.certificates.find(c => c.type === 'acceptance')!.text).toBe('mate in 1 rather than mate in 2')
  })

  it('hold puzzles accept every holding move - the production home of also-good', () => {
    // Selection margins refuse non-unique missed-wins, so a non-trivial
    // acceptance set on a missed-win can't certify; holds are certified with
    // every holding move in the set
    const hold = packetOf(setReport({ kind: 'hold', holding: ['d5c7', 'e1e2'] }))
    expect(hold.meta.certification.status).toBe('certified')
    expect(hold.acceptanceSet).toEqual(['d5c7', 'e1e2'])
    // With a recorded game move the miss frame keeps the contrast; a hold
    // with no game move names its holding moves instead
    expect(hold.didactic.requiredRefs.whatHappened).toEqual(['played', 'best', 'swing|c-punish'])
    // All three frames' floors meet the validator on a certified hold puzzle
    for (const frame of [{ membership: 'miss' as const }, { membership: 'best' as const }, { membership: 'set' as const, solvingRef: 'alt1' }]) {
      const floor = templateFloor(hold, frame)
      const violations = validateSlots({ slots: floor }, hold, frame).violations.filter(v => !/^readability/.test(v))
      expect(violations, frame.membership).toEqual([])
    }
    const setFloor = renderText(templateFloor(hold, { membership: 'set', solvingRef: 'alt1' }), hold)
    expect(setFloor.whatHappened).toBe('Your move works. Ke2 holds up - the engine\'s first choice is Nc7+, worth only about 0.2 pawns more.')
  })

  it('the corpus packets all carry a valid set containing the best move', () => {
    const reports = JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8')) as unknown[]
    for (const raw of reports) {
      const r = validReport(JSON.parse(JSON.stringify(raw)))
      if (!r) continue
      const b = buildPacket(r)
      if (!b.ok) continue
      expect(b.packet.acceptanceSet[0]).toBe(b.packet.best.uci)
      expect(b.packet.acceptanceSet.length).toBeLessThanOrEqual(3)
    }
  })
})

describe('frame lints', () => {
  it('membership: best / set / miss against the packet', () => {
    expect(membershipOf('d5c7', p)).toBe('best')
    expect(membershipOf('e1e2', p)).toBe('set')
    expect(membershipOf('d5f6', p)).toBe('miss')
    expect(membershipOf(undefined, p)).toBe('miss')
    expect(solvingRefOf('e1e2', p)).toBe('alt1')
    expect(solvingRefOf('d5c7', p)).toBe('best')
  })

  it('a best-solve explanation containing "cost you" fails', () => {
    const draft = setDraft('').slots.map(s => (s.slot === 'whatHappened' ? { ...s, text: 'You found {ref:best}, the engine\'s best move, and it cost you nothing.', refs: ['best'] } : s))
    const verdict = validateSlots({ slots: draft }, p, { membership: 'best' })
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/"cost you" belongs to the miss frame/)
  })

  it('an also-good without "Your move works." fails; with it, the same draft passes', () => {
    const without = validateSlots(setDraft(''), p, { membership: 'set', solvingRef: 'alt1' })
    expect(without.ok).toBe(false)
    expect(without.violations.join()).toMatch(/opens with "Your move works\."/)
    expect(validateSlots(setDraft(), p, { membership: 'set', solvingRef: 'alt1' })).toMatchObject({ ok: true, violations: [] })
  })

  it('"Answer:" anywhere fails - in every frame, the miss frame included', () => {
    for (const frame of [{ membership: 'miss' as const }, { membership: 'best' as const }, { membership: 'set' as const, solvingRef: 'alt1' }]) {
      const base = frame.membership === 'best' ? setDraft('').slots.map(s => (s.slot === 'whatHappened' ? { ...s, text: 'You found {ref:best}, the engine\'s best move.', refs: ['best'] } : s)) : setDraft().slots
      const withAnswer = base.map(s => (s.slot === 'whatHappened' ? { ...s, text: `${s.text} Answer: {ref:best}.`, refs: [...new Set([...s.refs, 'best'])] } : s))
      const verdict = validateSlots({ slots: withAnswer }, p, frame)
      expect(verdict.ok, frame.membership).toBe(false)
      expect(verdict.violations.join(), frame.membership).toMatch(/"Answer:" is retired/)
    }
  })

  it('"cost you" stays legal in the miss frame', () => {
    const miss = templateFloor(p)
    expect(renderText(miss, p).whatHappened).toBe('In the game, Ke2 cost you 5.0 pawns. Best was: Nc7+.')
    expect(validateSlots({ slots: miss }, p).ok).toBe(true)
  })
})

describe('per-frame floors', () => {
  it('best affirms the found move - no "cost you", no "Best was:"', () => {
    const floor = renderText(templateFloor(p, { membership: 'best' }), p)
    expect(floor.whatHappened).toBe('You played Nc7+, the engine\'s best move.')
    expect(floor.whatHappened).not.toMatch(/cost you|Best was:/)
    expect(validateSlots({ slots: templateFloor(p, { membership: 'best' }) }, p, { membership: 'best' }).violations.filter(v => !/^readability/.test(v))).toEqual([])
  })

  it('also-good opens "Your move works." and names both moves with the certified gap', () => {
    const floor = renderText(templateFloor(p, { membership: 'set', solvingRef: 'alt1' }), p)
    expect(floor.whatHappened).toBe('Your move works. Ke2 holds up - the engine\'s first choice is Nc7+, worth only about 0.2 pawns more.')
    expect(floor.whatHappened).not.toMatch(/cost you|Answer:/)
    expect(validateSlots({ slots: templateFloor(p, { membership: 'set', solvingRef: 'alt1' }) }, p, { membership: 'set', solvingRef: 'alt1' }).violations.filter(v => !/^readability/.test(v))).toEqual([])
  })

  it('miss keeps the contrast frame with the "Best was:" label', () => {
    const floor = renderText(templateFloor(p), p)
    expect(floor.whatHappened).toContain('cost you')
    expect(floor.whatHappened).toContain('Best was:')
    expect(floor.whatHappened).not.toContain('Answer:')
  })

  it('the narrator input carries the solving move and its membership', () => {
    const view = promptView(p, { membership: 'set', solvingRef: 'alt1' })
    expect(view.solve).toEqual({ membership: 'set', move: 'alt1', acceptanceSet: ['d5c7', 'e1e2'] })
    expect(view.required.whatHappened.join()).toMatch(/alt1/)
    expect(promptView(p, { membership: 'best' }).required.whatHappened).toEqual(['best'])
  })
})

describe('cache key gains the frame', () => {
  const slim = (solved?: string) => JSON.stringify({ v: 2, packetHash: 'sha256:' + 'a'.repeat(64), band: 'club', ...(solved ? { solved } : {}) })

  it('the frame stands in the key: different solving move, different entry', () => {
    expect(explainFrameOf(slim())).toBe('none')
    expect(explainFrameOf(slim('d5c7'))).toBe('d5c7')
    expect(explainCacheKey(14, slim('d5c7')).url).not.toBe(explainCacheKey(14, slim('e1e2')).url)
    expect(explainCacheKey(14, slim('d5c7')).url).not.toBe(explainCacheKey(14, slim()).url)
    expect(explainCacheKey(14, slim('d5c7')).url).toBe(explainCacheKey(14, slim('d5c7')).url)
  })

  it('through the narrator, the frame selects the floor on failure', async () => {
    const canned: Caller = async () => ({ json: { slots: [] }, cost: 0.001, model: 'test' })
    const { narrate } = await import('./narrate')
    const best = await narrate(p, canned, { move: 'd5c7', membership: 'best' })
    expect(best.frame).toBe('best')
    expect(renderText(best.slots, p).whatHappened).toBe('You played Nc7+, the engine\'s best move.')
    const set = await narrate(p, canned, { move: 'e1e2', membership: 'set' })
    expect(set.frame).toBe('set')
    expect(renderText(set.slots, p).whatHappened).toContain('Your move works.')
  })
})
