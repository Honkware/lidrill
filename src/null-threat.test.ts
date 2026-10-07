// @vitest-environment node
// Null-threat tests: `certifiedNull` decisions validated
// on a labeled quiet-vs-hidden-threat set, engine-only - no LLM spend. A
// false certifiedNull on a hidden-threat fixture is a release blocker.
//
// Each fixture is certified exactly the way the browser certifies a puzzle
// (one d24 search per position, the null-move threat at MultiPV 3), built
// into a packet by packet.ts, and then checked:
//   quiet         → never a certified threat (no invention); a certifiedNull
//                   must show in threat-free text ("no forcing reply" and no
//                   threat claim anywhere), a refusal must swear nothing
//   hidden-threat → threatStatus must be certified: a certifiedNull here is
//                   the release-blocking false negative
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { Engine, type UciEngine } from './analysis/engine'
import { templateFloor } from './server/floor'
import { buildPacket, CERT, nullMoveFen, type EngineReport, type Packet } from './server/packet'
import { renderText } from './server/render'
import { validateSlots } from './server/slots'

const require = createRequire(import.meta.url)

type Label = 'quiet' | 'threat' | 'edge'
// edge = a real threat below the band floor τ_threat: the packet must fail
// closed (uncertified, never certifiedNull) - and may certify on a deeper run
const FIXTURES: { name: string; fen: string; label: Label; why: string }[] = [
  // --- quiet: nothing for the opponent even with a free move ----------------
  { name: 'rook ending, passive', fen: '4k3/8/8/8/8/8/R7/4K3 w - - 0 1', label: 'quiet', why: 'K+R vs K+R, both kings passive' },
  { name: 'queen ending, passive', fen: '4k3/8/8/8/8/8/Q7/4K3 w - - 0 1', label: 'quiet', why: 'Q vs Q, far apart' },
  { name: 'bishop and knight, frozen', fen: '1n2k3/8/8/8/8/8/8/2B1K3 w - - 0 1', label: 'quiet', why: 'the lone knight has no path to anything' },
  // --- hidden threat: looks quiet, the null move unmasks a hammer ----------
  { name: 'back-rank mate', fen: 'r5k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', label: 'threat', why: '…Ra1+ wins: the king blocks its own rook, then the pawns fall' },
  { name: 'back-rank mate in one', fen: 'r5k1/5ppp/8/8/8/8/5PPP/6KR w - - 0 1', label: 'threat', why: '…Ra1# - the king on g1 blocks its own rook on h1' },
  { name: 'rook lift mate net', fen: '2q3k1/5ppp/8/8/8/8/8/7K w - - 0 1', label: 'threat', why: '…Qc1+ starts a mate the bare king cannot escape' },
  { name: 'queen takes the loose rook', fen: '4k3/8/8/8/8/7K/r4q2/8 w - - 0 1', label: 'threat', why: 'white is mated in 3 - a certifiedNull here was the false negative' },
  { name: 'promotion', fen: '4k3/8/8/8/8/8/2p5/4K3 w - - 0 1', label: 'threat', why: '…c1=Q+ decides on the spot' },
  // --- edge: a real threat below the band floor ----------------------------
  { name: 'king march', fen: '4k3/8/1p6/p7/P7/1P6/8/3NK3 w - - 0 1', label: 'edge', why: '…Ke7-d6-c5 picks up pawns for about 120 cp, under the 150 floor' },
]

const NODES = 6_000_000

let packets: { fixture: (typeof FIXTURES)[number]; packet: Packet }[]

beforeAll(async () => {
  const sf = await require('stockfish')('lite-single')
  const uci: UciEngine = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
  const engine = new Engine(uci)
  packets = []
  for (const fixture of FIXTURES) {
    const certify = (fen: string, multipv: number) => engine.certify(fen, { depth: CERT.depth, nodes: NODES, multipv, clearHash: true })
    const best = await certify(fixture.fen, CERT.multipv)
    const nullFen = nullMoveFen(fixture.fen)
    const threat = nullFen ? [await certify(nullFen, CERT.threatMultipv)] : undefined
    const report: EngineReport = {
      schema: 'lidrill-report/1',
      fen: fixture.fen,
      solution: [best.lines[0].pv[0]],
      kind: 'missed-win',
      band: 'club',
      best: [best],
      threat,
      habit: { recent: [] },
    }
    const built = buildPacket(report)
    if (!built.ok) throw new Error(`${fixture.name}: ${built.error}`)
    packets.push({ fixture, packet: built.packet })
  }
  sf.terminate?.()
}, 300_000)

