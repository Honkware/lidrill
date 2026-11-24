import { fromFen } from './facts'
import type { Packet } from './packet'
import { movesById, NO_THREAT_ID, REF, renderRef, type Slot } from './render'
import { sentencesOf } from './slots'

// The claim checks. prune (narrate.ts) runs the first three on each claim the
// second model split out. untraced runs them on each sentence and adds a
// closed vocabulary, and a draft it has nothing to say about is served
// without the second model.
//
// The vocabulary rule is what makes that safe to skip: every word the model
// wrote itself is either in PLAIN, a list of words that say nothing about the
// board, or it appears in a fact cited in the same sentence. A piece, a
// capture, a count or an adjective the facts don't hold sends the draft to the
// second model, and so does any word this file has never seen. What neither
// path checks is how plain words relate two facts ("after", "instead of").

const squareIndex = (sq: string) => (sq.charCodeAt(0) - 97) + (Number(sq[1]) - 1) * 8

// A mate claim must rest on a mate fact, a threat claim on the threat. The
// regexes run on the words the model wrote, with ref tokens masked: a gloss
// id like {ref:gloss:back-rank-mate} renders "back-rank mate" but is library
// text, not the model claiming mate - unmasked it false-positived
// every mate-pattern packet.
const MATE = /\b(check)?mat(e|es|ed|ing)\b/i
const THREAT = /\bthreat\w*/i
export function bound(text: string, ids: string[], p: Packet): boolean {
  const own = text.replace(REF, ' ')
  const moves = movesById(p)
  if (MATE.test(own)) {
    const mateIds = ids.filter(id =>
      moves.get(id)?.mate ||
      id === 'c-mate' || id === 'c-mate-net' ||
      (id === 'threat' && p.threat?.consequence.type === 'mate') ||
      // A holding move in a mate-in-1 packet is itself a certified
      // mating move; an acceptance certificate over a mating alternative
      // certifies the mate; and an alternative whose own eval is mate is a
      // mate fact on its id - "Qd8# delivers mate" is anchored on any of them.
      // A mate-pattern tactical certificate (back-rank mate, smothered mate)
      // over a best move that mates is a mate fact too.
      p.holding.some(h => h.id === id && h.san.endsWith('#')) ||
      p.alternatives.some(a => a.id === id && a.eval.type === 'mate') ||
      p.certificates.some(c => {
        if (c.id === id) return c.type === 'acceptance' ? p.alternatives.find(a => a.id === c.subject)?.eval.type === 'mate' : c.type === 'tactical' && /\bmate\b/.test(c.motif ?? '') && p.best.mateIn !== null
        return false
      }))
    if (!mateIds.length) return false
  }
  if (THREAT.test(own) && !ids.some(id => id === 'threat' || /^t\d+$/.test(id) || id === NO_THREAT_ID)) return false
  return true
}

// V-SWING: a magnitude ("lost 3.7 pawns", "won material") must bind
// to the capture, swing, threat or line certificate that produces it - an
// orphaned magnitude is pruned, never served. Written-out numbers are
// already impossible (notation lint), so this catches the shape "that won
// material." resting on a move ref that certifies no amount.
const MAGNITUDE = /\b(pawns?|material|worth|extra)\b/i
export function magnitudeOk(text: string, ids: string[], p: Packet): boolean {
  if (!MAGNITUDE.test(text)) return true
  return ids.some(id => {
    if (id === 'swing' || id === 'tryswing' || id === 'material' || id === 'threat' || /^t\d+$/.test(id)) return true
    const cert = p.certificates.find(c => c.id === id)
    return !!cert && (cert.type === 'tactical' || cert.type === 'stopsThreat' || cert.type === 'forced' || cert.type === 'acceptance' || cert.type === 'mate')
  })
}

// "The rook is hanging" must still be true after the move in question
export function stillHangs(ids: string[], p: Packet): boolean {
  for (const id of ids) {
    const cert = p.certificates.find(x => x.id === id && x.motif === 'hanging piece')
    if (!cert) continue
    const sq = (cert.payload as { square?: string }).square
    const after = fromFen(p.position.fenAfter)
    if (!sq || !after) return false
    const piece = [...after.board].find(([s]) => s === squareIndex(sq))
    if (!piece) return false
  }
  return true
}

