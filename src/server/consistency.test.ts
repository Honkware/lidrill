// @vitest-environment node
// Consecutive critical moments from one game must be monotone-
// consistent with the stored certified eval line within τ_instab; violations
// collapse to the weaker verdict.
import { describe, expect, it } from 'vitest'
import type { Game } from '../db'
import { LINE_REFUSAL, lineEvalCp, reconcileWithLine } from './consistency'
import { buildPacket, CERT, cpOf, type EngineReport, type EngineRun, type Packet } from './packet'

const run = (lines: EngineRun['lines'], depth = 24): EngineRun => ({ lines, depth, nodes: 1_000_000, capped: false })
const cp = (value: number) => ({ type: 'cp' as const, value })
const mate = (value: number) => ({ type: 'mate' as const, value })

// A quiet +500 cp position, certified and stable, certifiedNull threat, a
// played move with a -500 cp swing - the shape the line check adjusts.
const forkFen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const forkReport = (over: Partial<EngineReport> = {}): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: forkFen,
  solution: ['d5c7', 'e8d7', 'c7a8'],
  kind: 'missed-win',
  band: 'club',
  best: [run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(500) }, { pv: ['e1e2'], eval: cp(300) }]), run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(505) }, { pv: ['e1e2'], eval: cp(295) }])],
  threat: [run([{ pv: ['e8e7'], eval: cp(-500) }]), run([{ pv: ['e8e7'], eval: cp(-495) }])],
  played: { uci: 'e1e2', runs: [run([{ pv: ['e8d7'], eval: cp(0) }]), run([{ pv: ['e8d7'], eval: cp(5) }])] },
  habit: { recent: [] },
  ...over,
})

// The player mates in 1: a certified mate must survive any line claim
const mateReport = (): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: forkFen,
  solution: ['d5c7'],
  kind: 'missed-win',
  band: 'club',
  best: [run([{ pv: ['d5c7'], eval: mate(1) }, { pv: ['e1e2'], eval: cp(-300) }]), run([{ pv: ['d5c7'], eval: mate(1) }, { pv: ['e1e2'], eval: cp(-300) }])],
  threat: [run([{ pv: ['e8e7'], eval: cp(-400) }]), run([{ pv: ['e8e7'], eval: cp(-390) }])],
  played: { uci: 'e1e2', runs: [run([{ pv: ['e8d7'], eval: cp(-800) }]), run([{ pv: ['e8d7'], eval: cp(-790) }])] },
  habit: { recent: [] },
})

const packetOf = (r: EngineReport): Packet => {
  const b = buildPacket(r)
  if (!b.ok) throw new Error(b.error)
  return b.packet
}

const game = (color: 'white' | 'black', evals: ({ cp?: number; mate?: number } | undefined)[]): Game =>
  ({
    id: 'lichess:g',
    site: 'lichess',
    color,
    moves: evals.map((e, i) => ({ san: `m${i}`, uci: `a${i + 1}a${i + 2}`, eval: e })),
  }) as unknown as Game

describe('lineEvalCp', () => {
  it('reads the stored line eval at the position before ply, player point of view', () => {
    const g = game('white', [{ cp: 30 }, { cp: -20 }, undefined, { mate: 2 }])
    expect(lineEvalCp(g, 1)).toBeUndefined() // the start position is not on the line
    expect(lineEvalCp(g, 2)).toBe(30) // after move 1: moves[0]
    expect(lineEvalCp(g, 3)).toBe(-20)
    expect(lineEvalCp(g, 4)).toBeUndefined() // a book move has no eval
    expect(lineEvalCp(g, 5)).toBe(cpOf({ type: 'mate', value: 2 }))
  })

  it('flips for a black player', () => {
    const g = game('black', [{ cp: 30 }, { mate: -3 }])
    expect(lineEvalCp(g, 2)).toBe(-30)
    expect(lineEvalCp(g, 3)).toBe(-cpOf({ type: 'mate', value: -3 }))
  })
})

describe('reconcileWithLine', () => {
  it('agreement within τ_instab leaves the packet alone', () => {
    const p = packetOf(forkReport())
    expect(p.meta.certification.status).toBe('certified')
    expect(reconcileWithLine(p, 500 - CERT.instabCp)).toBe(p)
    expect(reconcileWithLine(p, undefined)).toBe(p)
  })

  it('a contradiction collapses to the weaker verdict and is recorded', () => {
    const p = packetOf(forkReport())
    const r = reconcileWithLine(p, 200) // the line says +200, the packet claimed +500
    expect(r).not.toBe(p) // the original is untouched
    expect(p.eval.before.value).toBe(500)
    expect(r.eval.before).toMatchObject({ type: 'cp', value: 200, stable: false, range: [200, 500] })
    expect(r.eval.verdict.before).toBe('better')
    expect(r.played!.swing).toMatchObject({ type: 'cp', value: -200 })
    expect(r.meta.certification.status).toBe('partial')
    expect(r.meta.certification.refusals).toContain(LINE_REFUSAL)
    // the narrator only serves certified packets: partial means the floor,
    // which renders the collapsed (weaker) verdict
  })

  it('collapses to the line when the line is the weaker verdict', () => {
    const r = reconcileWithLine(packetOf(forkReport()), -400)
    expect(r.eval.before.value).toBe(-400)
    expect(r.eval.verdict.before).toBe('worse')
    expect(r.meta.certification.refusals).toContain(LINE_REFUSAL)
  })

  it('already-weaker packet values stand; an equal-strength clash goes to the line', () => {
    const mild = reconcileWithLine(packetOf(forkReport({ best: forkReport().best.map(x => ({ ...x, lines: x.lines.map(l => ({ ...l, eval: cp(80) })) })) })), -400)
    expect(mild.eval.before.value).toBe(80) // |80| < |-400|: packet stays
    const tie = reconcileWithLine(packetOf(forkReport()), -500)
    expect(tie.eval.before.value).toBe(-500) // opposite sign, same size: the stored line wins
  })

  it('a certified mate is never touched', () => {
    const p = packetOf(mateReport())
    expect(p.eval.before.type).toBe('mate')
    expect(reconcileWithLine(p, 0)).toBe(p)
    expect(reconcileWithLine(p, -600)).toBe(p)
  })

  it('is idempotent', () => {
    const once = reconcileWithLine(packetOf(forkReport()), 200)
    const twice = reconcileWithLine(once, 200)
    expect(twice.eval.before.value).toBe(200)
    expect(twice.meta.certification.refusals.filter(r => r === LINE_REFUSAL)).toHaveLength(1)
  })
})
