import { describe, expect, it } from 'vitest'
import { codeOf, keyOf, newSyncKey, readSyncKey, saveSyncKey, SYNC_KEY } from './key'

describe('sync key', () => {
  it('makes a different key each time, in the shape the Worker accepts', () => {
    const a = newSyncKey()
    expect(a).toMatch(SYNC_KEY)
    expect(newSyncKey()).not.toBe(a)
  })

  it('reads back the code it shows, however it is typed', () => {
    const key = 'key_abcdefghijklmnopqrstuvwxyz'
    expect(codeOf(key)).toBe('abcde-fghij-klmno-pqrst-uvwxy-z')
    expect(keyOf(codeOf(key))).toBe(key)
    expect(keyOf(' ABCDE fghij-klmno pqrst uvwxy z ')).toBe(key)
  })

  it('takes nothing that is not a whole code', () => {
    expect(keyOf('abcde-fghij')).toBeUndefined()
    expect(keyOf('abcde-fghij-klmno-pqrst-uvwxy-1')).toBeUndefined() // 1 is not in the alphabet
    expect(keyOf('')).toBeUndefined()
  })

  it('is kept in the browser until it is taken away', () => {
    saveSyncKey('key_abcdefghijklmnopqrstuvwxyz')
    expect(readSyncKey()).toBe('key_abcdefghijklmnopqrstuvwxyz')
    saveSyncKey(undefined)
    expect(readSyncKey()).toBeUndefined()
  })
})
