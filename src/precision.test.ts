import { attributesModule, classModule, eventListenersModule, init, propsModule, styleModule } from 'snabbdom'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Ctrl } from './ctrl'
import { fromFen } from './server/facts'
import { corpus, exportMarks, loadMarks, PRECISION_MARKS_KEY, PRECISION_SCHEMA, saveMarks, summarize, type PrecisionClaim } from './precision'
import { precisionView } from './views/precision'

// The human precision pass: marking flow, summary math and the
// gate-ingestible export, over the committed gate corpus.

describe('precision corpus', () => {
  it('ships ~50 well-formed claims with stable ids and legal positions', () => {
    expect(corpus.claims.length).toBeGreaterThanOrEqual(45)
    expect(corpus.claims.length).toBeLessThanOrEqual(55)
    expect(new Set(corpus.claims.map(c => c.id)).size).toBe(corpus.claims.length)
    expect(new Set(['model', 'floor'])).toContain(corpus.source)
    for (const c of corpus.claims) {
      expect(c.text.trim().length).toBeGreaterThan(0)
      expect(fromFen(c.fen)).toBeTruthy()
      expect(['beginner', 'club', 'advanced']).toContain(c.band)
      expect(['whatHappened', 'why', 'pattern', 'nextTime']).toContain(c.slot)
    }
    // all three bands represented
    expect(new Set(corpus.claims.map(c => c.band)).size).toBe(3)
  })
})

const claims: PrecisionClaim[] = [
  { id: 'a', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', band: 'club', slot: 'why', text: 'One.' },
  { id: 'b', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', band: 'club', slot: 'why', text: 'Two.' },
  { id: 'c', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', band: 'club', slot: 'why', text: 'Three.' },
  { id: 'd', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', band: 'club', slot: 'why', text: 'Four.' },
]

describe('summary math', () => {
  it('claim precision is right / (right + wrong); cannot-determine is excluded', () => {
    expect(summarize(claims, {})).toEqual({ total: 4, marked: 0, right: 0, wrong: 0, unknown: 0, precision: null })
    const s = summarize(claims, { a: 'right', b: 'right', c: 'wrong', d: 'unknown' })
    expect(s).toEqual({ total: 4, marked: 4, right: 2, wrong: 1, unknown: 1, precision: 2 / 3 })
    expect(s.precision!).toBeLessThan(0.99) // 66.7% is below the gate
    // only cannot-determine marked: nothing judgeable, precision stays null
    expect(summarize(claims, { a: 'unknown' }).precision).toBeNull()
    // the 99% gate: 99 right of 100 judged passes
    const many = Array.from({ length: 100 }, (_, i) => ({ ...claims[0], id: `m${i}` }))
    expect(summarize(many, Object.fromEntries(many.map((m, i) => [m.id, i < 99 ? 'right' : 'wrong']))).precision).toBe(0.99)
  })
})

describe('marking flow', () => {
  beforeEach(() => localStorage.clear())

  it('marks persist across loads (localStorage)', () => {
    saveMarks({ a: 'right', b: 'unknown' })
    expect(loadMarks()).toEqual({ a: 'right', b: 'unknown' })
  })

  it('garbage in storage yields no marks, never throws', () => {
    localStorage.setItem(PRECISION_MARKS_KEY, '{"a": right, broken')
    expect(loadMarks()).toEqual({})
    localStorage.setItem(PRECISION_MARKS_KEY, '{"a": 1, "b": "right"}')
    expect(loadMarks()).toEqual({ b: 'right' })
  })

  it('the export carries every claim with its mark and the summary, for the gate', () => {
    saveMarks({ a: 'right', c: 'wrong' })
    const out = exportMarks({ schema: 'lidrill-precision-corpus/1', source: 'floor', generatedAt: '2026-10-07T00:00:00Z', claims }, loadMarks())
    expect(out.schema).toBe(PRECISION_SCHEMA)
    expect(out.corpus).toEqual({ source: 'floor', generatedAt: '2026-10-07T00:00:00Z' })
    expect(out.summary).toEqual({ total: 4, marked: 2, right: 1, wrong: 1, unknown: 0, precision: 0.5 })
    expect(out.claims).toHaveLength(4)
    expect(out.claims.find(c => c.id === 'a')!.mark).toBe('right')
    expect(out.claims.find(c => c.id === 'b')!.mark).toBeNull()
    expect(out.claims.find(c => c.id === 'c')!.mark).toBe('wrong')
    expect(JSON.parse(JSON.stringify(out))).toEqual(out) // serializable for download
  })
})

describe('precision page', () => {
  const patch = init([classModule, attributesModule, propsModule, styleModule, eventListenersModule])

  const ctrlStub = () => {
    const calls: { id: string; mark: string }[] = []
    const ctrl = {
      precisionIndex: 0,
      precisionMarks: {},
      redraw: () => {},
      precisionMark: (id: string, mark: string) => calls.push({ id, mark }),
      precisionReset: () => {},
      precisionExport: () => {},
    } as unknown as Ctrl
    return { ctrl, calls }
  }

  const render = (ctrl: Ctrl) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = patch(host, precisionView(ctrl)).elm as HTMLElement // patch swaps the host for a new element
    return root
  }

  it('shows the claim with its position, band and slot, and marks on click', () => {
    const { ctrl, calls } = ctrlStub()
    const host = render(ctrl)
    const claim = corpus.claims[0]
    expect(host.textContent).toContain('Claim review')
    expect(host.textContent).toContain(claim.text)
    expect(host.textContent).toContain(`${claim.band} band`)
    expect(host.textContent).toContain('1 of')
    expect(host.querySelectorAll('.cg-wrap').length).toBe(1) // the board snapshot
    const right = [...host.querySelectorAll('button')].find(b => b.textContent === 'Right')!
    right.click()
    expect(calls).toEqual([{ id: claim.id, mark: 'right' }])
    host.remove()
  })

  it('summary card tracks the marks and offers the export', () => {
    const { ctrl } = ctrlStub()
    ctrl.precisionMarks = { [corpus.claims[0].id]: 'right', [corpus.claims[1].id]: 'wrong' }
    const host = render(ctrl)
    expect(host.textContent).toContain('2 of')
    expect(host.textContent).toMatch(/claim precision: 50%/)
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toContain('Export for the gate')
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toContain('Start over')
    host.remove()
  })
})
