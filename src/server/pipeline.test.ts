import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { templateFloor } from './floor'
import { BUDGET_USD, MODELS, narrate, promptView, prune, SMOOTH_MODEL, type Caller, type LlmCall } from './narrate'
import { buildPacket, dedupeKey, nullMoveFen, packetHash, packetProblems, stampTier, validPacket, validReport, type Certificate, type EngineReport, type EngineRun, type Packet } from './packet'
import { renderSlot, renderText, type Slot } from './render'
import { validateSlots } from './slots'

const run = (lines: EngineRun['lines'], depth = 24): EngineRun => ({ lines, depth, nodes: 1_000_000, capped: false })
const cp = (value: number) => ({ type: 'cp' as const, value })
const mate = (value: number) => ({ type: 'mate' as const, value })

// Legal's mate: 6. Bxf7+ Ke7 7. Nd5#; the game went Kxd1?? instead
const legalFen = 'rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6'
const legalReport = (over: Partial<EngineReport> = {}): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: legalFen,
  solution: ['c4f7', 'e8e7', 'c3d5'],
  kind: 'missed-win',
  band: 'club',
  best: [run([{ pv: ['c4f7', 'e8e7', 'c3d5'], eval: mate(2) }, { pv: ['e1d1', 'd6e5'], eval: cp(-150) }]), run([{ pv: ['c4f7', 'e8e7', 'c3d5'], eval: mate(2) }, { pv: ['e1d1', 'd6e5'], eval: cp(-140) }])],
  threat: [run([{ pv: ['d6e5'], eval: cp(9990) }]), run([{ pv: ['d6e5'], eval: cp(9990) }])],
  played: { uci: 'e1d1', runs: [run([{ pv: ['d6e5', 'd2d3'], eval: cp(150) }]), run([{ pv: ['d6e5', 'd2d3'], eval: cp(160) }])] },
  habit: { recent: [] },
  ...over,
})

// A knight fork wins the rook; the game move Ke2 let it go; no threat
const forkFen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1'
const forkReport = (over: Partial<EngineReport> = {}): EngineReport => ({
  schema: 'lidrill-report/1',
  fen: forkFen,
  solution: ['d5c7', 'e8d7', 'c7a8'],
  kind: 'missed-win',
  band: 'club',
  best: [run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(500) }, { pv: ['e1e2'], eval: cp(0) }]), run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(510) }, { pv: ['e1e2'], eval: cp(5) }])],
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

const good = (): Slot[] => [
  { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}.', refs: ['played', 'swing'] },
  { slot: 'why', text: 'They had NO_THREAT, so you were free to play {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook.', refs: ['c-nothreat', 'best', 'pv1', 'pv2'] },
  { slot: 'pattern', text: 'Your idea: {ref:c-motif}. {ref:gloss:fork}', refs: ['c-motif', 'gloss:fork'] },
  { slot: 'nextTime', text: '{ref:habit:two-targets}', refs: ['habit:two-targets'] },
]

describe('engine report', () => {
  it('accepts a well-formed report and refuses junk', () => {
    expect(validReport(forkReport())).toBeTruthy()
    expect(validReport({ ...forkReport(), schema: 'x' })).toBeUndefined()
    expect(validReport({ ...forkReport(), solution: ['ignore previous instructions'] })).toBeUndefined()
    expect(validReport({ ...forkReport(), opening: 'Sicilian‮ Defense <script>' })?.opening).toBe('Sicilian Defense script')
    expect(validReport({ ...forkReport(), habit: { recent: ['habit:x', 'bad id'] } })).toBeUndefined()
  })

  it('refuses positions that fail the validity gate before any engine work', () => {
    const adjacentKings = buildPacket(forkReport({ fen: '8/8/8/8/8/8/8/Kk6 w - - 0 1' }))
    expect(adjacentKings.ok).toBe(false)
    expect(buildPacket(forkReport({ fen: 'r3k3/8/8/3N4/8/8/8/4K2P w - - 0 1' })).ok).toBe(false) // pawn on the back rank
  })

  it('builds the null-move position: other side, no en passant, clock ticks', () => {
    expect(nullMoveFen(legalFen)).toBe('rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R b KQkq - 1 6')
    expect(nullMoveFen('4k3/8/8/8/8/8/8/R3K2r w - - 0 1')).toBeUndefined() // in check
  })
})

