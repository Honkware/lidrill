import type { Packet, SlotName } from './packet'
import { HABITS } from './habits'
import type { Slot } from './render'

// The deterministic floor: pre-authored slot text in ref form,
// per puzzle type and band, built only from what the packet certified. It
// is what the player sees whenever the narrator's draft fails, the packet
// refused certification, or the budget ran out. the floor obeys the
// same lints as a draft - the mate is bounded ("mate in at most N") with no
// line past it, a certified threat makes the "meeting the threat" type
// (never "no named pattern"), the line stops at the certified consequence,
// and the habit is the mechanism-matched one or omitted.

const ref = (id: string) => `{ref:${id}}`

function slot(name: SlotName, text: string): Slot {
  const refs = [...new Set([...text.matchAll(/\{ref:([a-z0-9:-]+)\}|\bNO_THREAT\b/g)].map(m => m[1] ?? 'c-nothreat'))]
  return { slot: name, text, refs }
}

export function templateFloor(p: Packet): Slot[] {
  const band = p.context.band
  const anchors = new Set(p.claimAnchors)
  const has = (id: string) => anchors.has(id)

  // What happened: the game move and its cost, or
  // the player's try when one is recorded, contrasted with the answer -
  // the puzzle position is the default frame; a game fact is marked as
  // game context, never the bare game move as if it happened in the puzzle
  let what: string
  if (p.position.drawRule) what = `The rules matter here: ${ref('c-draw')}.`
  else if (p.tried && has('tryswing')) what = `You tried ${ref('tried')} and it cost you ${ref('tryswing')}. Answer: ${ref('best')}.`
  else if (p.played && has('swing')) what = `In the game, ${ref('played')} cost you ${ref('swing')}. Answer: ${ref('best')}.`
  else what = p.holding.length > 1 ? `Any of ${p.holding.map(h => ref(h.id)).join(', ')} held the position.` : `Answer: ${ref('best')}.`

  // Why: the threat (or certified none), then the answer with its certified
  // consequence. Every line cited stops at that consequence - the last
  // capture or mate the certified line actually contains;
  // nothing runs past it, and nothing sits past a certified mate.
  const why: string[] = []
  if (p.threatStatus === 'certified' && p.threat) why.push(`They threatened ${ref('threat')}.`)
  else if (p.threatStatus === 'certifiedNull') why.push(`They had NO_THREAT: ${ref('best')}.`)
  else if (p.position.check.before && has('check')) why.push(`They gave ${ref('check')}, so the reply came first.`)

  const mate = p.certificates.find(c => c.id === 'c-mate' && c.subject === 'best')
  // The answer line cut off at the outcome: the last capture or mate in it.
  // Compact form: when the outcome move is deep in the line, cite the head
  // of the line and the outcome move, never every ply of the hunt.
  const outcomeSteps = (): string[] => {
    let last = -1
    p.best.pv.forEach((m, i) => {
      if (i > 0 && (m.isCapture || m.mate)) last = i
    })
    if (last < 1) return []
    const ids = p.best.pv.slice(1, last + 1).map(m => ref(m.id))
    return ids.length > 2 ? [ids[0]!, ids[ids.length - 1]!] : ids
  }
  // A certified material or mate outcome: when there is one, every cited
  // line must end at it (the validator's V-LINE); when there is none the
  // certified line itself is the evidence and may be cited whole
  const outcomeCertified =
    p.certificates.some(c => c.type === 'tactical' || c.type === 'mate' || c.type === 'stopsThreat') ||
    (!!p.threat && p.threat.consequence.type !== 'other')
  if (mate) {
    // The bounded form: the certified mate line only, ending at the mate
    const line = (((mate.payload as { lineIds?: string[] }).lineIds) ?? []).slice(1)
    const steps = line.length > 3 ? [line[0]!, line[line.length - 1]!] : line
    if (steps.length) why.push(`${ref('best')}, then ${steps.map(ref).join(', ')}: ${ref('c-mate')}.`)
    else why.push(`${ref('best')} gives ${ref('c-mate')}.`)
  } else {
    const steps = outcomeSteps()
    const quietLine = p.best.pv.slice(1, 4).map(m => ref(m.id))
    if (steps.length)
      why.push(`After ${ref('best')}, ${steps.join(', ')} ${steps.length > 1 ? 'follow' : 'follows'}.`)
    else if (p.threat && p.threat.line.length > 1 && p.threat.consequence.type !== 'other')
      why.push(`Their idea ran ${p.threat.line.slice(1).map(m => ref(m.id)).join(', ')}: ${ref('threat')}.`)
    else if (!outcomeCertified && quietLine.length)
      why.push(`After ${ref('best')}, ${quietLine.join(', ')} ${quietLine.length > 1 ? 'follow' : 'follows'}.`)
    else why.push(`Answer: ${ref('best')}.`)
  }
  if (p.holding.length > 1 && !why.some(w => w.includes('{ref:hold'))) why.push(`${ref(p.holding[0].id)} was one way to hold.`)
  // The punishment of the game move: a post-mortem, so Beginner floors (the
  // 80-word budget) skip it - carries the failure by category label
  // and swing; Club and Advanced keep it
  const punish = band === 'beginner' ? undefined : has('c-try') ? 'c-try' : has('c-punish') ? 'c-punish' : undefined
  if (punish === 'c-try') why.push(`Against ${ref('tried')}, they had this: ${ref(punish)}.`)
  else if (punish) why.push(`Against the game move ${ref('played')}, they had this: ${ref(punish)}.`)
  // Meeting the threat: when the why is short of the band's
  // mechanism minimum, name the answer's certified consequence - it stops
  // the threat, it is forced, a feature changed, or the next choice was
  // worse. Each is a whole certified clause, never a line past the outcome.
  const mechIds = () =>
    new Set(
      [...why.join(' ').matchAll(/\{ref:([a-z0-9:-]+)\}/g)]
        .map(m => m[1]!)
        .filter(id => /^(t\d+|pv[1-9]\d*|pl\d+|tr\d+|alt\d+|threat|c-(?!nothreat$|draw$).+)$/.test(id)),
    )
  const clause = (id: string) =>
    id === 'c-stops' ? `${ref(id)}.` : id === 'c-forced' ? `Here ${ref(id)}.` : id.startsWith('alt') ? `The next choice, ${ref(id)}, was worse.` : `Also, ${ref(id)}.`
  const pad = (ids: string[]) => {
    const have = mechIds()
    for (const id of ids) {
      if (have.size >= p.didactic.mechanismMin) break
      if (!have.has(id) && has(id)) {
        why.push(clause(id))
        have.add(id)
      }
    }
  }
  pad(['c-stops', 'c-forced'])
  if (band !== 'beginner') pad(p.claimAnchors.filter(a => /^c-fd\d+$/.test(a)))
  pad(p.alternatives.map(a => a.id))
  // M-NOVEL at this level: the why names an alternative, a forced
  // certificate or a feature change whenever one is certified (mate floors
  // included - the mate line alone is not a deep fact)
  if (band === 'advanced') {
    const DEEP = /^(alt\d+|c-fd\d+|c-forced)$/
    const have = mechIds()
    if (p.claimAnchors.some(a => DEEP.test(a)) && ![...have].some(id => DEEP.test(id))) {
      const deep = ['c-forced', ...p.claimAnchors.filter(a => /^c-fd\d+$/.test(a)), ...p.alternatives.map(a => a.id)].find(id => has(id))
      if (deep) why.push(clause(deep))
    }
  }
  if (p.didactic.puzzleType === 'conversion' && has('material')) why.push(`You had ${ref('material')}.`)

  // The pattern, then one habit, both verbatim from the libraries. The
  // packet's glossId is already the right one - the motif's entry, the
  // bounded mate, or the meeting-the-threat gloss for a quiet position with
  // a certified threat; only a position with none of those gets the generic
  // gloss, and those floor by design at the narrator. "Your" carries the
  // pattern's polarity (the motif certificate is the player's); the wordy
  // lead-ins stay short so the floor fits the budget
  const pattern = p.didactic.motifCert
    ? `Your idea: ${ref(p.didactic.motifCert)}. ${ref(p.didactic.glossId)}`
    : has('c-mate')
      ? `Your point: ${ref('c-mate')}.`
      : ref(p.didactic.glossId)
  const out = [slot('whatHappened', what), slot('why', why.join(' ')), slot('pattern', pattern)]
  // The habit only rides along when it matches the packet's mechanism:
  // its tagged motifs are certified here, and a threat-keyed habit only
  // when a threat certified - otherwise the floor is shorter
  const habit = HABITS.find(h => h.id === p.didactic.habitSlotId)
  if (habit) {
    const concepts = p.concepts.map(c => c.tag)
    const mechanismMatches = !habit.when || habit.when.some(m => concepts.includes(m))
    const threatMatches = !habit.threat || p.threatStatus === 'certified'
    if (mechanismMatches && threatMatches) out.push(slot('nextTime', ref(p.didactic.habitSlotId!)))
  }
  return out
}
