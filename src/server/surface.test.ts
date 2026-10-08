import { describe, expect, it } from 'vitest'
import { escapeNetText, escapeSquares, fromFen } from './facts'
import { templateFloor } from './floor'
import { promptView } from './narrate'
import { buildPacket, packetProblems, type EngineReport, type EngineRun, type Packet } from './packet'
import { renderText } from './render'
import { words } from './readability'
import { costWords, drillGameLine, journalHangParts, thresholdWords } from './surface'
import { validateSlots } from './slots'

// Fixtures (mateNet payload + single-rendering-surface
// audit), pinned:
//
//   bun test src/server/surface.test.ts

const run = (lines: EngineRun['lines'], depth = 24): EngineRun => ({ lines, depth, nodes: 1_000_000, capped: false })
const cp = (value: number) => ({ type: 'cp' as const, value })
const mate = (value: number) => ({ type: 'mate' as const, value })

// Back-rank mate in 1: Qd8#; the black king is hemmed by its own pawns
const backRankFen = '6k1/5ppp/8/8/8/8/8/R2Q2K1 w - - 0 1'
const backRankReport = (over: Partial<EngineReport> = {}): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: backRankFen,
  solution: ['d1d8'],
  holding: ['d1d8'],
  kind: 'hold',
  band: 'club',
  best: [run([{ pv: ['d1d8'], eval: mate(1) }, { pv: ['a1a8'], eval: mate(1) }]), run([{ pv: ['d1d8'], eval: mate(1) }, { pv: ['a1a8'], eval: mate(1) }])],
  played: { uci: 'g1f1', runs: [run([{ pv: ['g8f8'], eval: cp(0) }]), run([{ pv: ['g8f8'], eval: cp(10) }])] },
  habit: { recent: [] },
  ...over,
})

const packetOf = (r: EngineReport): Packet => {
  const b = buildPacket(r)
  if (!b.ok) throw new Error(b.error)
  return b.packet
}

describe('single rendering surface - validated one-liners', () => {
  it('costWords renders a certified swing in words, fail-closed on junk', () => {
    expect(costWords(320)).toBe('three pawns')
    expect(costWords(150)).toBe('a pawn and a half')
    expect(costWords(50)).toBe('a pawn')
    expect(costWords(900)).toBe('a queen or more')
    expect(costWords(350)).toBe('3.5 pawns')
    expect(costWords(0)).toBeUndefined()
    expect(costWords(-120)).toBeUndefined()
    expect(costWords(NaN)).toBeUndefined()
  })

  it('the drill card line and the journal line come from the surface, whole', () => {
    expect(drillGameLine({ san: 'Rb7' }, 320)).toBe(' In the game: Rb7, giving away about three pawns.')
    expect(drillGameLine({ san: 'Rb7' }, 0)).toBeUndefined()
    expect(drillGameLine({}, 320)).toBeUndefined()
    expect(journalHangParts({ san: 'Nxf7', swingCp: 300, ply: 45 })).toEqual(['Gave away about three pawns on move 23 (', 'Nxf7', ').'])
    expect(journalHangParts({ san: 'Nxf7', swingCp: -5, ply: 45 })).toBeUndefined()
    expect(thresholdWords(150)).toBe('a pawn and a half')
  })
})

