import { Chess } from 'chessops/chess'
import { parseSan } from 'chessops/san'
import type { Color, Role } from 'chessops/types'
import { makeSquare } from 'chessops/util'
import { fromFen, looseList, passFen, pieceName, replay, setting, type LineReplay, type PlayedMove } from './facts'
import { isSquare, tokens } from './tokens'
// The "Why?" explanation: the client sends what Stockfish found,
// the server turns it into a prompt and asks a model to say it in words.
// Everything here is validated as chess data so the endpoint can't be used
// as a general-purpose chatbot on lidrill's key.

export interface LineFacts {
  san: string[] // from the puzzle position, first move first
  end: string // "mate", "material +3", "material even", ...
  cp?: number // Stockfish's eval after the line's first move, for the side to move at the start
}

export type PuzzleKind = 'missed-win' | 'hang' | 'conversion' | 'hold' | 'defensive' | 'lichess'

export interface ExplainRequest {
  fen: string
  best: LineFacts
  played?: LineFacts // the move the player chose in the game, then the engine's reply line
  threat?: LineFacts // what the opponent would play if it were their move (from passFen)
  holding?: string[] // hold puzzles: every move that would have done
  themes?: string[] // Lichess puzzles
  kind?: PuzzleKind
}

const KINDS: PuzzleKind[] = ['missed-win', 'hang', 'conversion', 'hold', 'defensive', 'lichess']

const SAN = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/
const FEN = /^[pnbrqkPNBRQK1-8/]{15,90} [wb] (?:-|[KQkq]{1,4}) (?:-|[a-h][36]) \d{1,3} \d{1,4}$/
const END = /^(?:mate|stalemate|material (?:even|[+−-]\d{1,2}))$/
const THEME = /^[a-zA-Z]{2,32}$/

const line = (l: unknown): l is LineFacts =>
  !!l &&
  typeof l === 'object' &&
  Array.isArray((l as LineFacts).san) &&
  (l as LineFacts).san.length >= 1 &&
  (l as LineFacts).san.length <= 16 &&
  (l as LineFacts).san.every(s => typeof s === 'string' && SAN.test(s)) &&
  typeof (l as LineFacts).end === 'string' &&
  END.test((l as LineFacts).end) &&
  ((l as LineFacts).cp === undefined || (Number.isFinite((l as LineFacts).cp) && Math.abs((l as LineFacts).cp!) <= 10000))

export function validate(body: unknown): ExplainRequest | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as ExplainRequest
  if (typeof b.fen !== 'string' || !FEN.test(b.fen) || !line(b.best)) return undefined
  if (b.played !== undefined && !line(b.played)) return undefined
  if (b.holding !== undefined && !(Array.isArray(b.holding) && b.holding.length <= 4 && b.holding.every(s => typeof s === 'string' && SAN.test(s)))) return undefined
  if (b.themes !== undefined && !(Array.isArray(b.themes) && b.themes.length <= 12 && b.themes.every(t => typeof t === 'string' && THEME.test(t)))) return undefined
  if (b.threat !== undefined && !line(b.threat)) return undefined
  if (b.kind !== undefined && !KINDS.includes(b.kind)) return undefined
  // Every line has to replay legally from its position
  if (!replay(b.fen, b.best.san) || (b.played && !replay(b.fen, b.played.san))) return undefined
  if (b.holding && b.holding.some(h => !replay(b.fen, [h]))) return undefined
  if (b.threat) {
    const pass = passFen(b.fen)
    if (!pass || !replay(pass, b.threat.san)) return undefined
  }
  return { fen: b.fen, best: b.best, played: b.played, threat: b.threat, holding: b.holding, themes: b.themes, kind: b.kind }
}

// "6. Bxf7+ Ke7 7. Nd5#" from the FEN's move number and side
export function numbered(fen: string, san: string[]): string {
  const [, turn, , , , full] = fen.split(' ')
  let n = Number(full)
  let white = turn === 'w'
  const out: string[] = []
  san.forEach((s, i) => {
    if (white) out.push(`${n}.`)
    else if (i === 0) out.push(`${n}...`)
    out.push(s)
    if (!white) n++
    white = !white
  })
  return out.join(' ')
}

