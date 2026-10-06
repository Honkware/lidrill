import type { Band } from '../db'
import { amount, mateIn, points } from './amount'
import { HABITS } from './habits'
import { MOTIF_KEYS, motifEntry } from './motifLib'
import { cpOf, type Packet, type PvMove, type SlotName, type TypedEval } from './packet'

// The renderer: the narrator writes {ref:id} where a fact
// goes, and only this file turns ids into moves, numbers and library text.
// A move the packet doesn't hold, or a wrong number, can't be written.

export const SLOTS: SlotName[] = ['whatHappened', 'why', 'pattern', 'nextTime']
export const REF = /\{ref:([a-z0-9:-]+)\}|\bNO_THREAT\b/g
export const NO_THREAT_ID = 'c-nothreat'

export interface Slot {
  slot: SlotName
  text: string // ref form: "{ref:played} gave away {ref:swing}."
  refs: string[]
}

export interface BoardLink {
  from?: string
  to: string
  fen?: string // the move is played from here…
  after?: string // …to here
}

export interface Segment {
  text: string
  ref?: string
  link?: BoardLink
}

export { amount }

export function evalAmount(e: TypedEval, band: Band): string {
  if (e.type === 'mate') return `a ${mateIn(e.value)}`
  return amount(e.value, band)
}

const POINTS = points

export function materialText(n: number, band: Band): string {
  if (n === 0) return 'level material'
  const exact = band === 'beginner' ? '' : ` (${n > 0 ? '+' : '−'}${Math.abs(n)})`
  return n > 0 ? `an extra ${POINTS(n).replace(/^an? /, '')}${exact}` : `${POINTS(-n)} less${exact}`
}

const CONSEQUENCE = (p: Packet) => {
  const t = p.threat!
  if (t.consequence.type === 'mate') return 'which would mate'
  return t.consequence.type === 'winsMaterial' ? `which would win ${points(t.consequence.material ?? 0)}` : `which would gain ${amount(t.consequence.swingCp, p.context.band)}`
}

// Every move in the packet by id, for text and board links
export function movesById(p: Packet): Map<string, PvMove> {
  const out = new Map<string, PvMove>()
  for (const m of p.best.pv) out.set(m.id, m)
  out.set('best', p.best.pv[0])
  for (const f of [p.played, p.tried]) {
    if (!f) continue
    out.set(f.id, f)
    for (const r of f.reply) out.set(r.id, r)
  }
  if (p.threat) {
    for (const m of p.threat.line) out.set(m.id, m)
    out.set('threat', p.threat.line[0])
  }
  return out
}

// The words an id stands for; undefined if the packet doesn't hold it
export function renderRef(id: string, p: Packet): string | undefined {
  const band = p.context.band
  if (id === 'threat' && p.threat) return `${p.threat.san}, ${CONSEQUENCE(p)}`
  const move = movesById(p).get(id)
  if (move) return move.san
  if (id === 'swing' && p.played?.swing) return evalAmount(p.played.swing, band)
  if (id === 'material') return materialText(p.material.before, band)
  if (id === 'check') return 'the check'
  const hold = p.holding.find(h => h.id === id)
  if (hold) return hold.san
  const alt = p.alternatives.find(a => a.id === id)
  if (alt) return alt.san
  const cert = p.certificates.find(c => c.id === id)
  if (cert) return cert.text
  if (id.startsWith('habit:')) return HABITS.find(h => h.id === id)?.text
  if (id.startsWith('gloss:')) {
    const key = MOTIF_KEYS.find(k => motifEntry(k, band).id === id)
    if (!key) return undefined
    const e = motifEntry(key, band)
    return `${e.gloss} ${e.rule}`
  }
  return undefined
}

const SQUARE = /\b[a-h][1-8]\b/g

// A slot's text with refs replaced, split for the screen: moves link to the
// position they're played from, squares inside certified text get a circle
export function renderSlot(s: Slot, p: Packet): Segment[] {
  const moves = movesById(p)
  const out: Segment[] = []
  let last = 0
  for (const m of s.text.matchAll(REF)) {
    if (m.index > last) out.push({ text: s.text.slice(last, m.index) })
    const id = m[1] ?? NO_THREAT_ID
    const words = renderRef(id, p) ?? ''
    const move = moves.get(id)
    if (move) out.push({ text: words, ref: id, link: { from: move.from, to: move.to, fen: move.fenBefore, after: move.fenAfter } })
    else if (id.startsWith('c-')) out.push(...squareLinks(words, id))
    else out.push({ text: words, ref: id })
    last = m.index + m[0].length
  }
  if (last < s.text.length) out.push({ text: s.text.slice(last) })
  return out
}

function squareLinks(text: string, ref: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(SQUARE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), ref })
    out.push({ text: m[0], ref, link: { to: m[0] } })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), ref })
  return out
}

export const plain = (segments: Segment[]) => segments.map(s => s.text).join('')

export function renderText(slots: Slot[], p: Packet): Record<SlotName, string> {
  const out = {} as Record<SlotName, string>
  for (const s of slots) out[s.slot] = plain(renderSlot(s, p))
  return out
}

export const cp = cpOf
