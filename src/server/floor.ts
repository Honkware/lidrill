import type { Packet, SlotName } from './packet'
import { HABITS } from './habits'
import { MISS_FRAME, type FrameContext } from './slots'
import { renderText, type Slot } from './render'
import { STYLE_WORDS, words } from './readability'

// The deterministic floor: pre-authored slot text in ref form,
// per puzzle type and band, built only from what the packet certified. It
// is what the player sees whenever the narrator's draft fails, the packet
// refused certification, or the budget ran out. the floor obeys the
// same lints as a draft - the mate is bounded ("mate in at most N") with no
// line past it, a certified threat makes the "meeting the threat" type
// (never "no named pattern"), the line stops at the certified consequence,
// and the habit is the mechanism-matched one or omitted.
// The floor is authored per solve frame - best affirms the found
// move, also-good opens "Your move works." and names best with the certified
// gap, and only the miss frame keeps the contrast ("cost you", "Best was:").

const ref = (id: string) => `{ref:${id}}`

function slot(name: SlotName, text: string): Slot {
  const refs = [...new Set([...text.matchAll(/\{ref:([a-z0-9:-]+)\}|\bNO_THREAT\b/g)].map(m => m[1] ?? 'c-nothreat'))]
  return { slot: name, text, refs }
}

export function templateFloor(p: Packet, frame: FrameContext = MISS_FRAME): Slot[] {
  const band = p.context.band
  const anchors = new Set(p.claimAnchors)
  const has = (id: string) => anchors.has(id)

  // What happened: the miss frame keeps
  // the contrast - the game move (or the player's try) and its cost against
  // "Best was:"; best credits the found move; also-good affirms the solving
  // move and names best as the engine's first choice with the certified gap
  let what: string
  if (frame.membership === 'best') what = `You played ${ref('best')}, the engine's best move.`
  else if (frame.membership === 'set') {
    const accCert = frame.solvingRef ? p.certificates.find(c => c.type === 'acceptance' && c.subject === frame.solvingRef) : undefined
    const alt = frame.solvingRef ? p.alternatives.find(a => a.id === frame.solvingRef) : undefined
    what =
      frame.solvingRef && accCert
        ? alt?.eval.type === 'mate'
          ? `Your move works. ${ref(frame.solvingRef)} mates too - the engine's first choice is ${ref('best')}, ${ref(accCert.id)}.`
          : `Your move works. ${ref(frame.solvingRef)} holds up - the engine's first choice is ${ref('best')}, ${ref(accCert.id)}.`
        : frame.solvingRef
          ? `Your move works. ${ref(frame.solvingRef)} held up - the engine's first choice is ${ref('best')}.`
          : `Your move works. The engine's first choice is ${ref('best')}.`
  } else if (p.position.drawRule) what = `The rules matter here: ${ref('c-draw')}.`
  else if (p.tried && has('tryswing')) what = `You tried ${ref('tried')} and it cost you ${ref('tryswing')}. Best was: ${ref('best')}.`
  else if (p.played && has('swing')) what = `In the game, ${ref('played')} cost you ${ref('swing')}. Best was: ${ref('best')}.`
  else what = p.holding.length > 1 ? `Any of ${p.holding.map(h => ref(h.id)).join(', ')} held the position.` : `Best was: ${ref('best')}.`

  // Why: the threat (or certified none), then the answer with its certified
  // consequence. Every line cited stops at that consequence - the last
  // capture or mate the certified line actually contains;
  // nothing runs past it, and nothing sits past a certified mate.
  const why: string[] = []
  // The slot shape caps a why at 8 refs (validateSlots); supplementary
  // clauses below drop rather than overflow it
  const whyRefs = () => [...why.join(' ').matchAll(/\{ref:[a-z0-9:-]+\}/g)].length
  let netLine: string | undefined // mateNet clause, budget-checked below
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
    // MateNet: why the king cannot run rides along as its own
    // certified clause whenever the packet verified every flight square -
    // budget-checked below (the clause is supplementary; the band's style
    // budget is the hard contract)
    if (has('c-mate-net')) why.push((netLine = `${ref('c-mate-net')}.`))
  } else {
    const steps = outcomeSteps()
    const quietLine = p.best.pv.slice(1, 4).map(m => ref(m.id))
    if (steps.length)
      why.push(`After ${ref('best')}, ${steps.join(', ')} ${steps.length > 1 ? 'follow' : 'follows'}.`)
    else if (p.threat && p.threat.line.length > 1 && p.threat.consequence.type !== 'other')
      why.push(`Their idea ran ${p.threat.line.slice(1).map(m => ref(m.id)).join(', ')}: ${ref('threat')}.`)
    else if (!outcomeCertified && quietLine.length)
      why.push(`After ${ref('best')}, ${quietLine.join(', ')} ${quietLine.length > 1 ? 'follow' : 'follows'}.`)
    else why.push(`Best was: ${ref('best')}.`)
  }
  if (p.holding.length > 1 && !why.some(w => w.includes('{ref:hold'))) why.push(`${ref(p.holding[0].id)} was one way to hold.`)
  // The punishment of the game move: a post-mortem, so Beginner floors (the
  // 80-word budget) skip it - carries the failure by category label
  // and swing; Club and Advanced keep it; the affirm frames never carry it -
  // they explain the solving move on its merits
  const punish = band === 'beginner' || frame.membership !== 'miss' ? undefined : has('c-try') ? 'c-try' : has('c-punish') ? 'c-punish' : undefined
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
  // The slot shape caps a why at 8 refs (validateSlots). When the assembled
  // clauses overflow, trim the supplementary ones - never a required ref,
  // the answer's outcome certificate, or the advanced deep fact
  if (whyRefs() > 8) {
    const requiredIds = new Set(p.didactic.requiredRefs.why.flatMap(r => r.split('|')))
    const optional = (w: string) => ![...w.matchAll(/\{ref:([a-z0-9:-]+)\}/g)].some(m => requiredIds.has(m[1]!))
    const mateLine = why.find(w => w.includes(', then ') && w.includes('{ref:c-mate}'))
    if (mateLine && optional(mateLine)) why[why.indexOf(mateLine)] = `${ref('best')} gives ${ref('c-mate')}.`
    const punishLine = why.find(w => w.startsWith('Against '))
    if (whyRefs() > 8 && punishLine && optional(punishLine)) why.splice(why.indexOf(punishLine), 1)
    for (let i = why.length - 1; i >= 0 && whyRefs() > 8; i--) {
      const w = why[i]!
      if (optional(w) && !w.includes('{ref:c-forced}') && (w.includes('{ref:c-stops}') || w.includes('{ref:c-mate-net}') || /\{ref:(alt\d+|c-fd\d+)\}/.test(w))) why.splice(i, 1)
    }
  }

  // The pattern, then one habit, both verbatim from the libraries. The
  // packet's glossId is already the right one - the motif's entry, the
  // bounded mate, or the meeting-the-threat gloss for a quiet position with
  // a certified threat; only a position with none of those gets the generic
  // gloss, and those floor by design at the narrator. "Your" carries the
  // pattern's polarity (the motif certificate is the player's); the wordy
  // lead-ins stay short so the floor fits the budget; the also-good frame
  // credits the position's point, not the player's idea ("Your point:")
  // The gloss never substitutes for the instance - when the pattern
  // is a definition (meeting the threat, no named pattern), it opens with
  // the position ref that makes it true
  const glossPattern = has('c-stops')
    ? `${ref('c-stops')}. ${ref(p.didactic.glossId)}`
    : p.threat
      ? `The problem was their ${ref('threat')}. ${ref(p.didactic.glossId)}`
      : `The point here is ${ref('best')}. ${ref(p.didactic.glossId)}`
  const pattern =
    frame.membership === 'set' && p.didactic.motifCert
      ? `Your point: ${ref(p.didactic.motifCert)}. ${ref(p.didactic.glossId)}`
      : p.didactic.motifCert
        ? `Your idea: ${ref(p.didactic.motifCert)}. ${ref(p.didactic.glossId)}`
        : has('c-mate')
          ? `Your point: ${ref('c-mate')}.`
          : glossPattern
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
  // The mateNet clause is supplementary - the band's style budget is
  // the hard contract, so a floor that would overflow without fitting drops
  // the clause (Beginner floors, and any motif-rich floor at any band)
  if (netLine) {
    const total = words(Object.values(renderText(out, p)).join(' ')).length
    if (total > STYLE_WORDS[band]) {
      const whySlot = out.find(s => s.slot === 'why')!
      whySlot.text = whySlot.text.replace(netLine, ' ').replace(/\s{2,}/g, ' ').trim()
      whySlot.refs = whySlot.refs.filter(r => r !== 'c-mate-net')
    }
  }
  return out
}