// Bumped whenever the points, checks or wording change, so explanations saved
// in browsers by older logic are asked for again
export const EXPLAIN_VERSION = 6

export const SYSTEM = [
  'You explain chess puzzle answers to improving players.',
  'You get the position, checked facts, Stockfish lines with checked notes in brackets, and the points to explain.',
  'Explain the points, in that order where you can. Add nothing else: no other moves, squares, pieces, plans or ideas.',
  'At most two short sentences and 50 words, plain words, no evaluation numbers, no preamble.',
  'Write moves exactly as they appear in the lines (e.g. Nf3, exd5, O-O) without move numbers, and squares as a lowercase file and rank (e.g. e4).',
].join(' ')

const WORTH: Record<number, string> = { 1: 'a pawn', 2: 'two pawns', 3: 'a piece', 4: 'a piece and a pawn', 5: 'a rook', 6: 'a rook and a pawn', 8: 'a rook and a piece', 9: 'a queen' }

// Stockfish's verdict in words, side to move's point of view
export function verdict(cp: number, side: 'White' | 'Black'): string {
  const other = side === 'White' ? 'Black' : 'White'
  const a = Math.abs(cp)
  if (a < 50) return 'about equal'
  const who = cp > 0 ? side : other
  return a >= 500 ? `${who} is winning` : a >= 200 ? `${who} is clearly better` : `${who} is a little better`
}

// "White a little better", "it about equal": for "the engine has ..."
export function verdictPhrase(cp: number, side: 'White' | 'Black'): string {
  const v = verdict(cp, side)
  return v === 'about equal' ? 'it about equal' : v.replace(' is ', ' ')
}

// How a line ends, in words, from the side to move's point of view
export function endWords(end: string, side: 'White' | 'Black'): string {
  if (end === 'mate') return 'checkmate'
  if (end === 'stalemate') return 'stalemate'
  if (end === 'material even') return 'material stays level'
  const n = Number(end.replace(/^material [+−-]/, ''))
  const worth = WORTH[n] ?? `${n} pawns' worth`
  return end.includes('+') ? `${side} ends ${worth} up` : `${side} ends ${worth} down`
}

const KIND_WORDS: Record<PuzzleKind, string> = {
  'missed-win': 'From the player\'s own game: they missed a winning move.',
  hang: 'From the player\'s own game: their move there gave material away.',
  conversion: 'From the player\'s own game: they were winning and let it slip.',
  hold: 'From the player\'s own game: their move lost material; several moves would have held.',
  defensive: 'From the player\'s own game: they were worse and needed the one defence.',
  lichess: 'A Lichess puzzle.',
}

export interface Analysis {
  pos: Chess
  side: 'White' | 'Black'
  opp: 'White' | 'Black'
  best: LineReplay
  played?: LineReplay
  threat?: LineReplay
  holding: PlayedMove[]
  stopsThreat: boolean
  points: string[]
  // What the text may mention
  moves: Map<string, PlayedMove[]> // bare SAN -> every place it's played (best line first)
  squares: Set<string>
  captured: Set<Role>
  loose: Set<Role>
  mate: boolean
}

const capturesBy = (l: LineReplay, color: Color) => l.moves.filter(m => m.color === color && m.captured)

const PLURAL: Record<Role, string> = { pawn: 'pawns', knight: 'knights', bishop: 'bishops', rook: 'rooks', queen: 'queens', king: 'kings' }
const NUM = ['', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
const ORDER: Role[] = ['queen', 'rook', 'bishop', 'knight', 'pawn']
const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 }

function count(roles: Role[]): string {
  return ORDER.filter(r => roles.includes(r))
    .map(r => {
      const n = roles.filter(x => x === r).length
      return n === 1 ? `a ${pieceName(r)}` : `${NUM[n] ?? n} ${PLURAL[r]}`
    })
    .join(' and ')
}

