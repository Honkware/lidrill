import { SignInExpired } from '../sync/lichess'

// Signed-in Lichess calls. Every one of these works with the default token
// (no scope, or puzzle:read); for which needs what.

export type Speed = 'bullet' | 'blitz' | 'rapid' | 'classical'

export interface Perf {
  rating: number
  games: number
  prov?: boolean
}

export interface Account {
  username: string
  perfs: Partial<Record<Speed | 'puzzle', Perf>>
}

export async function lichessJson<T>(url: string, token: string, fetchFn: typeof fetch = fetch): Promise<T> {
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (res.status === 401) throw new SignInExpired()
  if (!res.ok) throw new Error(`Lichess returned HTTP ${res.status} for ${new URL(url).pathname}.`)
  return res.json() as Promise<T>
}

export async function fetchAccount(token: string, fetchFn: typeof fetch = fetch): Promise<Account> {
  const a = await lichessJson<{ username: string; perfs?: Record<string, Perf> }>('https://lichess.org/api/account', token, fetchFn)
  const perfs: Account['perfs'] = {}
  for (const k of ['bullet', 'blitz', 'rapid', 'classical', 'puzzle'] as const) {
    const p = a.perfs?.[k]
    if (p) perfs[k] = { rating: p.rating, games: p.games, prov: p.prov || undefined }
  }
  return { username: a.username, perfs }
}

export const PREFERENCE_SCOPE = 'preference:read'

// The player's Lichess board and pieces (preference:read, asked for only when
// they press "Use my Lichess look" in Settings)
export async function fetchLook(token: string, fetchFn: typeof fetch = fetch): Promise<{ pieceSet?: string; theme?: string; dark?: boolean }> {
  const res = await lichessJson<{ prefs?: { pieceSet?: string; theme?: string; dark?: boolean } }>(
    'https://lichess.org/api/account/preferences',
    token,
    fetchFn,
  )
  return res.prefs ?? {}
}
