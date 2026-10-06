import { describe, expect, it } from 'vitest'
import { BACKWARD_DEF, byteSize, capBlock, deltas, featureBlock, featuresOf, FEATURES_MAX_BYTES, FEATURES_VERSION, type FeatureBlock } from './features'

const f = (fen: string) => featuresOf(fen)!
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

describe('features: structure', () => {
  it('isolated: a pawn with no own pawn on either neighbouring file', () => {
    const s = f('4k3/8/8/8/8/8/P1PP4/4K3 w - - 0 1').structure.w
    expect(s.isolated).toEqual(['a2'])
    expect(f(START).structure.w.isolated).toEqual([])
  })

  it('doubled: every pawn on a file with two or more own pawns', () => {
    expect(f('4k3/8/8/8/8/2P5/2P1P3/4K3 w - - 0 1').structure.w.doubled).toEqual(['c2', 'c3'])
    expect(f(START).structure.w.doubled).toEqual([])
  })

  it('backward v1: unsupported from behind or level, stop square hit by an enemy pawn', () => {
    // d3 can't be backed up by e4, and c5 controls d4
    expect(f('4k3/8/8/2p5/4P3/3P4/8/4K3 w - - 0 1').structure.w.backward).toEqual(['d3'])
    // c3 stands level with it
    expect(f('4k3/8/8/2p5/4P3/2PP4/8/4K3 w - - 0 1').structure.w.backward).toEqual([])
    // Nothing controls d4
    expect(f('4k3/8/8/8/4P3/3P4/8/4K3 w - - 0 1').structure.w.backward).toEqual([])
    expect(f(START).backwardDef).toBe(BACKWARD_DEF)
  })

  it('passed: no enemy pawn ahead on its own or an adjacent file', () => {
    // a5 and a4 have passed each other, so both are passed; d5 and e7 stop each other
    const s = f('4k3/4p3/8/P2P4/p7/8/8/4K3 w - - 0 1').structure
    expect(s.w.passed).toEqual(['a5'])
    expect(s.b.passed).toEqual(['a4'])
    expect(f(START).structure.b.passed).toEqual([])
  })
})

describe('features: open files', () => {
  it('reports open and half-open files, leaving closed ones out', () => {
    const files = f('4k3/4p3/8/8/8/8/3P4/4K3 w - - 0 1').openFiles
    expect(files.find(x => x.file === 'd')).toEqual({ file: 'd', state: 'halfOpenB' })
    expect(files.find(x => x.file === 'e')).toEqual({ file: 'e', state: 'halfOpenW' })
    expect(files.find(x => x.file === 'a')).toEqual({ file: 'a', state: 'open' })
    expect(files).toHaveLength(8)
    expect(f(START).openFiles).toEqual([])
    expect(f('4k3/3pp3/8/8/8/8/3P4/4K3 w - - 0 1').openFiles.find(x => x.file === 'd')).toBeUndefined()
  })
})

describe('features: king safety', () => {
  it('shieldBroken: counts shield files missing a pawn on the 2nd or 3rd rank', () => {
    expect(f('6k1/8/8/8/8/8/5PPP/6K1 w - - 0 1').kingSafety.w.shieldBroken).toBe(0)
    // h3 still shields, g4 doesn't
    expect(f('6k1/8/8/8/6P1/7P/5P2/6K1 w - - 0 1').kingSafety.w.shieldBroken).toBe(1)
    expect(f('6k1/8/8/8/6PP/8/5P2/6K1 w - - 0 1').kingSafety.w.shieldBroken).toBe(2)
    // Fianchetto with the king on g2 is intact
    expect(f('6k1/8/8/8/8/6P1/5PKP/8 w - - 0 1').kingSafety.w.shieldBroken).toBe(0)
    // A centre king has no shield to break
    expect(f('4k3/8/8/8/8/8/8/4K3 w - - 0 1').kingSafety.w.shieldBroken).toBe(0)
  })

  it('luft: a safe flight square, off the back rank for a back-rank king', () => {
    // Back-rank mate setup: f7 g7 h7 box the king in
    expect(f('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1').kingSafety.b.luft).toBe(false)
    // h6 gives it h7
    expect(f('6k1/5pp1/7p/8/8/8/8/R5K1 w - - 0 1').kingSafety.b.luft).toBe(true)
    // ...unless the b1 bishop covers h7
    expect(f('6k1/5pp1/7p/8/8/8/8/RB4K1 w - - 0 1').kingSafety.b.luft).toBe(false)
    // A king off the back rank only needs any safe square
    expect(f('8/8/8/4k3/8/8/8/4K3 w - - 0 1').kingSafety.b.luft).toBe(true)
  })

  it('openLinesAtKing: pawnless files and long diagonals into the king', () => {
    expect(f('6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1').kingSafety.w.openLinesAtKing).toBe(0)
    // No g-pawn: the g-file is open, and so is nothing else
    expect(f('6k1/5ppp/8/8/8/8/5P1P/6K1 w - - 0 1').kingSafety.w.openLinesAtKing).toBe(1)
    // No f-pawn: the f-file and the g1-a7 diagonal
    expect(f('6k1/5ppp/8/8/8/8/6PP/6K1 w - - 0 1').kingSafety.w.openLinesAtKing).toBe(2)
  })

  it('zoneAttackers / zoneDefenders: distinct pieces hitting the king square or its neighbours', () => {
    // Ng5, Qh4 and Bd3 all reach h7 or f7; the f8 rook guards f7 and g8
    const k = f('5rk1/5ppp/8/6N1/7Q/3B4/8/6K1 b - - 0 1').kingSafety
    expect(k.b.zoneAttackers).toBe(3)
    expect(k.b.zoneDefenders).toBe(1)
    expect(k.w.zoneAttackers).toBe(0)
  })
})

