import { db, type Auth } from './db'

// Sign in with Lichess: OAuth2 authorization code + PKCE. Lichess
// needs no app registration or client secret, so this runs entirely in the
// browser.

const CLIENT_ID = 'lidrill'
export const SCOPES = ['puzzle:read']
const KEY = 'lidrill.oauth'

const redirectUri = () => `${location.origin}/auth`

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

// extraScopes asks for more than the default, at the moment a feature needs
// it; `after` names what to resume on return.
export async function startSignIn(extraScopes: string[] = [], after?: string): Promise<void> {
  const verifier = randomString()
  const state = randomString()
  const scopes = [...new Set([...SCOPES, ...extraScopes])]
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state, scopes, after }))
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope: scopes.join(' '),
    state,
  })
  location.assign(`https://lichess.org/oauth?${params}`)
}

// Runs on page load. Returns the new Auth if this load is the OAuth redirect,
// throws if Lichess sent back an error or the state doesn't match.
export async function finishSignIn(fetchFn: typeof fetch = fetch): Promise<(Auth & { after?: string }) | undefined> {
  if (location.pathname !== '/auth') return undefined
  const params = new URLSearchParams(location.search)
  history.replaceState(null, '', '/')
  const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
    verifier: string
    state: string
    scopes?: string[]
    after?: string
  } | null
  sessionStorage.removeItem(KEY)
  if (params.get('error')) throw new Error('Lichess sign-in was cancelled.')
  const code = params.get('code')
  if (!code || !saved || params.get('state') !== saved.state) throw new Error('Sign-in failed: the reply from Lichess did not match the request.')

  const tokenRes = await fetchFn('https://lichess.org/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: saved.verifier,
      redirect_uri: redirectUri(),
      client_id: CLIENT_ID,
    }),
  })
  if (!tokenRes.ok) throw new Error(`Lichess refused the sign-in (HTTP ${tokenRes.status}).`)
  const { access_token: token } = (await tokenRes.json()) as { access_token: string }

  const accountRes = await fetchFn('https://lichess.org/api/account', { headers: { Authorization: `Bearer ${token}` } })
  if (!accountRes.ok) throw new Error(`Lichess returned HTTP ${accountRes.status} for the account after sign-in.`)
  const { username } = (await accountRes.json()) as { username: string }

  // Lichess's token response doesn't list scopes; these are the ones asked for
  const auth: Auth = { id: 'lichess', username, token, scopes: saved.scopes ?? SCOPES, grantedAt: Date.now() }
  // A new token replaces the old one: revoke the old so only one is live
  const old = await db.auth.get('lichess')
  await db.auth.put(auth)
  if (old && old.token !== token)
    await fetchFn('https://lichess.org/api/token', { method: 'DELETE', headers: { Authorization: `Bearer ${old.token}` } }).catch(() => {})
  return { ...auth, after: saved.after }
}

export async function signOut(fetchFn: typeof fetch = fetch): Promise<void> {
  const auth = await db.auth.get('lichess')
  await db.auth.delete('lichess')
  // Revoke so the token is useless even if something kept a copy
  if (auth) await fetchFn('https://lichess.org/api/token', { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` } }).catch(() => {})
}
