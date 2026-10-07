import { templateFloor } from './floor'
import { fromFen } from './facts'
import type { Packet } from './packet'
import { movesById, gameFrameIds, NO_THREAT_ID, REF, renderRef, SLOTS, type Slot } from './render'
import { validateSlots } from './slots'

// The narrator. A cheap model drafts the
// four slots in ref form; the mechanical validator decides; one repair try;
// then a temperature-0 pass splits the draft into claims and any claim not
// tied to a fact id is deleted (never repaired); a smoothing pass may rejoin
// what's left. Anything that fails, or runs past the budget, gets the floor.

export interface LlmCall {
  pass: 'draft' | 'repair' | 'decompose' | 'smooth'
  model: string
  temperature: number
  maxTokens: number
  system: string
  user: string
  schema: Record<string, unknown>
  // Set for auto-router calls (smooth only): the reservation the budget
  // check held, enforced on the wire as provider.max_price
  routing?: { maxPrice: number }
}
export interface LlmResult {
  json?: unknown
  cost: number // USD as the provider reported it
  model?: string
}
export type Caller = (call: LlmCall) => Promise<LlmResult>

// Pinned per pass: reproducible budgets; the gate is re-run whenever
// one of these changes
export const MODELS = {
  draft: { model: 'google/gemini-3.8-flash', temperature: 0.3, maxTokens: 900, usdPerMTokIn: 0.75, usdPerMTokOut: 3.75 },
  lint: { model: 'anthropic/claude-haiku-4.5', temperature: 0, maxTokens: 2000, usdPerMTokIn: 1, usdPerMTokOut: 5 },
} as const
export const BUDGET_USD = 0.05
export const MAX_CALLS = 5
export const PRUNE_MAX = 0.3

// Smooth rides the auto-router (openrouter/auto with
// cost_tier 'low'): a rejoin/readability pass whose output is re-validated
// mechanically and falls back to the floor, so the router may pick the
// market's cheap models for it. Draft/decompose stay pinned - the
// gate needs reproducible per-slug numbers and the budget reservation uses
// per-model price constants. The reservation basis is the pinned draft
// model's price: it caps what the router may select (provider.max_price), so
// the budget check stays fail-closed. The served model comes back per
// response and is recorded in models[] like any call.
export const SMOOTH_MODEL = 'openrouter/auto'
export const SMOOTH = { temperature: 0.3, maxTokens: 900, usdPerMTokIn: 0.75, usdPerMTokOut: 3.75 } as const

export const SYSTEM_V2 = [
  'You write the explanation of a chess puzzle for an improving player, in the slots the packet lists: whatHappened, why, pattern, and nextTime only when the packet has a habit.',
  'The puzzle position - the one the player just faced and tried moves in - is the default frame: a claim about it needs no marker. Facts tagged "frame":"game" in the list happened in the original game ({ref:played}, {ref:swing}, the pl… and c-punish ids): introduce them with wording like "in the game" or "the game move", never as moves made in the puzzle.',
  'You never write a chess move, square, number or piece-on-square yourself. Every fact is a fact id from the list; write it as {ref:<id>} and the app inserts the exact words. Write NO_THREAT only where the list says it is allowed.',
  'List every id you use in that slot\'s refs, and no others.',
  'Use only the fact ids given, each with the meaning shown. Add no plans, ideas or patterns that are not facts in the list.',
  'whatHappened: the move made here and what it cost - the player\'s try in this puzzle when one is recorded, otherwise the original game move, marked as game context. why: the mechanism, using the required ids and enough line steps. pattern: the certified pattern and its library text. nextTime: the habit id, nothing else of substance.',
  'Ownership: say "you"/"your" for the player\'s moves and patterns and "they"/"their" for the opponent\'s, right before the id, in the same sentence. Amounts like {ref:swing} take no "your".',
  'Certificate ids (c-…) render as a whole clause, like "every other move is at least 0.8 pawns worse": put them after a colon or after "because", never inside a phrase.',
  'Only say the answer stops, prevents or meets the threat if c-stops is in the list; only say a move was forced, needed or the only move if c-forced is.',
  'Plain, short sentences. No praise, no labels like brilliant, no rhetorical questions, no exclamation marks. Do not start a sentence with This, That, It or Such.',
  'Answer with JSON only: {"slots":[{"slot":"whatHappened","text":"…","refs":["…"]}, …]}, each listed slot exactly once.',
].join('\n')

const SLOT_SCHEMA = (minSlots = 4): Record<string, unknown> => ({
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      minItems: minSlots,
      maxItems: 4,
      items: {
        type: 'object',
        properties: { slot: { type: 'string', enum: SLOTS }, text: { type: 'string' }, refs: { type: 'array', items: { type: 'string' }, maxItems: 8 } },
        required: ['slot', 'text', 'refs'],
        additionalProperties: false,
      },
    },
  },
  required: ['slots'],
  additionalProperties: false,
})

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        properties: {
          slot: { type: 'string', enum: SLOTS },
          text: { type: 'string' },
          refs: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          tense: { type: 'string', enum: ['past', 'present', 'none'] },
        },
        required: ['slot', 'text', 'refs', 'tense'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
}

