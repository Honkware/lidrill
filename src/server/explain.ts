// The "Why?" explanation: the client sends what Stockfish found,
// the server turns it into a prompt and asks a model to say it in words.
// Everything here is validated as chess data so the endpoint can't be used
// as a general-purpose chatbot on lidrill's key.

export interface LineFacts {
  san: string[] // from the puzzle position, first move first
  end: string // "mate", "material +3", "material even", ...
  cp?: number // Stockfish's eval after the line's first move, for the side to move at the start
}

export interface ExplainRequest {
  fen: string
  best: LineFacts
  played?: LineFacts // the move the player chose in the game, then the engine's reply line
  holding?: string[] // hold puzzles: every move that would have done
  themes?: string[] // Lichess puzzles
}

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
  return { fen: b.fen, best: b.best, played: b.played, holding: b.holding, themes: b.themes }
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

export const SYSTEM = [
  'You explain chess puzzle answers to improving players.',
  'Use only the facts given: the position, the engine lines and how each line ends.',
  'Never mention a tactic, threat, square or piece that is not shown in those lines.',
  'At most two short sentences and 45 words, plain words, standard algebraic notation, no evaluation numbers, no preamble.',
  'Name the idea (what is won, what is threatened, which strong reply the opponent gets) rather than reciting the moves.',
  'First say why the best move works; then, if a played move is given, what goes wrong with it.',
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

// How a line ends, in words, from the side to move's point of view
export function endWords(end: string, side: 'White' | 'Black'): string {
  if (end === 'mate') return 'checkmate'
  if (end === 'stalemate') return 'stalemate'
  if (end === 'material even') return 'material stays level'
  const n = Number(end.replace(/^material [+−-]/, ''))
  const worth = WORTH[n] ?? `${n} pawns' worth`
  return end.includes('+') ? `${side} ends ${worth} up` : `${side} ends ${worth} down`
}

export function prompt(r: ExplainRequest): string {
  const side = r.fen.split(' ')[1] === 'w' ? 'White' : 'Black'
  const end = (l: LineFacts) => [endWords(l.end, side), l.cp !== undefined && l.end !== 'mate' ? `engine: ${verdict(l.cp, side)}` : ''].filter(Boolean).join('; ')
  const parts = [`Position (FEN): ${r.fen}`, `${side} to move.`]
  if (r.holding?.length) parts.push(`Any of these moves keeps the position: ${r.holding.join(', ')}. Engine line with the first: ${numbered(r.fen, r.best.san)} (${end(r.best)}).`)
  else parts.push(`Best move: ${r.best.san[0]}. Engine line: ${numbered(r.fen, r.best.san)} (${end(r.best)}).`)
  if (r.played) parts.push(`The player chose ${r.played.san[0]}. Engine line after it: ${numbered(r.fen, r.played.san)} (${end(r.played)}).`)
  if (r.themes?.length) parts.push(`Lichess tags this puzzle: ${r.themes.join(', ')}.`)
  return parts.join('\n')
}

// OpenRouter's auto router on its low tier, picking among fast models that
// answer directly (about $0.0001 per explanation when tested). DeepSeek V4.1
// Flash was dropped: it reasons at length and ran out of tokens mid-sentence.
export function openRouterBody(r: ExplainRequest) {
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
    ],
  }
}