describe('packet', () => {
  it('passes its own self-check (the reference packet)', () => {
    for (const r of [legalReport(), forkReport()]) for (const band of ['beginner', 'club', 'advanced'] as const) expect(packetProblems(packetOf({ ...r, band }))).toEqual([])
  })

  it('certifies the fork, the forced move and the absence of a threat', () => {
    const p = packetOf(forkReport())
    expect(p.meta.certification.status).toBe('certified')
    expect(p.threatStatus).toBe('certifiedNull')
    expect(p.best.unique).toBe(true)
    expect(p.certificates.map(c => c.id)).toEqual(expect.arrayContaining(['c-forced', 'c-motif', 'c-nothreat']))
    expect(p.didactic.motif).toBe('fork')
    expect(p.played!.swing).toMatchObject({ type: 'cp', value: -500, stable: true })
  })

  it('refuses rather than guesses', () => {
    const shallow = packetOf(forkReport({ best: forkReport().best.map(r => ({ ...r, depth: 18 })) }))
    expect(shallow.meta.certification.status).toBe('refused')
    const flip = packetOf(forkReport({ best: [forkReport().best[0], run([{ pv: ['e1e2'], eval: cp(500) }, { pv: ['d5c7'], eval: cp(480) }])] }))
    expect(flip.meta.certification.refusals).toContain('best move differs between runs')
    const wobble = packetOf(forkReport({ best: [forkReport().best[0], run([{ pv: ['d5c7', 'e8d7', 'c7a8'], eval: cp(400) }, { pv: ['e1e2'], eval: cp(0) }])] }))
    expect(wobble.meta.certification.refusals.join()).toMatch(/range/)
    // One run: the second opinion is the same search two iterations earlier
    const one = forkReport().best[0]
    expect(packetOf(forkReport({ best: [{ ...one, check: { depth: 22, pv: one.lines[0].pv, eval: cp(490) } }] })).meta.certification.status).toBe('certified')
    expect(packetOf(forkReport({ best: [{ ...one, check: { depth: 22, pv: ['e1e2'], eval: cp(490) } }] })).meta.certification.refusals).toContain('best move differs between runs')
    expect(packetOf(forkReport({ best: [{ ...one, check: { depth: 22, pv: one.lines[0].pv, eval: cp(300) } }] })).meta.certification.refusals.join()).toMatch(/range/)
    expect(packetOf(forkReport({ best: [one] })).meta.certification.refusals).toContain('no second opinion')
    // Stopped by the time budget short of depth 24 is fine; below 22 is not
    expect(packetOf(forkReport({ best: forkReport().best.map(r => ({ ...r, depth: 22, capped: true })) })).meta.certification.status).toBe('certified')
    const close = packetOf(forkReport({ best: forkReport().best.map(r => ({ ...r, lines: [r.lines[0], { pv: ['e1e2'], eval: cp(450) }] })) }))
    expect(close.best.unique).toBe(false)
    expect(close.certificates.some(c => c.id === 'c-forced')).toBe(false)
  })

  it('a threat needs the band floor in both runs; a medium one stays uncertified', () => {
    const medium = packetOf(forkReport({ threat: [run([{ pv: ['a8a1'], eval: cp(-400) }]), run([{ pv: ['a8a1'], eval: cp(-400) }])] }))
    expect(medium.threatStatus).toBe('uncertified')
  })

  it('certifies that the answer stops the threat only when it does', () => {
    // Bxf7+ checks: dxe5 is no longer legal, so the threat is stopped
    expect(packetOf(legalReport()).certificates.find(c => c.id === 'c-stops')?.text).toBe('Bxf7+ stops dxe5')
    // Nothing to stop when there's no threat
    expect(packetOf(forkReport()).certificates.some(c => c.id === 'c-stops')).toBe(false)
  })

  it('names a missed mate as a mate, never as pawns', () => {
    const p = packetOf(legalReport())
    expect(p.played!.swing).toMatchObject({ type: 'mate', value: 2 })
    expect(renderText(templateFloor(p), p).whatHappened).toBe('In the game, Kxd1 cost you a mate in 2.')
  })

  it('dead draws carry no concepts and no threat', () => {
    const p = packetOf(forkReport({ fen: '4k3/8/8/8/8/8/8/3NK3 w - - 0 1', solution: ['d1e3'], best: [run([{ pv: ['d1e3'], eval: cp(0) }]), run([{ pv: ['d1e3'], eval: cp(0) }])], played: undefined }))
    expect(p.position.drawRule).toBe('dead-draw')
    expect(p.concepts).toEqual([])
    expect(p.threatStatus).toBe('certifiedNull')
    expect(p.eval.verdict.before).toBe('dead-draw')
  })

  it('a threefold repetition in the game history refuses the verdict', () => {
    const p = packetOf(forkReport({ history: [forkFen, 'x', forkFen] }))
    expect(p.position.gameState.canClaimThreefold).toBe(true)
    expect(p.meta.certification.refusals).toContain('a draw can be claimed')
  })

  it('hashes inputs and config only: the same puzzle hashes the same whatever the evals', async () => {
    const a = await packetHash({ fen: forkFen, solution: ['d5c7'], band: 'club' })
    const b = await packetHash({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', solution: ['d5c7'], band: 'club' })
    expect(a).toBe(b)
    expect(a).not.toBe(await packetHash({ fen: forkFen, solution: ['d5c7'], band: 'advanced' }))
    expect(dedupeKey({ fen: forkFen, occurrenceCount: 1, band: 'club', kind: 'missed-win' })).toContain('|club|missed-win|w')
  })

  it('carries and stamps the certification tier', async () => {
    const p = packetOf(forkReport())
    // Built from a browser report: client-lite by default
    expect(p.meta.certification.tier).toBe('client-lite')
    expect(p.meta.certification.policyVersion).toBe('cert/1.0')
    stampTier(p, 'server')
    expect(p.meta.certification.tier).toBe('server')
    expect(p.meta.certification.policyVersion).toBe('cert/1.0-server')
    p.meta.packetHash = await packetHash({ fen: forkFen, solution: ['d5c7'], band: 'club' })
    const roundTrip = JSON.parse(JSON.stringify(p)) as Packet
    expect(validPacket(roundTrip)).toBeTruthy()
    // The tier is required on stored packets; a packet without one is a miss
    delete (roundTrip.meta.certification as { tier?: string }).tier
    expect(validPacket(roundTrip)).toBeUndefined()
    expect(validPacket({ ...roundTrip, schema: 'lidrill-packet/0.0' })).toBeUndefined()
    expect(validPacket({ ...roundTrip, context: { band: 'grandmaster' } })).toBeUndefined()
  })
})

describe('renderer', () => {
  it('turns ids into moves with board links and library text', () => {
    const p = packetOf(forkReport())
    const segs = renderSlot(good()[1], p)
    expect(segs.map(s => s.text).join('')).toBe('They had no forcing reply, so you were free to play Nc7+. After Kd7, Nxa8 takes the rook.')
    expect(segs.find(s => s.ref === 'pv2')!.link).toMatchObject({ from: 'c7', to: 'a8' })
    expect(renderText(good(), p).pattern).toMatch(/^Your idea: Nc7\+ attacks the rook on a8 and the king on e8 at once\. A fork is/)
  })
})

describe('validator', () => {
  const p = packetOf(forkReport())
  const pc = (band: Packet['context']['band']) => packetOf(forkReport({ band }))
  const withThreat = packetOf(legalReport())
  const hold = packetOf(forkReport({ best: forkReport().best.map(r => ({ ...r, lines: [r.lines[0], { pv: ['e1e2'], eval: cp(480) }] })), holding: ['d5c7', 'e1e2'], kind: 'hold' }))
  const edit = (slot: number, text: string, refs?: string[]): Slot[] => good().map((s, i) => (i === slot ? { ...s, text, refs: refs ?? s.refs } : s))

  it('accepts a good draft', () => {
    expect(validateSlots({ slots: good() }, p)).toMatchObject({ ok: true, violations: [] })
  })

  it('the floor meets the required sets at every band, for every fixture', () => {
    for (const r of [legalReport(), forkReport()])
      for (const band of ['beginner', 'club', 'advanced'] as const) {
        const q = packetOf({ ...r, band })
        expect(validateSlots({ slots: templateFloor(q) }, q).violations.filter(x => !/^readability/.test(x))).toEqual([])
      }
  })

  // The seeded hostile drafts: every one must be caught
  const hostile: [string, Slot[] | unknown, Packet?][] = [
    ['raw SAN', edit(0, 'You played Ke2 and it cost {ref:swing}.', ['swing'])],
    ['raw square', edit(1, 'They had NO_THREAT, so {ref:best} hit the rook on a8. After {ref:pv1}, {ref:pv2} takes it.')],
    ['UCI move', edit(0, 'You played e1e2 and it cost {ref:swing}.', ['swing'])],
    ['castling with zeros', edit(0, 'You played 0-0 and it cost {ref:swing}.', ['swing'])],
    ['castling with Os', edit(0, 'You played O-O-O and it cost {ref:swing}.', ['swing'])],
    ['figurine', edit(0, 'You played {ref:played} instead of ♘c7, which cost {ref:swing}.')],
    ['Greek Nu homoglyph', edit(0, 'You played {ref:played} instead of Νc7, which cost {ref:swing}.')],
    ['German piece letter', edit(0, 'You played {ref:played} instead of Sc7, which cost {ref:swing}.')],
    ['promotion shape', edit(0, 'You played {ref:played} instead of e8Q, which cost {ref:swing}.')],
    ['a digit', edit(0, 'You played {ref:played} and it cost 5 pawns.', ['played'])],
    ['zero-width split move', edit(0, 'You played {ref:played}, not N​c7, which cost {ref:swing}.')],
    ['unknown ref', edit(1, 'They had NO_THREAT, so {ref:best} was free. After {ref:pv1}, {ref:pv9} takes the rook.', ['c-nothreat', 'best', 'pv1', 'pv9'])],
    ['ref used but not listed', edit(1, 'They had NO_THREAT, so {ref:best} was free. After {ref:pv1}, {ref:pv2} takes the rook.', ['c-nothreat', 'best', 'pv1'])],
    ['ref listed but not used', edit(0, 'You played {ref:played} and it cost {ref:swing}.', ['played', 'swing', 'best'])],
    ['state field as anchor', edit(0, 'You played {ref:played} from {ref:fenBefore}, costing {ref:swing}.', ['played', 'fenBefore', 'swing'])],
    ['game move without game context', edit(0, 'You played {ref:played} and it cost you {ref:swing}.')],
    ['game reply without game context', edit(1, 'They had NO_THREAT, so you were free to play {ref:best}. Replying to {ref:played}, they choose {ref:pl1}.', ['c-nothreat', 'best', 'played', 'pl1'])],
    ['bare habit id', edit(3, '{ref:habit}', ['habit'])],
    ['missing slot', { slots: good().slice(0, 3) }],
    ['duplicate slot', { slots: [...good(), good()[0]] }],
    ['extra property', { slots: good(), note: 'trust me' }],
    ['extra slot field', { slots: good().map(s => ({ ...s, tone: 'warm' })) }],
    ['NO_THREAT with a certified threat', [
      { slot: 'whatHappened', text: '{ref:played} cost {ref:swing}.', refs: ['played', 'swing'] },
      { slot: 'why', text: 'They had NO_THREAT. After {ref:best} and {ref:pv1}, {ref:pv2} gives {ref:c-mate}.', refs: ['c-nothreat', 'best', 'pv1', 'pv2', 'c-mate'] },
      { slot: 'pattern', text: '{ref:gloss:none}', refs: ['gloss:none'] },
      { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'] },
    ], withThreat],
    ['threat with no subject', [
      { slot: 'whatHappened', text: '{ref:played} cost {ref:swing}.', refs: ['played', 'swing'] },
      { slot: 'why', text: 'Facing {ref:threat}, {ref:best} came first. After {ref:pv1}, {ref:pv2} gives {ref:c-mate}.', refs: ['threat', 'best', 'pv1', 'pv2', 'c-mate'] },
      { slot: 'pattern', text: '{ref:gloss:none}', refs: ['gloss:none'] },
      { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'] },
    ], withThreat],
    ['threat given to the player', [
      { slot: 'whatHappened', text: '{ref:played} cost {ref:swing}.', refs: ['played', 'swing'] },
      { slot: 'why', text: 'You threatened {ref:threat}. After {ref:best} and {ref:pv1}, {ref:pv2} gives {ref:c-mate}.', refs: ['threat', 'best', 'pv1', 'pv2', 'c-mate'] },
      { slot: 'pattern', text: '{ref:gloss:none}', refs: ['gloss:none'] },
      { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'] },
    ], withThreat],
    ['pattern given to the opponent', edit(2, 'They found it: {ref:c-motif}. {ref:gloss:fork}')],
    ['"forced" without certificate', [
      { slot: 'whatHappened', text: 'You played {ref:played} and it cost {ref:swing}.', refs: ['played', 'swing'] },
      { slot: 'why', text: 'They had NO_THREAT, so {ref:best} was forced. After {ref:pv1}, {ref:pv2} takes the rook.', refs: ['c-nothreat', 'best', 'pv1', 'pv2'] },
      { slot: 'pattern', text: 'Your idea: {ref:c-motif}. {ref:gloss:fork}', refs: ['c-motif', 'gloss:fork'] },
      { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'] },
    ], hold],
    ['mate that is not there', edit(1, 'They had NO_THREAT, so {ref:best} leads to mate. After {ref:pv1}, {ref:pv2} takes the rook.')],
    ['uncertified pattern name', edit(1, 'They had NO_THREAT, so {ref:best} pins the king. After {ref:pv1}, {ref:pv2} takes the rook.')],
    ['undetectable pattern name', edit(1, 'They had NO_THREAT, so {ref:best} is a deflection. After {ref:pv1}, {ref:pv2} takes the rook.')],
    ['x-ray', edit(1, 'They had NO_THREAT, so {ref:best} works by x-ray. After {ref:pv1}, {ref:pv2} takes the rook.')],
    ['pattern slot on another fact', edit(2, 'Your idea: {ref:c-forced}. {ref:gloss:fork}', ['c-forced', 'gloss:fork'])],
    ['no habit', edit(3, 'Look before you move.', [])],
    ['whatHappened without the cost', edit(0, 'You played {ref:played}.', ['played'])],
    ['why without the threat status', edit(1, 'After {ref:best} and {ref:pv1}, {ref:pv2} takes the rook.', ['best', 'pv1', 'pv2'])],
    ['too few mechanism steps', edit(1, 'They had NO_THREAT, so you could play {ref:best}.', ['c-nothreat', 'best'])],
    ['why repeats what happened', edit(1, 'They had NO_THREAT. You played {ref:played} and it cost {ref:swing}.', ['c-nothreat', 'played', 'swing'])],
    ['dangling anaphora', edit(1, 'They had NO_THREAT. It was the moment for {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook.')],
    ['condescension at advanced', edit(1, 'They had NO_THREAT, so you could simply play {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook. Also {ref:alt1} was worse.', ['c-nothreat', 'best', 'pv1', 'pv2', 'alt1']), pc('advanced')],
    ['discouraging at beginner', edit(0, 'You played {ref:played}, a terrible move, and lost {ref:swing}.'), pc('beginner')],
    ['exclamation at club', edit(0, 'You played {ref:played} and it cost {ref:swing}!')],
    ['rhetorical worth question', edit(0, 'Why would anyone play {ref:played}? It cost {ref:swing}.')],
    ['too long for a beginner', edit(0, 'You played {ref:played} without considering the consequences of leaving everything unprotected and undefended, which ultimately cost {ref:swing}.'), pc('beginner')],
    ['loanword at club', edit(1, 'They had NO_THREAT, so {ref:best} created zugzwang. After {ref:pv1}, {ref:pv2} takes the rook.')],
    ['off-label praise', edit(0, 'You played {ref:played}, not the brilliant move, and it cost {ref:swing}.')],
    ['empty slot', edit(3, '', [])],
    ['"stops" the threat without the certificate', edit(1, 'They had NO_THREAT, so {ref:best} stops nothing yet. After {ref:pv1}, {ref:pv2} takes the rook.')],
    ['"needed" without the forced certificate', [
      { slot: 'whatHappened', text: 'You played {ref:played} and it cost {ref:swing}.', refs: ['played', 'swing'] },
      { slot: 'why', text: 'They had NO_THREAT, so you needed {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook.', refs: ['c-nothreat', 'best', 'pv1', 'pv2'] },
      { slot: 'pattern', text: 'Your idea: {ref:c-motif}. {ref:gloss:fork}', refs: ['c-motif', 'gloss:fork'] },
      { slot: 'nextTime', text: '{ref:habit:cct-scan}', refs: ['habit:cct-scan'] },
    ], hold],
    ['bad ref charset', edit(0, 'You played {ref:PV1} and it cost {ref:swing}.', ['swing'])],
    ['not JSON slots at all', 'You played Ke2 and it cost a rook.'],
  ]
  it.each(hostile)('catches: %s', (_, draft, packet) => {
    const out = Array.isArray(draft) ? { slots: draft } : draft
    expect(validateSlots(out, packet ?? p).ok).toBe(false)
  })

  it('the suite is at least 41 drafts', () => expect(hostile.length).toBeGreaterThanOrEqual(41))
})

// The owner's explanation-context complaints, as fixtures (2026-10-07):
// game vs puzzle framing, tried-move awareness, and habit gating
describe('explanation context', () => {
  // The player's first wrong try in the puzzle: Ne3, while the game went Ke2
  const triedReport = () =>
    forkReport({ tried: { uci: 'd5e3', runs: [run([{ pv: ['a8a2'], eval: cp(0) }]), run([{ pv: ['a8a2'], eval: cp(10) }])] } })

  it('a recorded try leads whatHappened; the original game move is not its subject', () => {
    const p = packetOf(triedReport())
    expect(p.tried?.san).toBe('Ne3')
    expect(p.didactic.requiredRefs.whatHappened).toEqual(['tried', 'tryswing'])
    expect(p.claimAnchors).toContain('tryswing')
    const text = renderText(templateFloor(p), p)
    expect(text.whatHappened).toBe('You tried Ne3 and it cost you 5.0 pawns.')
    expect(text.whatHappened).not.toContain('Ke2')
    expect(validateSlots({ slots: templateFloor(p) }, p).violations.filter(x => !/^readability/.test(x))).toEqual([])
  })

  it('a draft about the try passes; the same draft lecturing the game move fails', () => {
    const p = packetOf(triedReport())
    const draft: Slot[] = [
      { slot: 'whatHappened', text: 'You tried {ref:tried} and it cost you {ref:tryswing}.', refs: ['tried', 'tryswing'] },
      good()[1],
      good()[2],
      { slot: 'nextTime', text: '{ref:habit:two-targets}', refs: ['habit:two-targets'] },
    ]
    expect(validateSlots({ slots: draft }, p)).toMatchObject({ ok: true, violations: [] })
    const lecturing = draft.map(s => (s.slot === 'whatHappened' ? { ...s, text: 'You played {ref:played} and it cost you {ref:swing}.', refs: ['played', 'swing'] } : s))
    const verdict = validateSlots({ slots: lecturing }, p)
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join()).toMatch(/original game/)
  })

  it('game-line facts must be marked as game context in the same sentence', () => {
    const p = packetOf(forkReport())
    const what = (text: string, refs: string[]): Slot[] => [{ slot: 'whatHappened', text, refs }, good()[1], good()[2], good()[3]]
    // Without the marker the puzzle reads as if the game move happened here
    expect(validateSlots({ slots: what('You played {ref:played} and it cost you {ref:swing}.', ['played', 'swing']) }, p).violations.join()).toMatch(/original game/)
    // With it, the same fact is fine
    expect(validateSlots({ slots: what('In the game, {ref:played} cost you {ref:swing}.', ['played', 'swing']) }, p)).toMatchObject({ ok: true, violations: [] })
    // The game's reply line is game context too, and the marker must sit in its own sentence
    const whyNoMark = good().map(s =>
      s.slot === 'why' ? { ...s, text: 'They had NO_THREAT, so you were free to play {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook. Replying to {ref:played}, they choose {ref:pl1}.', refs: ['c-nothreat', 'best', 'pv1', 'pv2', 'played', 'pl1'] } : s,
    )
    expect(validateSlots({ slots: whyNoMark }, p).violations.join()).toMatch(/original game/)
    const whyMark = good().map(s =>
      s.slot === 'why' ? { ...s, text: 'They had NO_THREAT, so you were free to play {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook. In the game, {ref:played} is answered by {ref:pl1}.', refs: ['c-nothreat', 'best', 'pv1', 'pv2', 'played', 'pl1'] } : s,
    )
    expect(validateSlots({ slots: whyMark }, p)).toMatchObject({ ok: true, violations: [] })
  })

  it('the prompt view tags each fact with its frame and names the whatHappened subject', () => {
    const p = packetOf(triedReport())
    const view = promptView(p)
    const frame = (id: string) => view.facts.find(f => f.id === id)?.frame
    expect(frame('played')).toBe('game')
    expect(frame('swing')).toBe('game')
    expect(frame('tried')).toBe('puzzle')
    expect(frame('tryswing')).toBe('puzzle')
    expect(frame('best')).toBe('puzzle')
    expect(view.whatHappened).toMatch(/tried/)
    expect(view.nextTime).toMatch(/^the habit fact$/)
  })

  it('habits are gated to the packet\'s certified concepts; the weekly focus only when it fits', () => {
    // The fork is certified for this position: the fork habit beats generic advice
    expect(packetOf(forkReport()).didactic.habitSlotId).toBe('habit:two-targets')
    // A weekly focus about boxed kings does not override a fork puzzle
    expect(packetOf(forkReport({ habit: { weeklyFocus: 'habit:king-boxed', recent: [] } })).didactic.habitSlotId).toBe('habit:two-targets')
    // A cross-family focus is ignored as before
    expect(packetOf(forkReport({ habit: { weeklyFocus: 'habit:blunder-check', recent: [] } })).didactic.habitSlotId).toBe('habit:two-targets')
  })

  it('no relevant habit: shorter explanation, no generic tip', () => {
    const p = packetOf(forkReport())
    // Simulate the fail-closed build: nothing in the pool fits this packet
    p.didactic.habitSlotId = null
    p.didactic.requiredRefs = { ...p.didactic.requiredRefs, nextTime: [] }
    p.claimAnchors = p.claimAnchors.filter(a => !a.startsWith('habit:'))
    expect(packetProblems(p)).toEqual([])
    const floor = templateFloor(p)
    expect(floor.map(s => s.slot)).toEqual(['whatHappened', 'why', 'pattern'])
    expect(validateSlots({ slots: floor }, p).violations.filter(x => !/^readability/.test(x))).toEqual([])
    // A nextTime slot is a violation when the packet carries no habit
    expect(validateSlots({ slots: [...floor, good()[3]] }, p).violations.join()).toMatch(/must be omitted/)
  })
})

describe('narrator pipeline', () => {
  const p = packetOf(forkReport())
  const claimsFor = (slots: Slot[]) => ({
    claims: slots.flatMap(s => s.text.split(/(?<=\.)\s+/).map(t => ({ slot: s.slot, text: t, refs: [...t.matchAll(/\{ref:([a-z0-9:-]+)\}|NO_THREAT/g)].map(m => m[1] ?? 'c-nothreat'), tense: 'past' }))),
  })
  const caller = (drafts: unknown[], claims?: unknown): { call: Caller; calls: LlmCall[] } => {
    const calls: LlmCall[] = []
    return {
      calls,
      call: async c => {
        calls.push(c)
        if (c.pass === 'decompose') return { json: claims ?? claimsFor(good()), cost: 0.002, model: c.model }
        return { json: drafts.shift(), cost: 0.001, model: c.model }
      },
    }
  }

  it('serves a draft that passes every check, at temperature 0.3, then a temperature-0 claim check', async () => {
    const { call, calls } = caller([{ slots: good() }])
    const n = await narrate(p, call)
    expect(n.source).toBe('model')
    expect(calls.map(c => [c.pass, c.temperature])).toEqual([['draft', 0.3], ['decompose', 0]])
    expect(n.cost).toBeCloseTo(0.003)
  })

  it('repairs once, then falls back to the floor', async () => {
    const bad = { slots: [{ slot: 'whatHappened', text: 'Ke2 lost a rook.', refs: [] }] }
    const fixed = await narrate(p, caller([bad, { slots: good() }]).call)
    expect(fixed.source).toBe('model')
    const twice = await narrate(p, caller([bad, bad]).call)
    expect(twice).toMatchObject({ source: 'floor', calls: 2 })
    expect(twice.reason).toMatch(/repair failed/)
  })

  it('refused packets and uncertified threats never reach the model', async () => {
    const { call, calls } = caller([])
    const shallow = packetOf(forkReport({ best: forkReport().best.map(r => ({ ...r, depth: 18 })) }))
    expect((await narrate(shallow, call)).source).toBe('floor')
    const medium = packetOf(forkReport({ threat: [run([{ pv: ['a8a1'], eval: cp(-400) }]), run([{ pv: ['a8a1'], eval: cp(-400) }])] }))
    expect((await narrate(medium, call)).reason).toBe('threat not certified')
    expect(calls).toEqual([])
  })

  it('deletes unanchored claims, and abandons prose past 30%', async () => {
    const extra = good().map(s => (s.slot === 'why' ? { ...s, text: `${s.text} The knight loves the center.` } : s))
    const claims = claimsFor(extra)
    const pruned = prune(extra, claims, p)!
    expect(pruned.removed).toBe(1)
    expect(pruned.slots.find(s => s.slot === 'why')!.text).not.toMatch(/center/)
    const n = await narrate(p, caller([{ slots: extra }], claims).call)
    expect(n).toMatchObject({ source: 'model', pruned: 1 })
    const junk = good().map(s => ({ ...s, text: `${s.text} Nice. Good. Fine. Great.` }))
    expect((await narrate(p, caller([{ slots: junk }], claimsFor(junk)).call)).source).toBe('floor')
  })

  it('a mate claim on a fact that is not a mate is deleted', () => {
    const slots = good().map(s => (s.slot === 'why' ? { ...s, text: 'They had NO_THREAT, so you were free to play {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook. {ref:pv2} is close to mate.' } : s))
    expect(prune(slots, claimsFor(slots), p)!.removed).toBe(1)
  })

  it('stops at the budget and serves the floor', async () => {
    const pricey: Caller = async c => ({ json: c.pass === 'decompose' ? claimsFor(good()) : { slots: [] }, cost: 0.03, model: c.model })
    const n = await narrate(p, pricey)
    expect(n.source).toBe('floor')
    expect(n.cost).toBeLessThanOrEqual(0.05 + 0.03)
    expect(n.calls).toBeLessThanOrEqual(5)
  })

  it('a failed claim check fails closed', async () => {
    const call: Caller = async c => {
      if (c.pass === 'decompose') throw new Error('timeout')
      return { json: { slots: good() }, cost: 0.001 }
    }
    expect((await narrate(p, call)).reason).toBe('claim check unavailable')
  })

  it('smooth rides the auto-router at cost_tier low, capped at the reservation; draft and decompose stay pinned', async () => {
    // A present-tense claim about a hanging piece on b8 - empty after the
    // game move - is pruned; it carried the no-threat ref, so the why slot
    // then fails validation and the rejoin pass runs
    const hang: Certificate = { id: 'c-hang', type: 'tactical', subject: 'best', side: 'b', targetSide: 'w', motif: 'hanging piece', payload: { square: 'b8', piece: 'rook' }, text: 'the rook on b8 was loose' }
    p.certificates.push(hang)
    p.claimAnchors.push('c-hang')
    const why = 'They had {ref:c-nothreat} and their {ref:c-hang} was loose, so you were free to play {ref:best}. After {ref:pv1}, {ref:pv2} takes the rook.'
    const draft = good().map(s => (s.slot === 'why' ? { ...s, text: why, refs: ['c-nothreat', 'c-hang', 'best', 'pv1', 'pv2'] } : s))
    const claims = {
      claims: [
        { slot: 'whatHappened', text: 'In the game, {ref:played} cost you {ref:swing}.', refs: ['played', 'swing'], tense: 'past' },
        { slot: 'why', text: 'They had {ref:c-nothreat} and their {ref:c-hang} was loose', refs: ['c-nothreat', 'c-hang'], tense: 'present' },
        { slot: 'why', text: 'so you were free to play {ref:best}', refs: ['best'], tense: 'past' },
        { slot: 'why', text: 'After {ref:pv1}, {ref:pv2} takes the rook.', refs: ['pv1', 'pv2'], tense: 'past' },
      ],
    }
    const { call, calls } = caller([{ slots: draft }, { slots: good() }], claims)
    const n = await narrate(p, call)
    expect(n.source).toBe('model')
    expect(n.pruned).toBe(1)
    expect(calls.map(c => c.pass)).toEqual(['draft', 'decompose', 'smooth'])
    expect(calls[0].model).toBe(MODELS.draft.model) // pinned
    expect(calls[1].model).toBe(MODELS.lint.model) // pinned
    const smooth = calls[2]
    expect(smooth.model).toBe(SMOOTH_MODEL)
    expect(smooth.routing?.maxPrice).toBeGreaterThan(0)
    expect(smooth.routing!.maxPrice).toBeLessThan(BUDGET_USD)
    // the served model is recorded per response, the router's pick included
    expect(n.models).toEqual([MODELS.draft.model, MODELS.lint.model, SMOOTH_MODEL])
  })
})

// Real certification reports from the reference account's hardest puzzles
// (bun run test:gate writes them): every one must validate, build a packet
// that passes its own self-check, and get a floor that meets the required sets
describe('reference reports', () => {
  const reports = JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8')) as EngineReport[]
  it.each(reports.map((r, i) => [i, r] as const))('report %i', (_, raw) => {
    for (const band of ['beginner', 'club', 'advanced'] as const) {
      const r = validReport(JSON.parse(JSON.stringify({ ...raw, band })))
      expect(r).toBeTruthy()
      const p = packetOf(r!)
      expect(packetProblems(p)).toEqual([])
      expect(validateSlots({ slots: templateFloor(p) }, p).violations.filter(v => !/^readability|could not be certified/.test(v))).toEqual([])
    }
  })
})