export interface Net {
  words: string // "wins a rook for a knight", "trades queens and wins a pawn", "" if nothing changes hands
  key?: PlayedMove // the capture that matters most, for the text and its link
  gain: number // material for `color`, captures minus losses
}

// What changes hands in a line for `color`, with like-for-like captures
// cancelled: "Black trades queens and wins a pawn", not "takes the queen
// and gives up the queen"
export function net(l: LineReplay, color: Color): Net {
  const mine = l.moves.filter(m => m.color === color && m.captured).map(m => m.captured!)
  const theirs = l.moves.filter(m => m.color !== color && m.captured).map(m => m.captured!)
  const traded: Role[] = []
  for (const r of [...mine]) {
    const i = theirs.indexOf(r)
    if (i >= 0) {
      theirs.splice(i, 1)
      mine.splice(mine.indexOf(r), 1)
      traded.push(r)
    }
  }
  const promo = l.moves.filter(m => m.promotion).reduce((g, m) => g + (m.color === color ? 1 : -1) * (VALUE[m.promotion!] - 1), 0)
  const gain = mine.reduce((g, r) => g + VALUE[r], 0) - theirs.reduce((g, r) => g + VALUE[r], 0) + promo
  const tradedQueens = traded.includes('queen') ? 'trades queens and ' : ''
  const top = ORDER.find(r => mine.includes(r))
  const key = top ? l.moves.find(m => m.color === color && m.captured === top) : undefined
  let words = ''
  if (mine.length && theirs.length) words = `${tradedQueens}wins ${count(mine)} for ${count(theirs)}`
  else if (mine.length) words = `${tradedQueens}wins ${count(mine)}`
  else if (theirs.length) words = `${tradedQueens}loses ${count(theirs)}`
  return { words, key, gain }
}

// "wins a rook" -> "win a rook", for "lets Black ..."
export const baseForm = (words: string) => words.replace(/\b(wins|loses|trades)\b/g, w => w.slice(0, -1))

// "Bxc5 Qxc5": the captures of a line in order
const trade = (l: LineReplay) => l.moves.filter(m => m.captured).slice(0, 4).map(m => m.san).join(' ')

// Does the threat still work after the best move? It's stopped if the
// threatening move is no longer legal, or no longer mates, or no longer
// takes the same piece on the same square.
function threatStopped(best: LineReplay, threat: LineReplay): boolean {
  const t = threat.moves[0]
  const after = best.positions[0]
  const move = parseSan(after.clone(), t.bare)
  if (!move || !('from' in move)) return true
  const pos = after.clone()
  const victim = pos.board.get(move.to)
  pos.play(move)
  if (t.mate) return !pos.isCheckmate()
  if (t.captured) return !victim || victim.role !== t.captured || makeSquare(move.to) !== t.capturedOn
  return false
}

