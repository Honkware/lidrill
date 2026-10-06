import { db, type Auth } from './db'

// Sign in with Lichess: OAuth2 authorization code + PKCE. Lichess
// needs no app registration or client secret, so this runs entirely in the
// browser.

const CLIENT_ID = 'lidrill'
const SCOPES = ['puzzle:read']
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

export async function startSignIn(): Promise<void> {
  const verifier = randomString()
  const state = randomString()
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state }))
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope: SCOPES.join(' '),
    state,
  })
  location.assign(`https://lichess.org/oauth?${params}`)
}

// Runs on page load. Returns the new Auth if this load is the OAuth redirect,
// throws if Lichess sent back an error or the state doesn't match.
export async function finishSignIn(fetchFn: typeof fetch = fetch): Promise<Auth | undefined> {
  if (location.pathname !== '/auth') return undefined
  const params = new URLSearchParams(location.search)
  history.replaceState(null, '', '/')
  const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { verifier: string; state: string } | null
  sessionStorage.removeItem(KEY)
  if (params.get('error')) throw new Error('Lichess sign-in was cancelled.')
  const code = params.get('code')
  if (!code || !saved || params.get('state') !== saved.state) throw new Error('Sign-in failed. Please try again.')

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
  if (!tokenRes.ok) throw new Error('Lichess refused the sign-in. Please try again.')
  const { access_token: token } = (await tokenRes.json()) as { access_token: string }

  const accountRes = await fetchFn('https://lichess.org/api/account', { headers: { Authorization: `Bearer ${token}` } })
  if (!accountRes.ok) throw new Error('Signed in, but Lichess wouldn\'t return the account. Please try again.')
  const { username } = (await accountRes.json()) as { username: string }

  const auth: Auth = { id: 'lichess', username, token, scopes: SCOPES, grantedAt: Date.now() }
  await db.auth.put(auth)
  return auth
}

export async function signOut(fetchFn: typeof fetch = fetch): Promise<void> {
  const auth = await db.auth.get('lichess')
  await db.auth.delete('lichess')
  // Revoke so the token is useless even if something kept a copy
  if (auth) await fetchFn('https://lichess.org/api/token', { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` } }).catch(() => {})
}
