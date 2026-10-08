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
