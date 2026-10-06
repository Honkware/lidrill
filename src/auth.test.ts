import { beforeEach, describe, expect, it, vi } from 'vitest'
import { challengeFor, finishSignIn, signOut } from './auth'
import { db } from './db'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function landOnRedirect(query: string, saved = { verifier: 'v'.repeat(43), state: 'abc' }) {
  sessionStorage.setItem('lidrill.oauth', JSON.stringify(saved))
  history.replaceState(null, '', `/auth?${query}`)
}

beforeEach(async () => {
  await db.auth.clear()
  sessionStorage.clear()
  history.replaceState(null, '', '/')
})

describe('PKCE', () => {
  it('matches the RFC 7636 example', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('finishSignIn', () => {
  it('does nothing outside the redirect path', async () => {
    const fetchFn = vi.fn()
    expect(await finishSignIn(fetchFn)).toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('trades the code for a token and stores the account', async () => {
    landOnRedirect('code=xyz&state=abc')
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/token')) {
        const body = init?.body as URLSearchParams
        expect(body.get('code')).toBe('xyz')
        expect(body.get('code_verifier')).toBe('v'.repeat(43))
        expect(body.get('redirect_uri')).toBe(`${location.origin}/auth`)
        return json({ access_token: 'lio_test', token_type: 'Bearer' })
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer lio_test')
      return json({ id: 'someone', username: 'SomeOne' })
    })
    const auth = await finishSignIn(fetchFn as typeof fetch)
    expect(auth?.username).toBe('SomeOne')
    expect((await db.auth.get('lichess'))?.token).toBe('lio_test')
    expect(location.pathname).toBe('/')
    expect(sessionStorage.getItem('lidrill.oauth')).toBeNull()
  })

  it('rejects a mismatched state', async () => {
    landOnRedirect('code=xyz&state=forged')
    const fetchFn = vi.fn()
    await expect(finishSignIn(fetchFn)).rejects.toThrow('Sign-in failed')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await db.auth.count()).toBe(0)
  })

  it('reports a cancelled sign-in', async () => {
    landOnRedirect('error=access_denied&state=abc')
    await expect(finishSignIn(vi.fn())).rejects.toThrow('cancelled')
  })
})

describe('signOut', () => {
  it('forgets the token locally and revokes it on Lichess', async () => {
    await db.auth.put({ id: 'lichess', username: 'SomeOne', token: 'lio_test', scopes: [], grantedAt: 0 })
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    await signOut(fetchFn as typeof fetch)
    expect(await db.auth.count()).toBe(0)
    expect(fetchFn).toHaveBeenCalledWith('https://lichess.org/api/token', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer lio_test' },
    })
  })

  it('still signs out when Lichess is unreachable', async () => {
    await db.auth.put({ id: 'lichess', username: 'SomeOne', token: 'lio_test', scopes: [], grantedAt: 0 })
    await signOut((async () => Promise.reject(new TypeError('offline'))) as typeof fetch)
    expect(await db.auth.count()).toBe(0)
  })
})
