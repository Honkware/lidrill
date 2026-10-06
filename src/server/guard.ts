import { sha256Bytes, zeroBits } from './sha256'

// Binding requests to the endpoint: the Origin header is not
// a boundary, so every explanation request carries a challenge the Worker
// signed for this IP a few minutes ago, plus a proof of work over the exact
// request body. A script has to pay a hash search per request, can't reuse a
// challenge for another body, and replays of the same body hit the cache.

export const POW_BITS = 16
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

const enc = new TextEncoder()

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export interface Challenge {
  nonce: string
  exp: number
  bits: number
  sig: string
}

export async function issue(secret: string, ip: string, now = Date.now()): Promise<Challenge> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('')
  const exp = now + CHALLENGE_TTL_MS
  return { nonce, exp, bits: POW_BITS, sig: await hmac(secret, `${nonce}.${exp}.${POW_BITS}.${ip}`) }
}

// Header: nonce.exp.bits.sig.counter
export async function verify(secret: string, ip: string, header: string | null, body: string, now = Date.now()): Promise<string | undefined> {
  if (!header) return 'missing proof'
  const [nonce, expS, bitsS, sig, counterS] = header.split('.')
  const exp = Number(expS)
  const bits = Number(bitsS)
  if (!nonce || !sig || !Number.isFinite(exp) || bits !== POW_BITS || !/^\d{1,9}$/.test(counterS ?? '')) return 'malformed proof'
  if (exp < now || exp > now + CHALLENGE_TTL_MS + 1000) return 'expired proof'
  if ((await hmac(secret, `${nonce}.${exp}.${bits}.${ip}`)) !== sig) return 'proof not issued to you'
  const bodyHash = [...sha256Bytes(enc.encode(body))].map(b => b.toString(16).padStart(2, '0')).join('')
  if (zeroBits(sha256Bytes(enc.encode(`${nonce}.${bodyHash}.${counterS}`))) < bits) return 'proof does not match the request'
  return undefined
}