export function analyse(r: ExplainRequest): Analysis {
  const pos = fromFen(r.fen)!
  const me: Color = pos.turn
  const side = me === 'white' ? 'White' : 'Black'
  const opp = me === 'white' ? 'Black' : 'White'
  const best = replay(r.fen, r.best.san)!
  const played = r.played ? replay(r.fen, r.played.san) : undefined
  const pass = r.threat ? passFen(r.fen) : undefined
  const threat = pass && r.threat ? replay(pass, r.threat.san) : undefined
  const holding = (r.holding ?? []).map(h => replay(r.fen, [h])!.moves[0])
  const serious = threat && (threat.moves[0].mate || threat.moves[0].captured)
  const stopsThreat = !!(serious && threatStopped(best, threat!))

  // The points, in the order a coach would make them
  const points: string[] = []
  const b0 = best.moves[0]
  if (holding.length > 1) points.push(`Any of ${holding.map(h => h.san).join(', ')} keeps the position.`)
  if (serious && stopsThreat) {
    const t = threat!.moves[0]
    points.push(`${opp} threatened ${t.san} (${t.mate ? 'checkmate' : `taking the ${pieceName(t.captured!)} on ${t.capturedOn}`}); ${b0.san} stops it.`)
  }
  const bestMate = best.moves.find(m => m.mate)
  if (bestMate) points.push(`${b0.san} leads to checkmate: ${best.moves.slice(0, best.moves.indexOf(bestMate) + 1).map(m => m.san).join(' ')}.`)
  else {
    if (b0.fork) points.push(`After ${b0.san}, ${b0.fork}.`)
    const n = net(best, me)
    const verdictText = r.best.cp !== undefined ? ` the engine has ${verdictPhrase(r.best.cp, side)}` : ''
    if (n.words && n.gain > 0) points.push(`In the line ${side} ${n.words}${n.key ? ` (${n.key.san})` : ''}.`)
    // The best line can still cost something (defences): say it's the best try
    else if (n.words && n.gain < 0) points.push(`Even after ${b0.san} ${side} ${n.words}, but every other move is worse.`)
    else if (n.words || capturesBy(best, me).length) {
      // Captures that cancel out are a trade, not a gain
      if (!points.length) points.push(`${b0.san} leads to a trade (${trade(best)}), material stays level and${verdictText || ' it stays balanced'}.`)
    } else if (!points.length) {
      const reply = best.moves[1]
      points.push(`${b0.san} is a quiet move${reply ? `; after ${reply.san}` : ''}${verdictText || ', material stays level'}.`)
    }
  }
  let looseRoles: Role[] = []
  if (played) {
    const p0 = played.moves[0]
    const mate = played.moves.find(m => m.mate)
    const theirs = net(played, me === 'white' ? 'black' : 'white')
    if (mate) points.push(`${p0.san} allows ${played.moves.slice(1, played.moves.indexOf(mate) + 1).map(m => m.san).join(' ')}, checkmate.`)
    else if (theirs.words && theirs.gain > 0) points.push(`${p0.san} lets ${opp} ${baseForm(theirs.words)}${theirs.key ? ` (${theirs.key.san})` : ''}.`)
    else if (capturesBy(played, me === 'white' ? 'black' : 'white').length)
      points.push(`After ${p0.san} the line trades (${trade(played)})${r.played!.cp !== undefined ? ` and the engine has ${verdictPhrase(r.played!.cp, side)}` : ', material stays level'}.`)
    else {
      const left = looseList(played.positions[0], me)
      looseRoles = left.map(l => l.role)
      if (left.length) points.push(`After ${p0.san}, ${left[0].text}.`)
      else if (r.played!.cp !== undefined) {
        const reply = played.moves[1]
        points.push(`After ${p0.san}${reply ? `, ${opp} answers ${reply.san}` : ''} and the engine has ${verdictPhrase(r.played!.cp, side)}.`)
      }
    }
  }

  const moves = new Map<string, PlayedMove[]>()
  const add = (m: PlayedMove) => moves.set(m.bare, [...(moves.get(m.bare) ?? []), m])
  for (const l of [best, played, threat].filter(Boolean) as LineReplay[]) l.moves.forEach(add)
  for (const h of holding) if (!moves.get(h.bare)?.some(m => m.fenBefore === h.fenBefore)) add(h)
  const squares = new Set<string>()
  for (const m of [...moves.values()].flat()) {
    squares.add(m.from).add(m.to)
    if (m.capturedOn) squares.add(m.capturedOn)
  }
  for (const pt of points) for (const sq of pt.match(/\b[a-h][1-8]\b/g) ?? []) squares.add(sq)
  const all = [best, played, threat].filter(Boolean) as LineReplay[]
  return {
    pos,
    side,
    opp,
    best,
    played,
    threat,
    holding,
    stopsThreat,
    points,
    moves,
    squares,
    captured: new Set(all.flatMap(l => l.moves.map(m => m.captured).filter((x): x is Role => !!x))),
    loose: new Set(looseRoles),
    mate: all.some(l => l.moves.some(m => m.mate)),
  }
}

