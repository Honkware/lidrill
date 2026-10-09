import type { Band } from '../db'
import { family, HABITS } from './habits'
import type { Packet, SetMembership, SlotName } from './packet'
import { checkCeilings, styleBudget } from './readability'
import { gameFrameIds, movesById, NO_THREAT_ID, REF, renderRef, renderText, SLOTS, type Slot } from './render'
import { toneViolations } from './tone'

// Mechanical checks only. A draft passes or names
// its violations; nothing here asks a model whether a claim is true.

export interface Verdict {
  ok: boolean
  violations: string[]
  slots?: Slot[] // normalized, when the shape was readable
}

// V-DUP: one swing renders once. A sentence restating the same
// magnitude in a second bucket ("about three pawns (about a knight or
// bishop)") is the seeded live failure - one swing, one bucket
const MAGNITUDE_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+(?:\.\d+)?) pawns?\b|\ba (?:queen|rook|piece|pawn)'s worth\b|\ba (?:queen|rook|piece|pawn) and a half\b|\ba queen or more\b|\bmore than ten pawns\b|\ba small edge\b/i
const PAREN = /[([][^)\]]*[)\]]/g

// Which ref ids render a magnitude, and the identity of the swing they
// render - two renderings of the same identity in one sentence is V-DUP.
// Only the threat's head ref renders its consequence; the t1… follow-ups
// render plain SANs, and c-stops renders "X stops Y" - none is a magnitude.
function magnitudeKey(id: string): string | undefined {
  if (id === 'swing' || id === 'tryswing' || id === 'material') return id
  if (id === 'threat') return 'threat'
  if (/^c-acc\d+$/.test(id)) return id
  if (id === 'c-forced' || id === 'c-mate') return id
  return undefined
}

// Which solve frame the draft is validated against - "cost you" and
// the retired "Answer:" token are legal only in the miss frame, and the
// also-good frame must open with "Your move works."
export interface FrameContext {
  membership: SetMembership
  solvingRef?: string // the packet's fact id for the solving move (set frame)
}
export const MISS_FRAME: FrameContext = { membership: 'miss' }

// NFKC and no zero-width or bidi characters, before any matching
export const normalize = (t: string) => t.normalize('NFKC').replace(/[​-‏‪-‮⁠-⁩﻿]/g, '')

// Latin-1 printable plus typographic punctuation; anything else (Greek Nu
// for N, figurines) is a violation. Refs are masked first.
const CHARSET = /^[ -~ -ÿ‘’“”–-…]*$/
const mask = (t: string) => t.replace(REF, '§')

