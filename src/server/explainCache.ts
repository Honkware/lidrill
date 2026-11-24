import type { Band } from '../db'
import { EXPLAIN_VERSION } from './explainVersion'
import { canonicalFen } from './gamestate'
import { canonicalJSON, PROMPT_VERSION } from './packet'
import { sha256Hex } from './sha256'

// The explanation cache key gains the solve frame. The frame is a
// pure function of (packet, solving move), and the body already pins the
// packet - v1 by carrying the report, v2 by carrying the packetHash - so the
// solving move stands in the key: same puzzle + band + move → same frame →
// same entry; a different move (a different frame, or another accepted move
// inside the also-good frame) keys its own entry.
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/

export function explainFrameOf(body: string): string {
  let solved: unknown
  try {
    solved = (JSON.parse(body) as { solved?: unknown }).solved
  } catch {
    solved = undefined
  }
  return typeof solved === 'string' && UCI.test(solved) ? solved : 'none'
}

export function explainCacheKey(version: number, body: string): Request {
  return new Request(`https://lidrill.org/api/explain-cache/${sha256Hex(`${version}.${explainFrameOf(body)}.${body}`)}`)
}

// The key of a finished explanation in the packet store: the position, the
// game move, the best move and the band, under the prompt and explanation
// versions so a bump of either starts clean. The wrong try and the solving
// move are in it because they change what the text says. Unlike the entry
// above it doesn't depend on the request body, so a second player with the
// same position, or the same player from another place, gets the stored text.
export function explainStoreKey(k: { fen: string; played?: string; best: string; band: Band; tried?: string; solved?: string }): string {
  return `why/${PROMPT_VERSION}/${EXPLAIN_VERSION}/${sha256Hex(canonicalJSON({ ...k, fen: canonicalFen(k.fen) ?? k.fen }))}`
}
