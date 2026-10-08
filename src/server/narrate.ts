import { templateFloor } from './floor'
import { fromFen } from './facts'
import { solvingRefOf, type Packet, type SetMembership } from './packet'
import { STYLE_WORDS } from './readability'
import { movesById, gameFrameIds, NO_THREAT_ID, REF, renderRef, SLOTS, type Slot } from './render'
import { MISS_FRAME, requiredFor, validateSlots, type FrameContext } from './slots'

// The narrator. A cheap model drafts the
// four slots in ref form; the mechanical validator decides; one repair try;
// then a temperature-0 pass splits the draft into claims and any claim not
// tied to a fact id is deleted (never repaired); a smoothing pass may rejoin
// what's left. Anything that fails, or runs past the budget, gets the floor.
// The draft is validated in the solve frame - how the player solved
// the puzzle (best | set | miss) selects what the slots must do.

export interface LlmCall {
  pass: 'draft' | 'repair' | 'decompose' | 'smooth'
  model: string
  temperature: number
  maxTokens: number
  system: string
  user: string
  schema: Record<string, unknown>
  // Set for auto-router calls (smooth only): the per-million-token price cap
  // the budget check reserved with, enforced on the wire as
  // provider.max_price = { prompt, completion }
  routing?: { usdPerMTokIn: number; usdPerMTokOut: number }
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
  // Measured: haiku truncates at 2000 (finish_reason "length" -
  // 3 of 20 decompose calls, some with the whole budget spent before any
  // content). 4000 leaves the prune untouched; it only gives the claim
  // check room to finish. Gate re-runs on this change.
  lint: { model: 'anthropic/claude-haiku-4.5', temperature: 0, maxTokens: 4000, usdPerMTokIn: 1, usdPerMTokOut: 5 },
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
  'Three beats, then stop: beat 1 (whatHappened) - the move made in the game and its category, or the player\'s try in this puzzle when one is recorded, then the best move in this position with its certified consequence in one clause. Beat 2 (why) - the mechanism that makes the best move work, each claim anchored to the fact that proves it. Beat 3 (pattern, nextTime) - the one certified term and the trigger habit. The explanation ends at the move: no imagined future, no moves beyond the certified line.',
  'The puzzle position - the one the player just faced and tried moves in - is the default frame: a claim about it needs no marker. Facts tagged "frame":"game" in the list happened in the original game ({ref:played}, {ref:swing}, the pl… and c-punish ids): introduce them with wording like "in the game" or "the game move", never as moves made in the puzzle. Bare "in the game" with no game fact in the same sentence is a violation: call the position "this position" or "here".',
  'You never write a chess move, square, number or piece-on-square yourself. Every fact is a fact id from the list; write it as {ref:<id>} and the app inserts the exact words. Write NO_THREAT only where the list says it is allowed.',
  'List every id you use in that slot\'s refs, and no others.',
  'Use only the fact ids given, each with the meaning shown. Add no plans, ideas or patterns that are not facts in the list.',
  'One-term rule: name at most one chess term (fork, pin, removing the defender…) in the whole explanation, exactly once, in the pattern slot. Everywhere else name concrete pieces and squares by fact id; stacked jargon ("deflection-decoy-overload") fails.',
  'Trigger-anchor rule: a claim about an abstract idea (pressure, space, the initiative) must carry the fact id that makes it true in the same sentence; if no fact proves it, leave it out.',
  'Stay under the word budget the packet gives for the whole rendered explanation. Short sentences, subject-verb-object first, no stacked subordinate clauses.',
  'whatHappened: the move made here and what it cost - the player\'s try in this puzzle when one is recorded, otherwise the original game move, marked as game context. why: the mechanism, using the required ids and enough line steps. pattern: the certified pattern and its library text - open the pattern slot with the position-anchored instance (at least one packet ref that is not library text: the move, square or certificate that makes it true), then the definition ref; a bare definition with no position ref fails. Render each magnitude once: one swing, one bucket - never restate the same amount in a second phrasing or a parenthetical. nextTime: the habit id, nothing else of substance.',
  'solve frames - the input says which: best - the player found the engine\'s best move: whatHappened opens by crediting it ({ref:best}), then explain that move on its merits. also-good - the player\'s move is in the acceptance set: open whatHappened with "Your move works.", name the solving move ({ref:alt1}…) and why it is sound, then name the engine\'s first choice ({ref:best}) with the certified gap ({ref:c-acc1}, "worth about … more"). miss - the contrast frame: the game move (or try) and what it cost, then "Best was: {ref:best}".',
  'tokens: "Answer:" is retired everywhere - with an acceptance set there is no single answer; the miss frame labels best "Best was:". "cost you" is legal only in the miss frame - never in best or also-good.',
  'Ownership: say "you"/"your" for the player\'s moves and patterns and "they"/"their" for the opponent\'s, right before the id, in the same sentence. Amounts like {ref:swing} take no "your". V-POV: a possessive attaches only to the game move ({ref:played}); the answer and its line are not yours yet - no "your" on them.',
  'V-LINE: line steps beyond the answer are evidence, and evidence ends at the certified consequence - the capture, mate or certified amount that decides the line. Never run the line past the answer mid-hunt; when the consequence is certified, stop there.',
  'Certificate ids (c-…) render as a whole clause, like "every other move is at least 0.8 pawns worse": put them after a colon or after "because", never inside a phrase.',
  'Only say the answer stops, prevents or meets the threat if c-stops is in the list; only say a move was forced, needed or the only move if c-forced is.',
  'Plain, short sentences. No praise, no labels like brilliant, no rhetorical questions, no exclamation marks. Do not open a sentence with This, That, It or Such used as a pronoun.',
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

export const CLAIM_SCHEMA = {
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
// The solve frame travels with it - how the puzzle was solved
// selects what the slots must do.
export function promptView(p: Packet, frame: FrameContext = MISS_FRAME) {
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
  const accCert = frame.solvingRef ? p.certificates.find(c => c.type === 'acceptance' && c.subject === frame.solvingRef) : undefined
  const whatByFrame =
    frame.membership === 'best'
      ? `the move the player just solved with - credit it: {ref:best} is the engine's best move and they found it. No "cost you", no "Best was:".`
      : frame.membership === 'set'
        ? `the move the player just solved with - open with "Your move works.", name it (${frame.solvingRef ? `{ref:${frame.solvingRef}}` : 'its fact id'}) and why it holds up${accCert ? `, then the engine's first choice {ref:best} with the certified gap {ref:${accCert.id}}` : ', then the engine\'s first choice {ref:best}'}: "worth about … more". No "cost you".`
        : p.tried
          ? 'about the move the player tried in this puzzle'
          : p.played
            ? 'about the original game move, as game context ("in the game")'
            : 'about the answer'
  return {
    level: p.context.band,
    // Style economy: the whole rendered explanation stays under this
    wordBudget: STYLE_WORDS[p.context.band],
    puzzleType: p.didactic.puzzleType,
    youPlay: p.position.playerColor,
    verdictBefore: p.eval.verdict.before,
    verdictAfterGameMove: p.eval.verdict.afterPlayed,
    // The solve frame and the solving move's set membership
    solve: { membership: frame.membership, move: frame.solvingRef ?? null, acceptanceSet: p.acceptanceSet },
    // The puzzle position is the default frame; game facts must be marked
    whatHappened: whatByFrame,
    nextTime: p.didactic.habitSlotId ? 'the habit fact' : 'omit this slot entirely: no habit fits this position',
    lines: {
      answer: p.best.pv.map(m => m.id),
      gameMove: p.played ? ['played', ...p.played.reply.map(r => r.id)] : undefined,
      yourTry: p.tried ? ['tried', ...p.tried.reply.map(r => r.id)] : undefined,
      theirThreat: p.threat ? ['threat', ...p.threat.line.slice(1).map(m => m.id)] : undefined,
    },
    threat: p.threatStatus === 'certified' ? 'use {ref:threat} in why' : p.threatStatus === 'certifiedNull' ? 'there is no threat: write NO_THREAT in why' : p.position.check.before ? 'the player was in check: use {ref:check} in why' : 'unknown',
    facts,
    required: Object.fromEntries(SLOTS.map(s => [s, requiredFor(p, frame)[s].map(r => r.split('|').join(' or '))])),
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
  frame: FrameContext['membership']
}

// How the puzzle was solved - the solving move and its set
// membership, carried in the narrator input (best | set | miss)
export interface SolveInput {
  move?: string
  membership: SetMembership
}

// Decompose into claims; the exact ask the flake loop replays (scripts/
// decompose-flake-loop.mjs) - one definition so the instrumented run and the
// production pass can never drift
export function decomposeAskFor(view: string, slots: Slot[]): string {
  return `Facts packet:\n${view}\n\nExplanation in ref form:\n${JSON.stringify({ slots })}\n\nSplit every slot into its atomic claims. For each claim give the slot, its exact text (a substring of the slot text), the fact ids it rests on (from its {ref:…} and NO_THREAT tokens), and its tense: past, present, or none if it states no fact. Cover all the text.`
}

export async function narrate(p: Packet, call: Caller, solve: SolveInput = { membership: 'miss' }): Promise<Narration> {
  let calls = 0
  let cost = 0
  const models: string[] = []
  const frame: FrameContext = { membership: solve.membership, solvingRef: solvingRefOf(solve.move, p) }
  const floor = (reason: string): Narration => ({ slots: templateFloor(p, frame), source: 'floor', reason, calls, cost, models, frame: frame.membership })
  if (p.meta.certification.status !== 'certified') return floor(`not certified: ${p.meta.certification.refusals.join('; ')}`)
  // The pattern slot must name a certified term. A quiet
  // position with a certified threat names the meeting-the-threat gloss; one
  // with nothing certified floors by design until the library grows
  // strategic entries (outpost, weak square…)
  if (!p.didactic.motifCert && !p.certificates.some(c => c.type === 'mate') && p.threatStatus !== 'certified')
    return floor('no certified term for the pattern slot')
  // A direct mate ends the game at the move: an uncertified threat can't
  // matter, so it is no longer a floor reason
  if (p.threatStatus === 'uncertified' && !p.position.check.before && p.best.mateIn !== 1) return floor('threat not certified')

  const view = JSON.stringify(promptView(p, frame))
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
        ...(which === 'smooth' ? { routing: { usdPerMTokIn: m.usdPerMTokIn, usdPerMTokOut: m.usdPerMTokOut } } : {}),
      })
      cost += r.cost
      if (r.model) models.push(r.model)
      return r.json
    } catch {
      return undefined
    }
  }

  let draft = await ask('draft', `Facts packet:\n${view}\n\nWrite the slots.`, 'draft', slotSchema)
  let verdict = validateSlots(draft, p, frame)
  if (!verdict.ok) {
    const again = await ask('repair', `Facts packet:\n${view}\n\nYour draft:\n${JSON.stringify(draft ?? null)}\n\nFix every problem and answer with the slots again:\n- ${verdict.violations.slice(0, 20).join('\n- ')}`, 'draft', slotSchema)
    if (again === undefined) return floor(`draft failed: ${verdict.violations.slice(0, 3).join('; ')}`)
    draft = again
    verdict = validateSlots(draft, p, frame)
    if (!verdict.ok) return floor(`repair failed: ${verdict.violations.slice(0, 3).join('; ')}`)
  }
  let slots = verdict.slots!

  // Decompose into claims; delete the unanchored ones
  // One more try if the claim check times out or fails: it's the check that
  // makes model text servable, so it gets a second chance before the floor
  const decomposed = (await ask('decompose', decomposeAskFor(view, slots), 'lint', CLAIM_SCHEMA)) ?? (await ask('decompose', decomposeAskFor(view, slots), 'lint', CLAIM_SCHEMA))
  if (decomposed === undefined) return floor('claim check unavailable')
  const pruning = prune(slots, decomposed, p)
  if (!pruning) return floor('claim check unreadable')
  if (pruning.total && pruning.removed / pruning.total > PRUNE_MAX) return floor(`${pruning.removed} of ${pruning.total} claims had no fact behind them`)
  if (pruning.removed) {
    slots = pruning.slots
    verdict = validateSlots({ slots }, p, frame)
    if (!verdict.ok) {
      const smooth = await ask('smooth', `Facts packet:\n${view}\n\nSome claims were removed from this explanation. Rejoin the text so it reads well. Keep every {ref:…} token and NO_THREAT exactly, add no facts, and fix these problems:\n- ${verdict.violations.slice(0, 12).join('\n- ')}\n\n${JSON.stringify({ slots })}`, 'smooth', slotSchema)
      verdict = validateSlots(smooth, p, frame)
      if (!verdict.ok) return floor('could not rejoin after removing claims')
      slots = verdict.slots!
    }
  }
  return { slots, source: 'model', calls, cost, models, pruned: pruning.removed, frame: frame.membership }
}

interface Claim {
  slot: string
  text: string
  refs: string[]
  tense: string
}

// Claims with no fact id, an id outside the packet, a mate or threat claim on
// an id that isn't one, an orphaned magnitude, or a
// present-tense claim the position no longer supports, are cut from the text
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
    const ok =
      inText.length > 0 && inText.every(r => anchors.has(r)) && bound(c.text, inText, p) && tenseOk(c, inText, p) && magnitudeOk(c.text, inText, p)
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
    const mateIds = ids.filter(id => moves.get(id)?.mate || id === 'c-mate' || id === 'c-mate-net' || (id === 'threat' && p.threat?.consequence.type === 'mate'))
    if (!mateIds.length) return false
  }
  if (/\bthreat\w*/i.test(text) && !ids.some(id => id === 'threat' || /^t\d+$/.test(id) || id === NO_THREAT_ID)) return false
  return true
}

// V-SWING: a magnitude ("lost 3.7 pawns", "won material") must bind
// to the capture, swing, threat or line certificate that produces it - an
// orphaned magnitude is pruned, never served. Written-out numbers are
// already impossible (notation lint), so this catches the shape "that won
// material." resting on a move ref that certifies no amount.
const MAGNITUDE = /\b(pawns?|material|worth|extra)\b/i
function magnitudeOk(text: string, ids: string[], p: Packet): boolean {
  if (!MAGNITUDE.test(text)) return true
  return ids.some(id => {
    if (id === 'swing' || id === 'tryswing' || id === 'material' || id === 'threat' || /^t\d+$/.test(id)) return true
    const cert = p.certificates.find(c => c.id === id)
    return !!cert && (cert.type === 'tactical' || cert.type === 'stopsThreat' || cert.type === 'forced' || cert.type === 'acceptance' || cert.type === 'mate')
  })
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
