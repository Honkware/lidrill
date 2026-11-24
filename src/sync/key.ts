// Sync without an account. Device sync is keyed by the Lichess account, and
// a Chess.com player has none here (Chess.com offers no sign-in for other
// sites), so their puzzles and opening progress stayed on one device. A
// sync key is a random secret the first device makes and the second is
// given by hand: whoever holds it reads and writes the same rows. The
// Worker stores them under a hash of the key (worker/index.ts), so the
// server never holds the key itself. It lives in localStorage, outside the
// synced tables and the export.

const STORED = 'lidrill.syncKey'
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

// 26 base32 characters carry 130 bits
export const SYNC_KEY = /^key_[a-z2-7]{26}$/

export function newSyncKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return `key_${[...bytes].map(b => ALPHABET[b % 32]).join('')}`
}

// What the player reads and types: the 26 characters in groups, no prefix
export const codeOf = (key: string) => key.slice(4).match(/.{1,5}/g)!.join('-')

// A typed or pasted code back to a key, or undefined when it isn't one
export function keyOf(code: string): string | undefined {
  const key = `key_${code.toLowerCase().replace(/[\s-]/g, '')}`
  return SYNC_KEY.test(key) ? key : undefined
}

export function readSyncKey(): string | undefined {
  try {
    const key = localStorage.getItem(STORED) ?? ''
    return SYNC_KEY.test(key) ? key : undefined
  } catch {
    return undefined
  }
}

export function saveSyncKey(key: string | undefined) {
  try {
    if (key) localStorage.setItem(STORED, key)
    else localStorage.removeItem(STORED)
  } catch {
    // storage is off: sync stays off with it
  }
}