describe('mateNet - escape-square refutations in the packet', () => {
  it('a mate-in-1 packet enumerates why the king cannot run: covered-by / blocked-by per flight square', () => {
    const p = packetOf(backRankReport())
    expect(p.meta.certification.status).toBe('certified')
    const cert = p.certificates.find(c => c.id === 'c-mate' && c.subject === 'best')
    expect(cert).toBeTruthy()
    const payload = cert!.payload as { mateIn: number; escapeSquares: { square: string; blockedBy?: string; coveredBy?: { role: string; square: string }[] }[]; complete: boolean }
    expect(payload.mateIn).toBe(1)
    expect(payload.complete).toBe(true)
    expect(payload.escapeSquares).toEqual([
      { square: 'f7', blockedBy: 'pawn' },
      { square: 'f8', coveredBy: [{ role: 'queen', square: 'd8' }] },
      { square: 'g7', blockedBy: 'pawn' },
      { square: 'h7', blockedBy: 'pawn' },
      { square: 'h8', coveredBy: [{ role: 'queen', square: 'd8' }] },
    ])
    // The companion certificate is the narratable fact; the anchors close over it
    const net = p.certificates.find(c => c.id === 'c-mate-net')
    expect(net?.text).toBe('The king cannot run: f7, g7 and h7 are blocked by its own pawns; f8 and h8 are covered by the queen on d8')
    expect(p.claimAnchors).toContain('c-mate-net')
    expect(packetProblems(p)).toEqual([])
  })

  it('the floor cites the net when it fits the band budget, drops it when it does not', () => {
    const net = (q: Packet) => q.certificates.find(c => c.id === 'c-mate-net')!.text
    const total = (q: Packet) => words(Object.values(renderText(templateFloor(q), q)).join(' ')).length
    // A lean mate packet: the clause fits club and up (94 of 110), but not
    // Beginner (85 of 80) - the budget is the hard contract, so Beginner
    // floors drop the supplementary clause
    const lean = packetOf(backRankReport({ played: undefined }))
    const budgets = { beginner: 80, club: 110, advanced: 150 } as const
    for (const band of ['beginner', 'club', 'advanced'] as const) {
      const q = { ...lean, context: { ...lean.context, band } }
      const why = renderText(templateFloor(q), q).why
      if (band === 'beginner') expect(why).not.toContain('The king cannot run')
      else expect(why, band).toContain(net(q))
      expect(total(q), band).toBeLessThanOrEqual(budgets[band])
    }
    // A heavy packet (game move + punishment post-mortem): any floor that
    // would overflow drops the clause instead - at every band
    const heavy = packetOf(backRankReport())
    for (const band of ['beginner', 'club', 'advanced'] as const) {
      const q = { ...heavy, context: { ...heavy.context, band } }
      expect(total(q), band).toBeLessThanOrEqual(budgets[band])
      const nonReadability = validateSlots({ slots: templateFloor(q) }, q).violations.filter(v => !/^readability/.test(v))
      expect(nonReadability, band).toEqual([])
    }
  })

  it('the narrator sees the net as a concrete fact it can cite', () => {
    const p = packetOf(backRankReport())
    const fact = promptView(p).facts.find(f => f.id === 'c-mate-net')
    expect(fact?.means).toContain('The king cannot run')
    expect(fact?.means).toContain('covered by the queen on d8')
  })

  it('a mating line that leaves a flight square never certifies (fail closed)', () => {
    // The engine claims mate(1), but without the black pawns Qd8+ is not
    // mate. The PV replays without a mate flag, so the claim never enters
    // the packet - and the definition test itself names the open squares.
    const p = packetOf(backRankReport({ fen: '6k1/8/8/8/8/8/8/R2Q2K1 w - - 0 1' }))
    expect(p.certificates.some(c => c.id === 'c-mate')).toBe(false)
    expect(p.certificates.some(c => c.id === 'c-mate-net')).toBe(false)
    expect(p.best.pv.every(m => !m.mate)).toBe(true)
    const terminal = fromFen(p.best.pv[0].fenAfter)!
    const net = escapeSquares(terminal, 'black')
    expect(net.complete).toBe(false)
    expect(net.squares.filter(e => !e.blockedBy && !e.coveredBy?.length).map(e => e.square)).toEqual(['f7', 'g7', 'h7'])
  })

  it('the validator catches a tampered net: open squares and completeness lies', () => {
    const p = packetOf(backRankReport())
    const tampered = structuredClone(p)
    const payload = tampered.certificates.find(c => c.id === 'c-mate')!.payload as { escapeSquares: unknown[]; complete: boolean }
    payload.escapeSquares = [{ square: 'e4' }]
    expect(packetProblems(tampered).join()).toMatch(/neither blocked nor covered/)
    const incomplete = structuredClone(p)
    ;(incomplete.certificates.find(c => c.id === 'c-mate')!.payload as { complete: boolean }).complete = false
    expect(packetProblems(incomplete).join()).toMatch(/incomplete escape net/)
  })

  it('escapeSquares groups nothing it cannot prove; escapeNetText is composed once', () => {
    // Legal's mate terminal (Bxf7+ Ke7 7. Nd5#): every one of the eight king
    // neighbours is refuted, and the wording groups shared blockers and covers
    const pos = fromFen('rn1q1bnr/ppp1kBp1/3p3p/3NN3/4P3/8/PPPP1PPP/R1BbK2R b KQ - 2 7')!
    const net = escapeSquares(pos, 'black')
    expect(net.complete).toBe(true)
    expect(net.squares).toHaveLength(8)
    const text = escapeNetText(net)
    expect(text.startsWith('The king cannot run: ')).toBe(true)
    expect(text).not.toContain(' is open')
  })
})