// Words that carry a sentence and assert nothing about the board. The floor's
// own wording (floor.ts) is in here, so a model that writes like the floor
// passes. Quantities, piece names, captures and every adjective about a
// piece or square are left out on purpose.
const PLAIN = new Set(
  `a an the this that it its here there
  i you your yours they their them
  is are was were be been being has have had having do does did
  and or but so because since as if then when while after before once
  in on at to of for from with without by into onto against about than
  not no never only also too still just again
  can could would will
  one first next other
  move game position engine choice answer idea point way task line reply try play rule matter
  best good better worse wrong right
  cost give gave given away let allow left leave
  came come went go ran run made make work
  instead now
  what which who
  hold held keep kept meet met
  miss find found see saw seen`
    .split(/\s+/)
    .map(stem),
)

function stem(w: string): string {
  return w.toLowerCase().replace(/'s$/, '').replace(/(ing|ed|es|s)$/, '').replace(/e$/, '')
}

const wordsOf = (t: string) => (t.toLowerCase().match(/[a-z]+(?:'s)?/g) ?? []).map(stem)

const PIECE: Record<string, string> = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', O: 'king' }
const TAKES = ['take', 'took', 'taken', 'capture', 'recapture']

// The words a cited fact lends its sentence: its rendered text, and for a
// move the piece that makes it, the piece it takes, and that it checks. A
// capture lends "takes" but not "wins": whether the piece stays won is a
// certificate's claim, not the move's.
function factWords(id: string, p: Packet): string[] {
  const out = wordsOf(renderRef(id, p) ?? '')
  const san = movesById(p).get(id)?.san ?? p.holding.find(h => h.id === id)?.san ?? p.alternatives.find(a => a.id === id)?.san
  if (san) out.push(stem(PIECE[san[0]] ?? 'pawn'))
  const move = movesById(p).get(id)
  if (move?.captured) out.push(stem(move.captured), ...TAKES.map(stem))
  if (move?.givesCheck) out.push('check')
  const motif = p.certificates.find(c => c.id === id)?.motif
  if (motif) out.push(...wordsOf(motif))
  // "With no threat you were free to..." says what the certificate says
  if (id === NO_THREAT_ID) out.push('fre')
  return out
}

// The also-good frame's fixed opener carries no fact by design
const CHROME = /^Your move works\.$/

// Why a draft still needs the second model's claim check; empty when every
// sentence is traced to the facts it cites
export function untraced(slots: Slot[], p: Packet): string[] {
  const out: string[] = []
  for (const s of slots)
    for (const sent of sentencesOf(s.text)) {
      const ids = [...sent.matchAll(REF)].map(m => m[1] ?? NO_THREAT_ID)
      if (!ids.length) {
        if (!CHROME.test(sent.trim())) out.push(`${s.slot}: no fact id in "${sent.trim()}"`)
        continue
      }
      if (!bound(sent, ids, p)) out.push(`${s.slot}: a mate or threat claim with no mate or threat fact in its sentence`)
      if (!magnitudeOk(sent, ids, p)) out.push(`${s.slot}: an amount with no fact that certifies it`)
      // Past or present can't be told from the words alone, so a hanging
      // piece that is gone after the move is left to the second model
      if (!stillHangs(ids, p)) out.push(`${s.slot}: a hanging piece that is no longer on its square`)
      const lent = new Set(ids.flatMap(id => factWords(id, p)))
      const own = sent.replace(REF, ' ')
      for (const w of own.match(/[A-Za-z]+(?:'s)?/g) ?? []) {
        // bound() has already tied these two families to their facts
        if (MATE.test(w) || THREAT.test(w)) continue
        const k = stem(w)
        if (!PLAIN.has(k) && !lent.has(k)) out.push(`${s.slot}: "${w}" is in no fact cited in its sentence`)
      }
    }
  return [...new Set(out)]
}
