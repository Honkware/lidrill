import type { Packet, SlotName } from './packet'
import type { Slot } from './render'

// The deterministic floor: pre-authored slot text in ref form,
// per puzzle type and band, built only from what the packet certified. It
// is what the player sees whenever the narrator's draft fails, the packet
// refused certification, or the budget ran out.

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

  // Why: the threat (or certified none), then the line
  const why: string[] = []
  if (p.threatStatus === 'certified' && p.threat) why.push(`They threatened ${ref('threat')}.`)
  else if (p.threatStatus === 'certifiedNull') why.push(`They had NO_THREAT: ${ref('best')}.`)
  else if (p.position.check.before && has('check')) why.push(`They gave ${ref('check')}, so the reply came first.`)
  if (has('c-mate') && p.best.pv.length > 2) why.push(`After ${ref('best')} and ${ref('pv1')}, ${ref('pv2')} follows: ${ref('c-mate')}.`)
  else if (has('c-mate')) why.push(`${ref('best')} gives ${ref('c-mate')}.`)
  else if (p.best.pv.length > 2) why.push(`${ref('best')} is met by ${ref('pv1')}, then ${ref('pv2')}.`)
  else if (p.best.pv.length > 1) why.push(`${ref('best')} is met by ${ref('pv1')}.`)
  else why.push(`The move was ${ref('best')}.`)
  if (p.holding.length > 1 && !why.some(w => w.includes('{ref:hold'))) why.push(`${ref(p.holding[0].id)} was one way to hold.`)
  // The punishment of the game move: a post-mortem, so Beginner floors (the
  // 80-word budget) skip it - carries the failure by category label
  // and swing; Club and Advanced keep it
  const punish = band === 'beginner' ? undefined : has('c-try') ? 'c-try' : has('c-punish') ? 'c-punish' : undefined
  if (punish === 'c-try') why.push(`Against ${ref('tried')}, they had this: ${ref(punish)}.`)
  else if (punish) why.push(`Against the game move ${ref('played')}, they had this: ${ref(punish)}.`)
  if (band === 'advanced') {
    const deep = has('c-forced') ? 'c-forced' : p.alternatives[0] ? p.alternatives[0].id : p.claimAnchors.find(a => /^c-fd\d+$/.test(a))
    if (deep === 'c-forced') why.push(`Here ${ref('c-forced')}.`)
    else if (deep?.startsWith('alt')) why.push(`The next choice, ${ref(deep)}, was worse.`)
    else if (deep) why.push(`Also, ${ref(deep)}.`)
  }
  if (p.didactic.puzzleType === 'conversion' && has('material')) why.push(`You had ${ref('material')}.`)

  // The pattern, then one habit, both verbatim from the libraries. No
  // eligible habit: the floor is shorter, with no generic tip. A mate with
  // no tactical motif names the mate as the point;
  // only a position with neither gets the generic gloss - and those floor
  // by design at the narrator until the library grows strategic entries.
  // "Your" carries the pattern's polarity (the motif certificate is the
  // player's); the wordy lead-ins stay short so the floor fits the budget
  const pattern = p.didactic.motifCert
    ? `Your idea: ${ref(p.didactic.motifCert)}. ${ref(p.didactic.glossId)}`
    : has('c-mate')
      ? `Your point: ${ref('c-mate')}.`
      : ref(p.didactic.glossId)
  const out = [slot('whatHappened', what), slot('why', why.join(' ')), slot('pattern', pattern)]
  if (p.didactic.habitSlotId) out.push(slot('nextTime', ref(p.didactic.habitSlotId)))
  return out
}
