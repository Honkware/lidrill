import { createEmptyCard } from 'ts-fsrs'
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteAllData, exportData, importData } from './backup'
import { db } from './db'

beforeEach(async () => {
  await deleteAllData()
  await db.auth.clear()
})

describe('backup', () => {
  it('round-trips puzzles with their card dates and leaves the token out', async () => {
    const card = { ...createEmptyCard(new Date('2026-10-01')), last_review: new Date('2026-10-02') }
    await db.puzzles.put({ id: 'g:20', gameId: 'g', ply: 20, fen: '', played: '', solution: [], solutionLen: 1, type: 'hang', tag: 'hang', swingCp: 300, card })
    await db.auth.put({ id: 'lichess', username: 'someone', token: 'lio_secret', scopes: [], grantedAt: 0 })
    const text = JSON.stringify(await exportData())
    expect(text).not.toContain('lio_secret')

    await deleteAllData()
    await importData(text)
    const p = await db.puzzles.get('g:20')
    expect(p!.card.due).toBeInstanceOf(Date)
    expect(+p!.card.due).toBe(+card.due)
    expect(+p!.card.last_review!).toBe(+card.last_review)
    // importing doesn't touch the sign-in
    expect((await db.auth.get('lichess'))?.token).toBe('lio_secret')
  })

  it('refuses other files', async () => {
    await expect(importData('{"hello":1}')).rejects.toThrow("isn't a lidrill export")
  })
})
