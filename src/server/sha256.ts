// A small synchronous SHA-256 (FIPS 180-4) for the request proof of work:
// the browser tries thousands of counters, and an await per hash through
// WebCrypto would make that slow. The Worker checks with crypto.subtle.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const len = data.length
  const blocks = Math.ceil((len + 9) / 64)
  const buf = new Uint8Array(blocks * 64)
  buf.set(data)
  buf[len] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(buf.length - 8, Math.floor((len * 8) / 2 ** 32))
  view.setUint32(buf.length - 4, (len * 8) >>> 0)
  const w = new Uint32Array(64)
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(b * 64 + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b2, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const t2 = (S0 + ((a & b2) ^ (a & c) ^ (b2 & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b2
      b2 = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a
    h[1] += b2
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  h.forEach((x, i) => ov.setUint32(i * 4, x))
  return out
}

export const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
export const sha256Hex = (text: string) => hex(sha256Bytes(new TextEncoder().encode(text)))

// Leading zero bits of a digest
export function zeroBits(d: Uint8Array): number {
  let n = 0
  for (const byte of d) {
    if (byte === 0) {
      n += 8
      continue
    }
    return n + Math.clz32(byte) - 24
  }
  return n
}

// The proof of work: a counter whose hash with the challenge and the body
// has `bits` leading zero bits
export function solve(nonce: string, bodyHash: string, bits: number, limit = 1 << 24, start = 0): number | undefined {
  const enc = new TextEncoder()
  for (let i = start; i < start + limit; i++) if (zeroBits(sha256Bytes(enc.encode(`${nonce}.${bodyHash}.${i}`))) >= bits) return i
  return undefined
}
