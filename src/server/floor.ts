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

  // What happened: about the player's try when one is recorded (the puzzle
  // is the default frame), else the original game move, marked as game
  // context - never the bare game move as if it happened in the puzzle
  let what: string
  if (p.position.drawRule) what = `The rules matter here: ${ref('c-draw')}.`
  else if (p.tried && has('tryswing')) what = `You tried ${ref('tried')} and it cost you ${ref('tryswing')}.`
  else if (p.played && has('swing')) what = `In the game, ${ref('played')} cost you ${ref('swing')}.`
  else what = p.holding.length > 1 ? `Any of ${p.holding.map(h => ref(h.id)).join(', ')} held the position.` : `The answer was ${ref('best')}.`

  // Why: the threat (or certified none), then the line
  const why: string[] = []
  if (p.threatStatus === 'certified' && p.threat) why.push(`They threatened ${ref('threat')}.`)
  else if (p.threatStatus === 'certifiedNull') why.push(`They had NO_THREAT, so the point was ${ref('best')}.`)
  else if (p.position.check.before && has('check')) why.push(`They gave ${ref('check')}, so the reply came first.`)
  if (has('c-mate') && p.best.pv.length > 2) why.push(`After ${ref('best')} and ${ref('pv1')}, ${ref('pv2')} follows: ${ref('c-mate')}.`)
  else if (has('c-mate')) why.push(`${ref('best')} gives ${ref('c-mate')}.`)
  else if (p.best.pv.length > 2) why.push(`${ref('best')} is met by ${ref('pv1')}, then ${ref('pv2')}.`)
  else if (p.best.pv.length > 1) why.push(`${ref('best')} is met by ${ref('pv1')}.`)
  else why.push(`The move was ${ref('best')}.`)
  if (p.holding.length > 1 && !why.some(w => w.includes('{ref:hold'))) why.push(`${ref(p.holding[0].id)} was one way to hold.`)
  const punish = has('c-try') ? 'c-try' : has('c-punish') ? 'c-punish' : undefined
  if (punish === 'c-try') why.push(`Against ${ref('tried')}, they had this: ${ref(punish)}.`)
  else if (punish) why.push(`Against the game move ${ref('played')}, they had this: ${ref(punish)}.`)
  else if (p.played?.reply.length) why.push(`In the game, ${ref('played')} was answered by ${ref(p.played.reply[0].id)}.`)
  if (band === 'advanced') {
    const deep = has('c-forced') ? 'c-forced' : p.alternatives[0] ? p.alternatives[0].id : p.claimAnchors.find(a => /^c-fd\d+$/.test(a))
    if (deep === 'c-forced') why.push(`Here ${ref('c-forced')}.`)
    else if (deep?.startsWith('alt')) why.push(`The next choice, ${ref(deep)}, was worse.`)
    else if (deep) why.push(`Also, ${ref(deep)}.`)
  }
  if (p.didactic.puzzleType === 'conversion' && has('material')) why.push(`You had ${ref('material')}.`)

  // The pattern, then one habit, both verbatim from the libraries. No
  // eligible habit: the floor is shorter, with no generic tip
  const pattern = p.didactic.motifCert ? `Your idea: ${ref(p.didactic.motifCert)}. ${ref(p.didactic.glossId)}` : ref(p.didactic.glossId)
  const out = [slot('whatHappened', what), slot('why', why.join(' ')), slot('pattern', pattern)]
  if (p.didactic.habitSlotId) out.push(slot('nextTime', ref(p.didactic.habitSlotId)))
  return out
}