describe('null-threat tests', () => {
  it('runs the full labeled set', () => {
    expect(packets.length).toBe(FIXTURES.length)
  })

  const of = (name: string) => packets.find(p => p.fixture.name === name)!

  it.each(FIXTURES.filter(f => f.label === 'quiet').map(f => [f.name] as const))('quiet: %s refuses or speaks threat-free', name => {
    const { packet: p } = of(name)
    // The engine-only refusal: no threat is ever invented on a quiet
    // position
    expect(p.threatStatus).not.toBe('certified')
    expect(p.threat).toBeUndefined()
    expect(p.claimAnchors).not.toContain('threat')
    const floor = templateFloor(p)
    const text = renderText(floor, p)
    if (p.threatStatus === 'certifiedNull') {
      // Certified quiet: the packet says so, and the text a player can see
      // is threat-free - the floor passes every check and its why slot
      // states the absence, never a threat
      expect(p.certificates.some(c => c.id === 'c-nothreat')).toBe(true)
      expect(p.didactic.requiredRefs.why.join('|')).toContain('c-nothreat')
      expect(validateSlots({ slots: floor }, p).violations.filter(v => !/^readability/.test(v))).toEqual([])
      expect(text.why).toMatch(/no forcing reply/)
    } else {
      // Refused (dead-equal positions can flap across the stability check):
      // fail closed - the packet must not swear "no forcing reply" either
      expect(p.certificates.some(c => c.id === 'c-nothreat')).toBe(false)
      expect(text.why).not.toMatch(/no forcing reply/)
    }
    for (const slot of Object.values(text)) expect(slot).not.toMatch(/threaten/i)
  })

  it.each(FIXTURES.filter(f => f.label === 'threat').map(f => [f.name] as const))('hidden threat: %s must never certify null', name => {
    const { packet: p } = of(name)
    // A certifiedNull here is the release-blocking false negative
    expect(p.threatStatus).toBe('certified')
    expect(p.threat).toBeDefined()
    expect(p.threat!.side).not.toBe(p.position.playerColor === 'white' ? 'w' : 'b')
    // The why slot must carry the threat - except when the answer is a
    // direct mate: ends the explanation at the move there, so the
    // threat requirement is dropped (the threat itself stays certified)
    if (p.best.mateIn === 1) expect(p.didactic.requiredRefs.why).toEqual([])
    else expect(p.didactic.requiredRefs.why.join('|')).toContain('threat')
    // The floor must not null the threat away either
    const text = renderText(templateFloor(p), p)
    expect(text.why).toMatch(/threatened/)
    expect(text.why).not.toMatch(/no forcing reply/)
    // …and a draft that claims NO_THREAT against this packet is refused
    const lying = templateFloor(p).map(s => (s.slot === 'why' ? { slot: s.slot, text: 'They had NO_THREAT.', refs: ['c-nothreat'] } : s))
    expect(validateSlots({ slots: lying }, p).ok).toBe(false)
  })

  it.each(FIXTURES.filter(f => f.label === 'edge').map(f => [f.name] as const))('edge: %s fails closed, never null', name => {
    const { packet: p } = of(name)
    // Below the floor the packet may not swear "no forcing reply"
    expect(p.threatStatus).not.toBe('certifiedNull')
    expect(['uncertified', 'certified']).toContain(p.threatStatus)
    if (p.threatStatus === 'uncertified') {
      expect(renderText(templateFloor(p), p).why).not.toMatch(/no forcing reply/)
      expect(p.certificates.some(c => c.id === 'c-nothreat')).toBe(false)
    }
  })
})