// Chess notation outside a ref: SAN shapes (also foreign piece letters),
// squares, UCI, castling with zeros or O's, digits, figurines
const NOTATION: [RegExp, string][] = [
  [/\b[KQRBNSLTDCP]?[a-h]?[1-8]?x?[a-h][1-8](=?[QRBNSLTD])?[+#]?(?![\w])/, 'a move or square'],
  [/\b[a-h][1-8][a-h][1-8][qrbn]?\b/i, 'a UCI move'],
  [/\b[0O]-[0O](-[0O])?\b/, 'castling'],
  [/[♔-♟]/, 'a figurine'],
  [/\d/, 'a number'],
]

// Pattern names: only ones the packet certified, and never undetected ones
const CONCEPTS: [string, RegExp][] = [
  ['fork', /\bfork(s|ed|ing)?\b/i],
  ['pin', /\bpin(s|ned|ning)?\b/i],
  ['skewer', /\bskewer\w*/i],
  ['discovered attack', /\bdiscover(ed|s|y)\b|\buncover\w*/i],
  ['removing the defender', /\bremov\w* the (defender|guard)\b/i],
  ['trapped piece', /\btrapped\b/i],
  ['back-rank mate', /\bback[- ]rank\b/i],
  ['smothered mate', /\bsmother\w*/i],
  ['double check', /\bdouble check\b/i],
  ['hanging piece', /\bhang(s|ing)?\b|\bunprotected\b|\bloose\b/i],
  ['promotion', /\bpromot\w*/i],
]
const NEVER = /\b(deflect\w*|overload\w*|decoy\w*|zwischenzug|intermezzo|x-ray|interfer\w*|clearance|attraction|zugzwang|fortress)\b/i
const LOANWORDS = /\b(zwischenzug|zugzwang|prophylaxis|prophylactic|fianchetto|luft|desperado|tempo)\b/i

// Trigger-anchor: abstract ideas may appear only in a sentence that
// carries the fact that proves them - an unanchored abstraction is pruned,
// never served
const ABSTRACT =
  /\b(initiative|pressur\w+|compensations?|developments?|activities|positional|crush\w*|decisive|domin\w+|overwhelm\w+|sacrific\w+|speculat\w*|attacks?|attacked|attacking|threatens?|spac\w+)\b/i

// A demonstrative used as a pronoun ("This was…") dangles; used as an
// adjective ("This position has…") it names its referent. The
// exemplar opens "This position has a direct win", so only the pronoun
// use is linted. Closed verb list - the word after the demonstrative
// decides, not a model's judgement.
const DEMONSTRATIVE_VERB =
  /^(is|are|was|were|has|have|had|does|do|did|comes?|came|means?|meant|looks?|seems?|seemed|feels?|felt|sounds?|proved?|turns?|turned|happens?|happened|costs?|cost|wins?|won|loses?|lost|leaves?|left|gives?|gave|takes?|took|gets?|got|keeps?|kept|makes?|made|helps?|works?|worked|shows?|showed|reads?|matters?|counted?|counts?)$/i

const SUBJECTS: [RegExp, 'player' | 'opponent' | 'neutral'][] = [
  [/\b(you|your|you're|you've)\b/gi, 'player'],
  [/\b(they|their|they're|your opponent|the opponent|opponent's)\b/gi, 'opponent'],
  [/\bthe position\b/gi, 'neutral'],
]

const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+/).filter(s => s.trim())

// Ids a ref stands for: NO_THREAT is the no-threat certificate
const refIds = (t: string) => [...t.matchAll(REF)].map(m => m[1] ?? NO_THREAT_ID)

const MECHANISM = /^(t\d+|pv[1-9]\d*|pl\d+|tr\d+|alt\d+|threat|c-(?!nothreat$|draw$).+)$/
const DEEP = /^(alt\d+|c-fd\d+|c-forced)$/
const LINE_REF = /^(t\d+|pv[1-9]\d*|pl\d+|tr\d+|threat)$/

// V-LINE adjacency: moves listed in a sequence must be consecutive plies
// in the certified line, or the text must mark the gap with an ellipsis. This
// stops "After A, B follow" when B is several plies deep and the board state
// has changed in between.
function adjacentInLine(id1: string, id2: string, p: Packet): boolean {
  const moves = movesById(p)
  const a = moves.get(id1)
  const b = moves.get(id2)
  if (!a || !b) return false
  return a.fenAfter === b.fenBefore
}

// V-POV: a player possessive sits directly on a move ref
const PLAYER_POSSESSIVE = /\byour\s+\{ref:([a-z0-9:-]+)\}/gi

// The puzzle position is the default frame; a game-line fact must be
// introduced as game context in the same sentence
const GAME_MARK = /\b(?:in the game|the game move|your game move|from the game)\b/i

// The required refs per solve frame - the miss frame keeps the
// packet's contrast requirements; best relaxes whatHappened to crediting the
// found move; also-good requires the solving move, best, and the certified gap
export function requiredFor(p: Packet, frame: FrameContext): Record<SlotName, string[]> {
  const required: Record<SlotName, string[]> = { ...p.didactic.requiredRefs }
  if (frame.membership === 'best') required.whatHappened = ['best']
  if (frame.membership === 'set') {
    const accCert = frame.solvingRef ? p.certificates.find(c => c.type === 'acceptance' && c.subject === frame.solvingRef) : undefined
    required.whatHappened = [...new Set([frame.solvingRef ?? 'best', 'best', ...(accCert ? [accCert.id] : [])])]
  }
  return required
}

export function validateSlots(out: unknown, p: Packet, frame: FrameContext = MISS_FRAME): Verdict {
  const v: string[] = []
  const band: Band = p.context.band
  const anchors = new Set(p.claimAnchors)
  const gameIds = gameFrameIds(p)
  const hasHabit = p.didactic.habitSlotId !== null

  // 0. Shape
  const slotsIn = (out as { slots?: unknown })?.slots
  if (!out || typeof out !== 'object' || Object.keys(out).some(k => k !== 'slots') || !Array.isArray(slotsIn)) return { ok: false, violations: ['output must be {"slots": [...]} and nothing else'] }
  const slots: Slot[] = []
  for (const raw of slotsIn) {
    const s = raw as Slot
    if (!s || typeof s !== 'object' || Object.keys(s).some(k => !['slot', 'text', 'refs'].includes(k))) {
      v.push('each slot has only slot, text and refs')
      continue
    }
    if (!SLOTS.includes(s.slot) || typeof s.text !== 'string' || s.text.length > 600 || !Array.isArray(s.refs) || s.refs.length > 8 || !s.refs.every(r => typeof r === 'string' && /^[a-z0-9:-]+$/.test(r))) {
      v.push(`slot ${String(s.slot)} is malformed`)
      continue
    }
    slots.push({ slot: s.slot, text: normalize(s.text).trim(), refs: s.refs.map(r => (r === 'no_threat' ? NO_THREAT_ID : r)) })
  }
  for (const name of SLOTS) {
    const n = slots.filter(s => s.slot === name).length
    if (name === 'nextTime' && !hasHabit) {
      if (n !== 0) v.push(`slot nextTime must be omitted: no habit fits this packet (found ${n})`)
      continue
    }
    if (n !== 1) v.push(`slot ${name} must appear exactly once (found ${n})`)
  }
  if (v.length) return { ok: false, violations: v }
  const by = Object.fromEntries(slots.map(s => [s.slot, s])) as Record<SlotName, Slot>

  for (const s of slots) {
    const m = mask(s.text)
    // 1. Charset
    if (!CHARSET.test(m)) v.push(`${s.slot}: characters outside the allowed set`)
    if (!s.text) v.push(`${s.slot}: empty`)
    // An explanation states facts; a question is either rhetorical or a hint
    if (/\?/.test(m)) v.push(`${s.slot}: no questions`)
    // 2. Refs: anchored, and listed exactly as used
    const used = refIds(s.text)
    for (const r of new Set([...used, ...s.refs])) if (!anchors.has(r)) v.push(`${s.slot}: ${r} is not a fact id in the packet`)
    for (const r of used) if (!s.refs.includes(r)) v.push(`${s.slot}: ${r} is used but not listed in refs`)
    for (const r of s.refs) if (!used.includes(r)) v.push(`${s.slot}: ${r} is listed but not used in the text`)
    // 3. Notation outside refs
    for (const [re, what] of NOTATION) if (re.test(m)) v.push(`${s.slot}: ${what} written out ("${m.match(re)![0]}"); use the fact id instead`)
    // 9. Anaphora: a sentence can't open with a demonstrative pronoun
    // (This/That/It/Such) unless a ref follows at once; "This position…"
    // is an adjective use and names its own referent
    for (const sent of sentencesOf(s.text)) {
      const w = sent.trim().split(/\s+/)
      if (/^(This|That|It|Such|These|Those)$/.test(w[0] ?? '') && (w.length === 1 || DEMONSTRATIVE_VERB.test(w[1] ?? '')) && !w.slice(1, 3).some(x => REF.test(x) || /\{ref:/.test(x)))
        v.push(`${s.slot}: "${w[0]}" opens a sentence without saying what it refers to`)
      REF.lastIndex = 0
    }
    // Trigger-anchor: an abstract claim needs the fact that makes
    // it true in the same sentence; with no fact there is nothing to anchor it
    for (const sent of sentencesOf(s.text)) {
      const a = ABSTRACT.exec(mask(sent))
      if (a && refIds(sent).length === 0) v.push(`${s.slot}: "${a[0]}" is an abstraction with no fact in its sentence - anchor it to the feature that makes it true`)
    }
    // 5. Polarity: threats and patterns keep their owner
    for (const sent of sentencesOf(s.text)) {
      for (const m2 of sent.matchAll(REF)) {
        const id = m2[1] ?? NO_THREAT_ID
        const owner = ownerOf(id, p)
        if (!owner) continue
        const subject = subjectBefore(sent.slice(0, m2.index))
        if (!subject) v.push(`${s.slot}: no subject says whose ${id} it is`)
        else if (subject !== 'neutral' && subject !== owner) v.push(`${s.slot}: ${id} belongs to ${owner === 'player' ? 'you' : 'the opponent'}, not ${subject === 'player' ? 'you' : 'them'}`)
      }
    }
    // 8. Position clarity: a game-line fact must read as game context, so a
    // claim about the puzzle never has the original game move as its subject
    for (const sent of sentencesOf(s.text)) {
      for (const m2 of sent.matchAll(REF)) {
        const id = m2[1] ?? NO_THREAT_ID
        if (gameIds.has(id) && !GAME_MARK.test(sent)) v.push(`${s.slot}: ${id} is from the original game - mark it as game context ("in the game, …")`)
      }
    }
    // The other way round: "the game" appears only attached to a
    // game fact - a bare "in the game" with no game id in its sentence
    // confuses the source game with this position
    for (const sent of sentencesOf(s.text)) {
      if (/\bthe game\b/i.test(mask(sent)) && ![...sent.matchAll(REF)].some(rm => gameIds.has(rm[1] ?? NO_THREAT_ID)))
        v.push(`${s.slot}: "the game" with no game fact in the sentence - attach it to the played fact or say "this position"`)
    }
    // V-LINE: line refs stop at the certified consequence. When a
    // material or mate outcome is certified, plys beyond the answer (pv1…,
    // and the threat's follow-ups t1…) are allowed only as compact certified
    // evidence ending at that outcome - a line that runs past the answer
    // mid-hunt fails. (A quiet position with no such outcome has nothing to
    // end at: its certified line is the evidence, and game and try replies
    // are game-frame facts whose consequence is the swing in whatHappened.)
    const moves = movesById(p)
    const mateCert = p.certificates.find(c => c.id === 'c-mate' && c.subject === 'best')
    const mateLine = new Set(((mateCert?.payload as { lineIds?: string[] } | undefined)?.lineIds) ?? [])
    const outcomeCertified =
      p.certificates.some(c => c.type === 'tactical' || c.type === 'mate' || c.type === 'stopsThreat') ||
      (!!p.threat && p.threat.consequence.type !== 'other')
    const endsAtOutcome = (id: string): boolean => {
      const mv = moves.get(id)
      if (mv && (mv.isCapture || mv.mate)) return true
      if (id === 'material' || id === 'swing' || id === 'tryswing' || id === 'c-mate' || id === 'c-mate-net') return true
      if ((id === 'threat' || /^t\d+$/.test(id)) && p.threat && p.threat.consequence.type !== 'other') return true
      const cert = p.certificates.find(c => c.id === id)
      return !!cert && (cert.type === 'tactical' || cert.type === 'stopsThreat' || cert.type === 'forced')
    }
    for (const sent of sentencesOf(s.text)) {
      const matches = [...sent.matchAll(REF)]
      const ids = matches.map(rm => rm[1] ?? NO_THREAT_ID)
      for (const id of ids) {
        if (mateLine.size && /^pv\d+$/.test(id) && !mateLine.has(id)) v.push(`${s.slot}: ${id} is past the certified mate line - the line ends at the mate`)
      }
      const continuation = ids.filter(id => /^(pv[1-9]\d*|t[1-9]\d*)$/.test(id))
      if (outcomeCertified && continuation.length && !endsAtOutcome(ids[ids.length - 1]!))
        v.push(`${s.slot}: the line runs past the answer without ending at the certified outcome - end at the capture, mate or certified amount that decides it ("${sent.trim()}")`)
      // V-LINE adjacency: two line refs in a row must be consecutive
      // plies, or the text must mark the gap with an ellipsis. This stops
      // "After A, B follow" when B is several plies deep.
      for (let i = 0; i < matches.length - 1; i++) {
        const a = ids[i]!
        const b = ids[i + 1]!
        if (!LINE_REF.test(a) || !LINE_REF.test(b)) continue
        if (adjacentInLine(a, b, p)) continue
        const between = sent.slice(matches[i]!.index + matches[i]![0].length, matches[i + 1]!.index)
        if (/\.{2,}|…/.test(between)) continue
        v.push(`${s.slot}: ${a} and ${b} are not consecutive plies - mark the gap with "..." or only list adjacent moves ("${sent.trim()}")`)
      }
    }
    // V-POV: possessives attach only to the game move ({ref:played});
    // "your" on the answer or its line claims moves the player never played
    for (const m2 of s.text.matchAll(PLAYER_POSSESSIVE)) {
      const id = m2[1]!
      if (moves.has(id) && id !== 'played') v.push(`${s.slot}: "your" attaches to ${id} - possessives attach only to the game move ({ref:played})`)
    }
    // "Answer:" is retired everywhere - with an acceptance set there
    // is no single answer; the miss frame labels best "Best was:"
    if (/\bAnswer:/.test(m)) v.push(`${s.slot}: "Answer:" is retired - with an acceptance set there is no single answer (label it "Best was:" in the miss frame)`)
    // "cost you" is contrast-frame language, legal only on a miss
    if (frame.membership !== 'miss' && /\bcost(s|ed)?\s+you\b/i.test(m)) v.push(`${s.slot}: "cost you" belongs to the miss frame - affirm the solving move here`)
    // Same frame rule for the game move's cost in other words: the affirm
    // frames explain the found move on its merits, never the game's price
    if (frame.membership !== 'miss' && /\b(gave|giving|gives) away\b/i.test(m)) v.push(`${s.slot}: the game move's cost belongs to the miss frame - affirm the solving move here`)
    // V-DUP: two renderings of the same magnitude in one sentence -
    // the same swing ref twice, or a bucket restated inside a parenthetical
    for (const sent of sentencesOf(s.text)) {
      const keys = [...sent.matchAll(REF)].map(rm => magnitudeKey(rm[1] ?? NO_THREAT_ID)).filter((k): k is string => !!k)
      if (new Set(keys).size !== keys.length) v.push(`${s.slot}: one swing renders once - the same magnitude is rendered twice ("${sent.trim()}")`)
      const bare = mask(sent)
      const outside = bare.replace(PAREN, '')
      if (MAGNITUDE_WORDS.test(outside) && (bare.match(PAREN) ?? []).some(par => /\b(pawns?|queen|rook|piece|knight|bishop|worth)\b/i.test(par)))
        v.push(`${s.slot}: one swing renders once - two bucket phrasings of the same amount ("${sent.trim()}")`)
    }
    // The pattern slot opens with the position-anchored instance
    // (≥1 packet ref that is not library text), then at most one verbatim
    // definition - a bare definition with no anchors fails M-NOVEL, and the
    // definition never substitutes for the instance
    if (s.slot === 'pattern') {
      const ids = [...s.text.matchAll(REF)].map(rm => rm[1] ?? NO_THREAT_ID)
      const instance = ids.filter(id => !id.startsWith('gloss:') && !id.startsWith('habit:'))
      if (!instance.length) v.push(`${s.slot}: a bare definition with no position ref - open with the instance (the move, square or certificate that makes it true), then the gloss`)
      else if (ids[0]!.startsWith('gloss:')) v.push(`${s.slot}: instance first, gloss second - open with ${instance[0]}, not the definition`)
    }
  }

  const all = slots.map(s => mask(s.text)).join(' ')
  // 4. Entities: pattern names must be certified ones
  const certified = new Set(p.certificates.filter(c => c.type === 'tactical').map(c => c.motif!))
  for (const [name, re] of CONCEPTS) if (re.test(all) && !certified.has(name as never)) v.push(`names "${all.match(re)![0]}" but no ${name} is certified`)
  if (NEVER.test(all)) v.push(`names "${all.match(NEVER)![0]}", which lidrill doesn't detect`)
  if (band !== 'advanced' && LOANWORDS.test(all)) v.push(`"${all.match(LOANWORDS)![0]}" is too technical at this level`)

  // One-term rule: a single certified term per explanation, used
  // once, in the pattern slot; stacked jargon is a lint violation that
  // leads to prune/repair, never silently served. Refs are masked first:
  // ids like {ref:c-hang} or {ref:gloss:fork} are not the model naming a term
  const mentions: { name: string; slot: SlotName }[] = []
  for (const s of slots)
    for (const [name, re] of CONCEPTS) {
      const g = new RegExp(re.source, 'gi')
      const m = mask(s.text)
      while (g.exec(m) !== null) mentions.push({ name, slot: s.slot })
    }
  if (mentions.length > 1) {
    const distinct = [...new Set(mentions.map(x => x.name))]
    v.push(
      distinct.length > 1
        ? `terms stack (${distinct.join(' + ')}) - one certified term per explanation, in the pattern slot`
        : `"${mentions[0].name}" is used ${mentions.length} times - the one certified term is used once`,
    )
  } else if (mentions.length === 1 && mentions[0].slot !== 'pattern') {
    v.push(`the certified term "${mentions[0].name}" belongs in the pattern slot, not in ${mentions[0].slot}`)
  }

  // 6. Modality
  const forced = p.certificates.find(c => c.id === 'c-forced')
  if (/\b(forced|forcing|forces|only move|only way|no choice|had to|necessary|required|needed|must|the only)\b/i.test(all) && !(forced && p.best.unique)) v.push('"forced"/"only move"/"needed" needs the forced certificate')
  // Stopping, preventing or holding off the threat: only with the certificate
  if (/\b(stops?|stopped|stopping|prevents?|prevented|parr(y|ies|ied)|blocks? the threat|counters?|countered|deals? with|meets? the threat|holds? off|defuses?)\b/i.test(all) && !p.certificates.some(c => c.id === 'c-stops'))
    v.push('saying the answer stops the threat needs the c-stops fact')
  const anyMate = p.certificates.some(c => c.type === 'mate') || p.threat?.consequence.type === 'mate' || [p.played, p.tried].some(f => f?.reply.some(r => r.mate))
  if (/\b(check)?mat(e|es|ed|ing)\b/i.test(all) && !anyMate) v.push('mate is mentioned but no mate is certified')
  if (/\b(best|winning|wins|won)\b/i.test(all.replace(/\bbest was:/gi, '§')) && p.meta.certification.refusals.some(r => /differs|not the puzzle/.test(r)))
    v.push('"best"/"wins" is not certified here - the "Best was:" label is exempt; any other best-claim is not')

  // 7. Didactics - per solve frame
  const required = requiredFor(p, frame)
  for (const name of SLOTS)
    for (const req of required[name]) if (!req.split('|').some(r => by[name].refs.includes(r))) v.push(`${name} must use ${req.split('|').join(' or ')}`)
  // The also-good frame opens by affirming the player's move
  if (frame.membership === 'set') {
    if (!frame.solvingRef) v.push('set frame without a packet fact for the solving move')
    else if (!by.whatHappened.text.includes('Your move works.')) v.push('whatHappened: the also-good frame opens with "Your move works."')
  }
  // the threat or a certified "no threat"; a direct mate (mate in 1)
  // ends the game at the move, so no threat can matter
  const usesNoThreat = slots.some(s => s.refs.includes(NO_THREAT_ID))
  if (usesNoThreat && p.threatStatus !== 'certifiedNull') v.push('NO_THREAT is only allowed when no threat is certified')
  if (p.threatStatus === 'uncertified' && !p.position.check.before && p.best.mateIn !== 1) v.push('the threat could not be certified, so this needs the fixed text')
  // the pattern slot's motif is the generator's
  const patternCerts = by.pattern.refs.filter(r => p.certificates.find(c => c.id === r && c.type === 'tactical'))
  if (patternCerts.some(r => r !== p.didactic.motifCert)) v.push(`pattern must be about ${p.didactic.motifCert ?? 'no detected pattern'}`)
  // the habit is the packet's, from the library, for this band and
  // family - a threat-mechanism habit rides a threat-meeting packet of any
  // family
  if (hasHabit) {
    const habit = HABITS.find(h => h.id === p.didactic.habitSlotId)
    const mechanismOk = !!habit?.threat && p.didactic.glossId === 'gloss:meeting-the-threat'
    if (!habit || !habit.bands.includes(band) || (habit.family !== family(p.didactic.puzzleType) && !mechanismOk)) v.push('the habit does not fit this band or puzzle type')
  }
  // M-COUNT and M-NOVEL
  const mech = new Set(by.why.refs.filter(r => MECHANISM.test(r)))
  if (mech.size < p.didactic.mechanismMin) v.push(`why needs at least ${p.didactic.mechanismMin} steps of the line or certified facts (has ${mech.size})`)
  const deepAvailable = p.claimAnchors.some(a => DEEP.test(a))
  if (band === 'advanced' && deepAvailable && ![...mech].some(r => DEEP.test(r))) v.push('why needs an alternative, a forced certificate or a feature change at this level')
  if (!by.why.refs.some(r => !by.whatHappened.refs.includes(r))) v.push('why only repeats what happened')

  // Rendered text: readability and tone on what the player will read
  if (!v.some(x => /not a fact id/.test(x))) {
    const text = renderText(slots, p)
    for (const s of slots) if (refIds(s.text).some(r => renderRef(r, p) === undefined)) v.push(`${s.slot}: a ref can't be rendered`)
    const present = SLOTS.filter(n => text[n] !== undefined)
    const whole = present.map(n => text[n]).join(' ')
    // Style budget on the rendered text (the ceilings above
    // remain the hard caps)
    const style = styleBudget(whole, band)
    if (style) v.push(`style: ${style}`)
    // Readability on what the player reads; a rendered fact counts as one
    // word toward sentence length (it's one unit, written by the renderer)
    const unitText = present.map(n => by[n].text.replace(REF, 'X')).join(' ')
    for (const c of checkCeilings(whole, band)) if (!c.startsWith('sentence')) v.push(`readability: ${c}`)
    for (const c of checkCeilings(unitText, band)) if (c.startsWith('sentence')) v.push(`readability: ${c}`)
    for (const t of toneViolations(whole, band)) v.push(`tone: ${t}`)
  }
  return { ok: v.length === 0, violations: [...new Set(v)], slots }
}

// Whose a threat or pattern is, as the player sees it
function ownerOf(id: string, p: Packet): 'player' | 'opponent' | undefined {
  const mine = p.position.playerColor === 'white' ? 'w' : 'b'
  if (id === 'threat' || /^t\d+$/.test(id)) return p.threat ? (p.threat.side === mine ? 'player' : 'opponent') : undefined
  const c = p.certificates.find(x => x.id === id)
  if (c && (c.type === 'tactical' || c.type === 'noThreat')) return c.side === mine ? 'player' : 'opponent'
  return undefined
}

// The nearest whitelisted subject before a ref in its sentence
function subjectBefore(text: string): 'player' | 'opponent' | 'neutral' | undefined {
  let best: { at: number; who: 'player' | 'opponent' | 'neutral' } | undefined
  for (const [re, who] of SUBJECTS) for (const m of text.matchAll(re)) if (!best || m.index > best.at) best = { at: m.index, who }
  return best?.who
}