// What the narrator sees: ids with their rendered meaning, owner and frame.
// No FEN (the narrator never reads the board) and nothing about the opponent.
export function promptView(p: Packet) {
  const mine = p.position.playerColor === 'white' ? 'w' : 'b'
  const moves = movesById(p)
  const gameIds = gameFrameIds(p)
  const owner = (id: string): string => {
    const m = moves.get(id)
    if (m) return m.side === mine ? 'you' : 'opponent'
    const c = p.certificates.find(x => x.id === id)
    if (c && (c.type === 'tactical' || c.type === 'noThreat')) return c.side === mine ? 'you' : 'opponent'
    return '-'
  }
  const facts = p.claimAnchors.map(id => ({ id, means: id === NO_THREAT_ID ? 'no forcing reply (write NO_THREAT)' : renderRef(id, p), owner: owner(id), frame: gameIds.has(id) ? 'game' : 'puzzle' }))
  return {
    level: p.context.band,
    puzzleType: p.didactic.puzzleType,
    youPlay: p.position.playerColor,
    verdictBefore: p.eval.verdict.before,
    verdictAfterGameMove: p.eval.verdict.afterPlayed,
    // The puzzle position is the default frame; game facts must be marked
    whatHappened: p.tried ? 'about the move the player tried in this puzzle' : p.played ? 'about the original game move, as game context ("in the game")' : 'about the answer',
    nextTime: p.didactic.habitSlotId ? 'the habit fact' : 'omit this slot entirely: no habit fits this position',
    lines: {
      answer: p.best.pv.map(m => m.id),
      gameMove: p.played ? ['played', ...p.played.reply.map(r => r.id)] : undefined,
      yourTry: p.tried ? ['tried', ...p.tried.reply.map(r => r.id)] : undefined,
      theirThreat: p.threat ? ['threat', ...p.threat.line.slice(1).map(m => m.id)] : undefined,
    },
    threat: p.threatStatus === 'certified' ? 'use {ref:threat} in why' : p.threatStatus === 'certifiedNull' ? 'there is no threat: write NO_THREAT in why' : p.position.check.before ? 'the player was in check: use {ref:check} in why' : 'unknown',
    facts,
    required: Object.fromEntries(SLOTS.map(s => [s, p.didactic.requiredRefs[s].map(r => r.split('|').join(' or '))])),
    whyNeedsAtLeastThisManyLineStepsOrCertificates: p.didactic.mechanismMin,
    whyMustAddSomethingNotInWhatHappened: true,
    canSay: { forced: p.certificates.some(c => c.id === 'c-forced'), mate: p.certificates.some(c => c.type === 'mate') || p.threat?.consequence.type === 'mate' },
  }
}

export interface Narration {
  slots: Slot[]
  source: 'model' | 'floor'
  reason?: string
  calls: number
  cost: number
  models: string[]
  pruned?: number
}

