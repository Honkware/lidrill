// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { issue, POW_BITS, verify } from './guard'
import { sha256Hex, solve } from './sha256'

describe('sha256', () => {
  it('matches the FIPS test vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
  })
})

describe('request proof', () => {
  const secret = 'test-secret'
  const body = '{"schema":"lidrill-report/1"}'
  const prove = async (ip: string, b: string) => {
    const c = await issue(secret, ip)
    const n = solve(c.nonce, sha256Hex(b), c.bits)!
    return `${c.nonce}.${c.exp}.${c.bits}.${c.sig}.${n}`
  }

  it('accepts a solved challenge for this IP and this body', async () => {
    expect(await verify(secret, '1.2.3.4', await prove('1.2.3.4', body), body)).toBeUndefined()
  })

  it('refuses another IP, another body, a missing or expired proof, and a forged signature', async () => {
    const header = await prove('1.2.3.4', body)
    expect(await verify(secret, '5.6.7.8', header, body)).toBe('proof not issued to you')
    expect(await verify(secret, '1.2.3.4', header, `${body} `)).toBe('proof does not match the request')
    expect(await verify(secret, '1.2.3.4', null, body)).toBe('missing proof')
    expect(await verify(secret, '1.2.3.4', header, body, Date.now() + 10 * 60 * 1000)).toBe('expired proof')
    const [n, e, b, , c] = header.split('.')
    expect(await verify(secret, '1.2.3.4', [n, e, b, 'forged', c].join('.'), body)).toBe('proof not issued to you')
    expect(POW_BITS).toBeGreaterThanOrEqual(16)
  })
})
