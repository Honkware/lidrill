import type { Band } from '../db'
import { family, HABITS } from './habits'
import type { Packet, SlotName } from './packet'
import { checkCeilings } from './readability'
import { NO_THREAT_ID, REF, renderRef, renderText, SLOTS, type Slot } from './render'
import { toneViolations } from './tone'

// Mechanical checks only. A draft passes or names
// its violations; nothing here asks a model whether a claim is true.

export interface Verdict {
  ok: boolean
  violations: string[]
  slots?: Slot[] // normalized, when the shape was readable
}

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

export function validateSlots(out: unknown, p: Packet): Verdict {
  const v: string[] = []
  const band: Band = p.context.band
  const anchors = new Set(p.claimAnchors)

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
    // 9. Anaphora: a sentence can't open with This/That/It/Such unless a ref follows at once
    for (const sent of sentencesOf(s.text)) {
      const w = sent.trim().split(/\s+/)
      if (/^(This|That|It|Such|These|Those)$/.test(w[0]) && !w.slice(1, 3).some(x => REF.test(x) || /\{ref:/.test(x))) v.push(`${s.slot}: "${w[0]}" opens a sentence without saying what it refers to`)
      REF.lastIndex = 0
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
  }

  const all = slots.map(s => mask(s.text)).join(' ')
  // 4. Entities: pattern names must be certified ones
  const certified = new Set(p.certificates.filter(c => c.type === 'tactical').map(c => c.motif!))
  for (const [name, re] of CONCEPTS) if (re.test(all) && !certified.has(name as never)) v.push(`names "${all.match(re)![0]}" but no ${name} is certified`)
  if (NEVER.test(all)) v.push(`names "${all.match(NEVER)![0]}", which lidrill doesn't detect`)
  if (band !== 'advanced' && LOANWORDS.test(all)) v.push(`"${all.match(LOANWORDS)![0]}" is too technical at this level`)

  // 6. Modality
  const forced = p.certificates.find(c => c.id === 'c-forced')
  if (/\b(forced|only move|only way|no choice|had to|necessary|required|needed|must|the only)\b/i.test(all) && !(forced && p.best.unique)) v.push('"forced"/"only move"/"needed" needs the forced certificate')
  // Stopping, preventing or holding off the threat: only with the certificate
  if (/\b(stops?|stopped|stopping|prevents?|prevented|parr(y|ies|ied)|blocks? the threat|counters?|countered|deals? with|meets? the threat|holds? off|defuses?)\b/i.test(all) && !p.certificates.some(c => c.id === 'c-stops'))
    v.push('saying the answer stops the threat needs the c-stops fact')
  const anyMate = p.certificates.some(c => c.type === 'mate') || p.threat?.consequence.type === 'mate' || [p.played, p.tried].some(f => f?.reply.some(r => r.mate))
  if (/\b(check)?mat(e|es|ed|ing)\b/i.test(all) && !anyMate) v.push('mate is mentioned but no mate is certified')
  if (/\b(best|winning|wins|won)\b/i.test(all) && p.meta.certification.refusals.some(r => /differs|not the puzzle/.test(r))) v.push('"best"/"wins" is not certified here')

  // 7. Didactics
  for (const name of SLOTS)
    for (const req of p.didactic.requiredRefs[name]) if (!req.split('|').some(r => by[name].refs.includes(r))) v.push(`${name} must use ${req.split('|').join(' or ')}`)
  // the threat or a certified "no threat"
  const usesNoThreat = slots.some(s => s.refs.includes(NO_THREAT_ID))
  if (usesNoThreat && p.threatStatus !== 'certifiedNull') v.push('NO_THREAT is only allowed when no threat is certified')
  if (p.threatStatus === 'uncertified' && !p.position.check.before) v.push('the threat could not be certified, so this needs the fixed text')
  // the pattern slot's motif is the generator's
  const patternCerts = by.pattern.refs.filter(r => p.certificates.find(c => c.id === r && c.type === 'tactical'))
  if (patternCerts.some(r => r !== p.didactic.motifCert)) v.push(`pattern must be about ${p.didactic.motifCert ?? 'no detected pattern'}`)
  // the habit is the packet's, from the library, for this band and family
  const habit = HABITS.find(h => h.id === p.didactic.habitSlotId)
  if (!habit || !habit.bands.includes(band) || habit.family !== family(p.didactic.puzzleType)) v.push('the habit does not fit this band or puzzle type')
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
    const whole = SLOTS.map(n => text[n]).join(' ')
    // Readability on what the player reads; a rendered fact counts as one
    // word toward sentence length (it's one unit, written by the renderer)
    const unitText = SLOTS.map(n => by[n].text.replace(REF, 'X')).join(' ')
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
