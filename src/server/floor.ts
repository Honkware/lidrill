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
  if (p.threatStatus === 'certified' && p.threat) why.push(`They threatened ${ref('threat')}.`)
  else if (p.threatStatus === 'certifiedNull') why.push(`They had NO_THREAT: ${ref('best')}.`)
  else if (p.position.check.before && has('check')) why.push(`They gave ${ref('check')}, so the reply came first.`)

  const mate = p.certificates.find(c => c.id === 'c-mate' && c.subject === 'best')
  // The answer line cut off at the outcome: the last capture or mate in it.
  // Show every ply from the answer to that outcome when the whole sequence is
  // five moves or fewer. If the outcome is deeper than that, drop the line
  // entirely - a partial line with an ellipsis is worse than no line.
  const outcomeSteps = (): string[] => {
    let last = -1
    p.best.pv.forEach((m, i) => {
      if (i > 0 && (m.isCapture || m.mate)) last = i
    })
    if (last < 1) return []
    const ids = p.best.pv.slice(1, last + 1).map(m => ref(m.id))
    return ids.length <= 5 ? ids : []
  }
  // A certified material or mate outcome: when there is one, every cited
  // line must end at it (the validator's V-LINE); when there is none the
  // certified line itself is the evidence and may be cited whole
  const outcomeCertified =
    p.certificates.some(c => c.type === 'tactical' || c.type === 'mate' || c.type === 'stopsThreat') ||
    (!!p.threat && p.threat.consequence.type !== 'other')
  if (mate) {
    // The bounded form: the certified mate line only, ending at the mate.
    // Same five-ply ceiling: show the whole short line, otherwise collapse to
    // "gives mate" rather than skipping plies with an ellipsis.
    const line = (((mate.payload as { lineIds?: string[] }).lineIds) ?? []).slice(1)
    const steps = line.length <= 5 ? line : []
    if (steps.length) why.push(`${ref('best')}, then ${steps.map(ref).join(', ')}: ${ref('c-mate')}.`)
    else why.push(`${ref('best')} gives ${ref('c-mate')}.`)
    // MateNet: why the king cannot run rides along as its own
    // certified clause whenever the packet verified every flight square -
    // the general budget trim below drops it if it overflows the style budget.
    if (has('c-mate-net')) why.push(`${ref('c-mate-net')}.`)
  } else {
    const steps = outcomeSteps()
    // Quiet positions with no certified outcome: cite a short follow-up line
    // (up to three plies) as evidence. This is not the full hunt; it just
    // shows the answer does something concrete.
    const quietLine = p.best.pv.slice(1, 4).map(m => ref(m.id))
    if (steps.length)
      why.push(`After ${ref('best')}, ${steps.join(', ')}.`)
    else if (p.threat && p.threat.line.length > 1 && p.threat.consequence.type !== 'other') {
      // The threat's consequence already appears in the required "They threatened"
      // clause. In the affirm frames explain how the answer meets the threat;
      // only the miss frame needs the opponent's follow-up line.
      const feature = p.claimAnchors.find(a => /^c-fd\d+$/.test(a))
      if (frame.membership !== 'miss' && feature)
        why.push(`${ref(feature)}.`)
      else if (frame.membership !== 'miss' && has('c-stops'))
        why.push(`${ref('best')} ${ref('c-stops')}.`)
      else
        why.push(`Their idea ran ${p.threat.line.slice(1).map(m => ref(m.id)).join(', ')}.`)
    } else if (!outcomeCertified && quietLine.length) {
      // Best/also-good frames explain the found move on its merits; when the
      // packet certified a strategic feature change, cite that instead of a
      // bare follow-up line, especially for beginners who need the "why".
      const feature = p.claimAnchors.find(a => /^c-fd\d+$/.test(a))
      if ((frame.membership === 'best' || frame.membership === 'set') && feature)
        why.push(`${ref(feature)}.`)
      else why.push(`After ${ref('best')}, ${quietLine.join(', ')}.`)
    }
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
      ? `The task is to meet their threat, so ${ref('best')} answers it. ${ref(p.didactic.glossId)}`
      : `The point here is ${ref('best')}. ${ref(p.didactic.glossId)}`
  const pattern =
    frame.membership === 'set' && p.didactic.motifCert
      ? `Your point: ${ref(p.didactic.motifCert)}. ${ref(p.didactic.glossId)}`
      : p.didactic.motifCert
        ? `Your idea: ${ref(p.didactic.motifCert)}. ${ref(p.didactic.glossId)}`
        : has('c-mate')
          ? `Your point: ${ref('c-mate')}.`
          : glossPattern
  // The habit only rides along when it matches the packet's mechanism:
  // its tagged motifs are certified here, and a threat-keyed habit only
  // when a threat certified - otherwise the floor is shorter
  const habit = HABITS.find(h => h.id === p.didactic.habitSlotId)
  const shouldAddHabit = !!habit && (() => {
    const concepts = p.concepts.map(c => c.tag)
    const mechanismMatches = !habit.when || habit.when.some(m => concepts.includes(m))
    const threatMatches = !habit.threat || p.threatStatus === 'certified'
    return mechanismMatches && threatMatches
  })()

  // / the style budget is a hard contract. Drop optional why
  // clauses (mate net, punish, feature deltas, alternatives) from the end until
  // the rendered floor fits; never drop a ref the packet's required set asked
  // for in the why slot.
  const requiredWhyIds = new Set(p.didactic.requiredRefs.why.flatMap(r => r.split('|')))
  const DEEP = /^(alt\d+|c-fd\d+|c-forced)$/
  const deepAvailable = p.claimAnchors.some(a => DEEP.test(a))
  const isDeepClause = (w: string) => /\{ref:(alt\d+|c-fd\d+|c-forced)\}/.test(w)
  const optionalWhyClause = (w: string) => {
    // The mate net is supplementary - the bounded mate form already satisfies
    // the required outcome, so the net is the first thing to drop for budget.
    if (/\{ref:c-mate-net\}/.test(w)) return true
    // At advanced, a deep fact (alt, feature delta, forced cert) is needed
    // whenever one is certified; don't budget-trim it away.
    if (band === 'advanced' && deepAvailable && isDeepClause(w)) return false
    return ![...w.matchAll(/\{ref:([a-z0-9:-]+)\}/g)].some(m => requiredWhyIds.has(m[1]!))
  }
  const buildOut = (whyText: string) => {
    const o = [slot('whatHappened', what), slot('why', whyText), slot('pattern', pattern)]
    if (shouldAddHabit) o.push(slot('nextTime', ref(p.didactic.habitSlotId!)))
    return o
  }
  while (why.length > 0) {
    const total = words(Object.values(renderText(buildOut(why.join(' ')), p)).join(' ')).length
    if (total <= STYLE_WORDS[band]) break
    const i = why.findLastIndex(optionalWhyClause)
    if (i < 0) break
    why.splice(i, 1)
  }

  return buildOut(why.join(' '))
}