export async function narrate(p: Packet, call: Caller): Promise<Narration> {
  let calls = 0
  let cost = 0
  const models: string[] = []
  const floor = (reason: string): Narration => ({ slots: templateFloor(p), source: 'floor', reason, calls, cost, models })
  if (p.meta.certification.status !== 'certified') return floor(`not certified: ${p.meta.certification.refusals.join('; ')}`)
  if (p.threatStatus === 'uncertified' && !p.position.check.before) return floor('threat not certified')

  const view = JSON.stringify(promptView(p))
  const slotSchema = SLOT_SCHEMA(p.didactic.habitSlotId ? 4 : 3)
  // Reserve each call's worst case before making it (fail closed at the cap)
  const ask = async (pass: LlmCall['pass'], user: string, which: keyof typeof MODELS | 'smooth', schema: Record<string, unknown>) => {
    const pinned = which === 'smooth' ? undefined : MODELS[which]
    const m = pinned ?? SMOOTH
    const worst = ((SYSTEM_V2.length + user.length) / 3) * (m.usdPerMTokIn / 1e6) + m.maxTokens * (m.usdPerMTokOut / 1e6)
    if (calls >= MAX_CALLS || cost + worst > BUDGET_USD) return undefined
    calls++
    try {
      const r = await call({
        pass,
        model: pinned ? pinned.model : SMOOTH_MODEL,
        temperature: m.temperature,
        maxTokens: m.maxTokens,
        system: SYSTEM_V2,
        user,
        schema,
        ...(which === 'smooth' ? { routing: { maxPrice: worst } } : {}),
      })
      cost += r.cost
      if (r.model) models.push(r.model)
      return r.json
    } catch {
      return undefined
    }
  }

  let draft = await ask('draft', `Facts packet:\n${view}\n\nWrite the slots.`, 'draft', slotSchema)
  let verdict = validateSlots(draft, p)
  if (!verdict.ok) {
    const again = await ask('repair', `Facts packet:\n${view}\n\nYour draft:\n${JSON.stringify(draft ?? null)}\n\nFix every problem and answer with the slots again:\n- ${verdict.violations.slice(0, 20).join('\n- ')}`, 'draft', slotSchema)
    if (again === undefined) return floor(`draft failed: ${verdict.violations.slice(0, 3).join('; ')}`)
    draft = again
    verdict = validateSlots(draft, p)
    if (!verdict.ok) return floor(`repair failed: ${verdict.violations.slice(0, 3).join('; ')}`)
  }
  let slots = verdict.slots!

  // Decompose into claims; delete the unanchored ones
  const decomposeAsk = `Facts packet:\n${view}\n\nExplanation in ref form:\n${JSON.stringify({ slots })}\n\nSplit every slot into its atomic claims. For each claim give the slot, its exact text (a substring of the slot text), the fact ids it rests on (from its {ref:…} and NO_THREAT tokens), and its tense: past, present, or none if it states no fact. Cover all the text.`
  // One more try if the claim check times out or fails: it's the check that
  // makes model text servable, so it gets a second chance before the floor
  const decomposed = (await ask('decompose', decomposeAsk, 'lint', CLAIM_SCHEMA)) ?? (await ask('decompose', decomposeAsk, 'lint', CLAIM_SCHEMA))
  if (decomposed === undefined) return floor('claim check unavailable')
  const pruning = prune(slots, decomposed, p)
  if (!pruning) return floor('claim check unreadable')
  if (pruning.total && pruning.removed / pruning.total > PRUNE_MAX) return floor(`${pruning.removed} of ${pruning.total} claims had no fact behind them`)
  if (pruning.removed) {
    slots = pruning.slots
    verdict = validateSlots({ slots }, p)
    if (!verdict.ok) {
      const smooth = await ask('smooth', `Facts packet:\n${view}\n\nSome claims were removed from this explanation. Rejoin the text so it reads well. Keep every {ref:…} token and NO_THREAT exactly, add no facts, and fix these problems:\n- ${verdict.violations.slice(0, 12).join('\n- ')}\n\n${JSON.stringify({ slots })}`, 'smooth', slotSchema)
      verdict = validateSlots(smooth, p)
      if (!verdict.ok) return floor('could not rejoin after removing claims')
      slots = verdict.slots!
    }
  }
  return { slots, source: 'model', calls, cost, models, pruned: pruning.removed }
}

interface Claim {
  slot: string
  text: string
  refs: string[]
  tense: string
}

// Claims with no fact id, an id outside the packet, a mate or threat claim on
// an id that isn't one, or a present-tense claim the position no longer
// supports, are cut from the text
export function prune(slots: Slot[], raw: unknown, p: Packet): { slots: Slot[]; removed: number; total: number } | undefined {
  const claims = (raw as { claims?: Claim[] })?.claims
  if (!Array.isArray(claims)) return undefined
  const anchors = new Set(p.claimAnchors)
  const out = slots.map(s => ({ ...s }))
  let removed = 0
  let total = 0
  for (const c of claims) {
    if (!c || typeof c.text !== 'string' || !Array.isArray(c.refs)) continue
    const s = out.find(x => x.slot === c.slot)
    if (!s || !c.text.trim() || !s.text.includes(c.text)) continue
    if (c.tense === 'none' && !/\{ref:|NO_THREAT/.test(c.text)) continue // connective words, not a claim
    total++
    const inText = [...c.text.matchAll(REF)].map(m => m[1] ?? NO_THREAT_ID)
    const ok = inText.length > 0 && inText.every(r => anchors.has(r)) && bound(c.text, inText, p) && tenseOk(c, inText, p)
    if (ok) continue
    removed++
    s.text = s.text.replace(c.text, ' ').replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim()
  }
  for (const s of out) s.refs = [...new Set([...s.text.matchAll(REF)].map(m => m[1] ?? NO_THREAT_ID))]
  return { slots: out, removed, total }
}

// A mate claim must rest on a mate fact, a threat claim on the threat
function bound(text: string, ids: string[], p: Packet): boolean {
  const moves = movesById(p)
  if (/\b(check)?mat(e|es|ed|ing)\b/i.test(text)) {
    const mateIds = ids.filter(id => moves.get(id)?.mate || id === 'c-mate' || (id === 'threat' && p.threat?.consequence.type === 'mate'))
    if (!mateIds.length) return false
  }
  if (/\bthreat\w*/i.test(text) && !ids.some(id => id === 'threat' || /^t\d+$/.test(id) || id === NO_THREAT_ID)) return false
  return true
}

// "The rook is hanging" must still be true after the move in question
function tenseOk(c: Claim, ids: string[], p: Packet): boolean {
  if (c.tense !== 'present') return true
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

const squareIndex = (sq: string) => (sq.charCodeAt(0) - 97) + (Number(sq[1]) - 1) * 8
