import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
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
  frame?: 'game' // the fact is about the original game, not the puzzle position
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
  if (id === 'tryswing' && p.tried?.swing) return evalAmount(p.tried.swing, band)
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

// Facts about the original game line (the move that created the puzzle and
// its certified reply), as opposed to the puzzle position the player faced.
// Everything else in the packet - the answer, its line, the player's tries,
// the threat - is about the puzzle position, the default frame.
export function gameFrameIds(p: Packet): Set<string> {
  const out = new Set<string>()
  if (p.played) {
    out.add('played')
    out.add('swing')
    for (const r of p.played.reply) out.add(r.id)
  }
  if (p.certificates.some(c => c.id === 'c-punish')) out.add('c-punish')
  return out
}

const SQUARE_AT = /\b[a-h][1-8]\b/y

// A SAN the packet holds more than one of (from different positions) stays
// plain: the text doesn't say which one it means. Bare pawn pushes (e4, d5)
// read as squares in certificate text ("the rook on a8"), so only SANs with a
// piece letter, a capture, castling or a suffix link as moves; there the
// square link wins.
const SAN_LINK = /^(?:[NBRQK]|O-O|.*x|.*[+#=])/

const moveLink = (m: PvMove): BoardLink => ({ from: m.from, to: m.to, fen: m.fenBefore, after: m.fenAfter })

// The SAN → link map for certificate text: at most one owner per SAN
function sanLinks(moves: Map<string, PvMove>): Map<string, BoardLink> {
  const out = new Map<string, BoardLink>()
  const ambiguous = new Set<string>()
  for (const m of moves.values()) {
    if (!SAN_LINK.test(m.san) || ambiguous.has(m.san)) continue
    const prev = out.get(m.san)
    if (prev) {
      if (prev.fen !== m.fenBefore) {
        out.delete(m.san)
        ambiguous.add(m.san)
      }
    } else out.set(m.san, moveLink(m))
  }
  return out
}

// Holding and alternative moves are played from the puzzle position; the
// packet stores only their uci, so the arrival position is derived here
const derivedMove = (id: string, p: Packet): BoardLink | undefined => {
  const m = p.holding.find(h => h.id === id) ?? p.alternatives.find(a => a.id === id)
  if (!m || typeof m.uci !== 'string') return undefined // packets stored before uci was kept
  const setup = parseFen(p.position.fenBefore)
  if (setup.isErr) return undefined
  const pos = Chess.fromSetup(setup.value)
  if (pos.isErr) return undefined
  const move = parseUci(m.uci)
  if (!move || !pos.value.isLegal(move)) return undefined
  pos.value.play(move)
  return { from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), fen: p.position.fenBefore, after: makeFen(pos.value.toSetup()) }
}

// A slot's text with refs replaced, split for the screen: moves link to the
// position they're played from, squares inside certified text get a circle,
// and a SAN inside certified text links when exactly one move in the packet
// plays it
export function renderSlot(s: Slot, p: Packet): Segment[] {
  const moves = movesById(p)
  const sans = sanLinks(moves)
  const game = gameFrameIds(p)
  const out: Segment[] = []
  let last = 0
  for (const m of s.text.matchAll(REF)) {
    if (m.index > last) out.push({ text: s.text.slice(last, m.index) })
    const id = m[1] ?? NO_THREAT_ID
    let words = renderRef(id, p) ?? ''
    // Library sentences end with a full stop; don't double it
    if (words.endsWith('.') && s.text[m.index + m[0].length] === '.') words = words.slice(0, -1)
    const frame = game.has(id) ? ({ frame: 'game' } as const) : {}
    const move = moves.get(id)
    if (id === 'threat' && p.threat) {
      // Only the SAN is the move; the consequence rides along plain
      const t = p.threat.line[0]
      out.push({ text: t.san, ref: id, link: moveLink(t), ...frame })
      out.push({ text: words.slice(t.san.length), ref: id, ...frame })
    } else if (move) out.push({ text: words, ref: id, link: moveLink(move), ...frame })
    else {
      const link = derivedMove(id, p)
      if (link) out.push({ text: words, ref: id, link, ...frame })
      else if (id.startsWith('c-')) out.push(...certLinks(words, id, certPosition(id, p, moves), sans, frame.frame))
      else out.push({ text: words, ref: id, ...frame })
    }
    last = m.index + m[0].length
  }
  if (last < s.text.length) out.push({ text: s.text.slice(last) })
  return out
}

// The position a certificate's squares are about: after the move that shows it
function certPosition(id: string, p: Packet, moves: Map<string, PvMove>): string | undefined {
  const moveId = (p.certificates.find(c => c.id === id)?.payload as { moveId?: string } | undefined)?.moveId
  return moveId ? moves.get(moveId)?.fenAfter : undefined
}

function certLinks(text: string, ref: string, fen: string | undefined, sans: Map<string, BoardLink>, frame?: 'game'): Segment[] {
  const byLength = [...sans.keys()].sort((a, b) => b.length - a.length)
  const out: Segment[] = []
  const tail = () => ({ ref, ...(frame ? { frame } : {}) }) as const
  let last = 0
  let i = 0
  while (i < text.length) {
    let hit: { len: number; link: BoardLink } | undefined
    if (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1])) {
      for (const san of byLength) {
        if (!text.startsWith(san, i)) continue
        const next = text[i + san.length]
        if (next !== undefined && /[A-Za-z0-9+#=]/.test(next)) continue
        hit = { len: san.length, link: sans.get(san)! }
        break
      }
    }
    if (!hit) {
      SQUARE_AT.lastIndex = i
      const sq = SQUARE_AT.exec(text)
      if (sq) hit = { len: sq[0].length, link: { to: sq[0], fen } }
    }
    if (!hit) {
      i++
      continue
    }
    if (i > last) out.push({ text: text.slice(last, i), ...tail() })
    out.push({ text: text.slice(i, i + hit.len), ...tail(), link: hit.link })
    i += hit.len
    last = i
  }
  if (last < text.length) out.push({ text: text.slice(last), ...tail() })
  return out
}

export const plain = (segments: Segment[]) => segments.map(s => s.text).join('')

export function renderText(slots: Slot[], p: Packet): Record<SlotName, string> {
  const out = {} as Record<SlotName, string>
  for (const s of slots) out[s.slot] = plain(renderSlot(s, p))
  return out
}

export const cp = cpOf