export function prompt(r: ExplainRequest, a = analyse(r)): string {
  const parts = [`Position (FEN): ${r.fen}`, `${a.side} to move. ${setting(a.pos)}`]
  if (r.kind) parts.push(KIND_WORDS[r.kind])
  if (r.themes?.length) parts.push(`Lichess tags this puzzle: ${r.themes.join(', ')}.`)
  if (a.threat) parts.push(`If ${a.side} passed, ${a.opp} would play: ${a.threat.annotated}.`)
  parts.push(`Best line: ${a.best.annotated}.`)
  if (a.played) parts.push(`Line after the player's move: ${a.played.annotated}.`)
  parts.push(`Points to explain:\n${a.points.map(p => `- ${p}`).join('\n')}`)
  return parts.join('\n')
}

export interface Check {
  ok: boolean
  problems: string[]
}

const CLAIM = /\b(wins?|winning|won|takes?|taking|took|captures?|capturing|captured|grabs?|loses?|losing|lost|drops?|hangs?|hanging|gives? up|giving up)\b([^.;]{0,40}?)\b(queen|rook|bishop|knight|pawn)s?\b/gi

// Everything the text names has to come from the facts
export function check(text: string, a: Analysis): Check {
  const problems: string[] = []
  const words = text.trim().split(/\s+/).length
  if (words > 65) problems.push(`it is ${words} words; keep it under 50`)
  if (/\b\d+\.(?:\.\.)?\s?(?:[KQRBN]|[a-h][1-8x]|O-O)/.test(text)) problems.push('it uses move numbers; write the moves without them')
  for (const t of tokens(text)) {
    if (a.moves.has(t.san)) continue
    if (isSquare(t.san) && a.squares.has(t.san)) continue
    problems.push(`${t.text} is not in the lines`)
  }
  for (const m of text.matchAll(CLAIM)) {
    const role = m[3].toLowerCase() as Role
    if (!a.captured.has(role) && !a.loose.has(role)) problems.push(`no ${role} is taken or loose in the lines`)
  }
  if (/\b(check)?mates?\b|\bmating\b/i.test(text) && !a.mate) problems.push('there is no mate in the lines')
  if (/\b(prevents?|preventing|stops?|stopping|parr(?:y|ies)|threat\w*)\b/i.test(text) && !a.stopsThreat)
    problems.push('only say a threat is stopped when the points say so')
  return { ok: problems.length === 0, problems: [...new Set(problems)] }
}

// The checked points themselves, when the model can't get it right
export function fallback(a: Analysis): string {
  return a.points.slice(0, 2).join(' ')
}

export interface Link {
  index: number // where the token starts in the text
  text: string
  from?: string
  to: string
  fen?: string // the position the move is played from
  after?: string // and the position it leads to
}

// One link per move or square in the text. A SAN can occur more than once
// in the lines (Black's hxg5, then White's hxg5#), so each mention takes the
// next occurrence in reading order.
export function links(text: string, a: Analysis): Link[] {
  const used = new Map<string, number>()
  const out: Link[] = []
  for (const t of tokens(text)) {
    const all = a.moves.get(t.san)
    if (all?.length) {
      const i = used.get(t.san) ?? 0
      const m = all[Math.min(i, all.length - 1)]
      used.set(t.san, i + 1)
      out.push({ index: t.index, text: t.text, from: m.from, to: m.to, fen: m.fenBefore, after: m.fenAfter })
    } else if (isSquare(t.san) && a.squares.has(t.san)) out.push({ index: t.index, text: t.text, to: t.san })
  }
  return out
}

// OpenRouter's auto router on its low tier, picking among fast models that
// answer directly (about $0.0001 per explanation when tested). DeepSeek V4.1
// Flash was dropped: it reasons at length and ran out of tokens mid-sentence.
export function openRouterBody(r: ExplainRequest, retry: { role: 'assistant' | 'user'; content: string }[] = []) {
  return {
    model: 'openrouter/auto',
    plugins: [
      {
        id: 'auto-router',
        cost_tier: 'low',
        allowed_models: ['google/gemini-3.8-flash', 'openai/gpt-5.6-luna', 'anthropic/claude-sonnet-5.5'],
      },
    ],
    max_tokens: 600,
    reasoning: { effort: 'low', exclude: true },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt(r) },
      ...retry,
    ],
  }
}