describe('features: development and activity', () => {
  it('counts minors off their squares and castling in the opening', () => {
    expect(f(START).development).toEqual({ w: { minorsOff: 0, castled: false }, b: { minorsOff: 0, castled: false } })
    const d = f('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4').development
    expect(d).toEqual({ w: { minorsOff: 2, castled: true }, b: { minorsOff: 2, castled: false } })
  })

  it('is SUPPRESSED after move 15 or once both sides have castled', () => {
    expect(f('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 16').development).toBe('SUPPRESSED')
    expect(f('r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 w - - 6 5').development).toBe('SUPPRESSED')
  })

  it('activity: piece mobility per side and the difference', () => {
    expect(f(START).activity).toEqual({ w: 4, b: 4, diff: 0 })
    // Lone rook on a1: 7 up the file and b1-d1, the own king on e1 not counted
    expect(f('4k3/8/8/8/8/8/8/R3K3 w - - 0 1').activity).toEqual({ w: 10, b: 0, diff: 10 })
  })

  it('tags every snapshot with the detector version', () => {
    expect(f(START).detectorVersion).toBe(FEATURES_VERSION)
    expect(featuresOf('not a fen')).toBeUndefined()
  })
})

describe('features: deltas and the block', () => {
  it('a pawn capture that leaves a closed file makes it half-open', () => {
    // exd5: the e-file had e4 against e6 and now only Black has a pawn there
    const block = featureBlock('4k3/pp3ppp/4p3/3p4/4P3/8/PP3PPP/4K3 w - - 0 1', '4k3/pp3ppp/4p3/3P4/8/8/PP3PPP/4K3 b - - 0 1', 'best')!
    const e = block.deltas.find(d => d.feature === 'openFiles' && (d.after as { file: string }).file === 'e')!
    expect(e).toMatchObject({ side: 'w', causedBy: 'best', before: { file: 'e', state: 'closed' }, after: { file: 'e', state: 'halfOpenW' }, detectorVersion: FEATURES_VERSION })
    const d = block.deltas.find(x => x.feature === 'openFiles' && (x.after as { file: string }).file === 'd')!
    expect(d.before).toEqual({ file: 'd', state: 'halfOpenW' })
    expect(d.after).toEqual({ file: 'd', state: 'halfOpenB' })
    expect(block.deltas.map(x => x.id)).toEqual(block.deltas.map((_, i) => `fd${i + 1}`))
  })

  it('emits shield, luft and new-pawn deltas, and nothing for a quiet move', () => {
    const before = f('6k1/8/8/8/8/8/5PPP/6K1 w - - 0 1')
    const after = f('6k1/8/8/8/6P1/7P/5P2/6K1 b - - 0 1')
    const ds = deltas(before, after, 'played', 'w')
    expect(ds.find(d => d.feature === 'shieldBroken')).toMatchObject({ side: 'w', before: 0, after: 1 })
    expect(ds.find(d => d.feature === 'luft')).toMatchObject({ side: 'w', before: false, after: true })
    expect(deltas(f(START), f(START), 'tried', 'w')).toEqual([])
    const iso = deltas(f('4k3/8/8/8/8/8/PP6/4K3 w - - 0 1'), f('4k3/8/8/8/8/8/P7/4K3 w - - 0 1'), 'tried', 'b')
    expect(iso.find(d => d.feature === 'isolated')).toMatchObject({ side: 'w', before: [], after: ['a2'] })
    // Backward deltas carry their definition
    const bw = deltas(f('4k3/8/8/8/4P3/3P4/8/4K3 w - - 0 1'), f('4k3/8/8/2p5/4P3/3P4/8/4K3 w - - 0 1'), 'best', 'b')
    expect(bw.find(d => d.feature === 'backward')).toMatchObject({ backwardDef: BACKWARD_DEF, after: ['d3'] })
  })

  it('reports activity only when the difference moves by 5 or more', () => {
    const ds = deltas(f('4k3/8/8/8/8/8/8/4K3 w - - 0 1'), f('4k3/8/8/8/8/8/8/R3K3 w - - 0 1'), 'best', 'w')
    expect(ds.find(d => d.feature === 'activity')).toMatchObject({ side: 'w', after: { w: 10, b: 0, diff: 10 } })
    expect(deltas(f(START), f('rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1'), 'best', 'w').find(d => d.feature === 'activity')).toBeUndefined()
  })

  it('keeps the block under 4 KB, dropping the lowest-priority deltas first', () => {
    const block = featureBlock(START, '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'played')!
    expect(byteSize(block)).toBeLessThanOrEqual(FEATURES_MAX_BYTES)
    expect(block.deltas.some(d => d.feature === 'activity')).toBe(true)

    // Squeeze until something has to go: activity goes before any file
    const full: FeatureBlock = { ...block, deltas: [...block.deltas] }
    const limit = byteSize(full) - 10
    const capped = capBlock(full, limit)!
    expect(byteSize(capped)).toBeLessThanOrEqual(limit)
    expect(capped.deltas.some(d => d.feature === 'activity')).toBe(false)
    expect(capped.deltas.filter(d => d.feature === 'openFiles')).toHaveLength(8)
    expect(capped.deltas.map(d => d.id)).toEqual(capped.deltas.map((_, i) => `fd${i + 1}`))
    // Too small even with no deltas: refused, never half-written
    expect(capBlock(full, 100)).toBeUndefined()
  })

  it('refuses positions that do not parse', () => {
    expect(featureBlock('junk', START, 'best')).toBeUndefined()
  })
})
