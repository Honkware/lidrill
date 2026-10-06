import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { fromChesscom } from './chesscom'
import { exportUrl, fromLichess, SignInExpired } from './lichess'
import { sync } from './sync'

const lichessLines = readFileSync('src/sync/fixtures/lichess-sample.ndjson', 'utf8').trim().split('\n')
const chesscom = JSON.parse(readFileSync('src/sync/fixtures/chesscom-sample.json', 'utf8'))

describe('lichess', () => {
  it('parses real export lines', () => {
    const games = lichessLines.map(l => fromLichess(JSON.parse(l), 'penguingim1'))
    expect(games.every(Boolean)).toBe(true)
    const g = games[0]!
    expect(g.id).toBe('lichess:lN5WRjf1')
    expect(g.color).toBe('white')
    expect(g.result).toBe('loss')
    expect(g.eco).toBe('A05')
    expect(g.moves[0]).toEqual({ san: 'Nf3', uci: 'g1f3' })
    expect(g.clocks!.length).toBeGreaterThan(0)
  })

  it('skips variants and games the user did not play', () => {
    const g = JSON.parse(lichessLines[0])
    expect(fromLichess({ ...g, variant: 'chess960' }, 'penguingim1')).toBeNull()
    expect(fromLichess(g, 'someoneelse')).toBeNull()
  })

  it('asks only for games after the last sync', () => {
    expect(exportUrl('Foo', 1700000000001)).toContain('since=1700000000001')
    expect(exportUrl('Foo')).not.toContain('since')
    expect(exportUrl('Foo')).toContain('max=200')
    expect(exportUrl('Foo', 1)).not.toContain('max=')
  })
})

describe('chess.com', () => {
  it('parses real archive games', () => {
    const g = fromChesscom(chesscom.games[0], 'Hikaru')!
    expect(g.id).toBe('chesscom:183193101523')
    expect(g.color).toBe('black')
    expect(g.result).toBe('win')
    expect(g.termination).toBe('resigned')
    expect(g.eco).toMatch(/^[A-E]\d\d$/)
    expect(g.opening).toContain('Sicilian')
    expect(g.moves.length).toBeGreaterThan(10)
  })

  it('skips variants', () => {
    expect(fromChesscom({ ...chesscom.games[0], rules: 'chess960' }, 'hikaru')).toBeNull()
  })
})

describe('incremental sync', () => {
  beforeEach(async () => {
    await db.games.clear()
    await db.syncState.clear()
  })

  const ndjson = (lines: string[]) =>
    new Response(lines.join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } })

  it('dedupes and only requests newer lichess games', async () => {
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(url)
      return ndjson(urls.length === 1 ? lichessLines : lichessLines.slice(0, 1))
    }) as typeof fetch

    expect(await sync({ lichessUser: 'penguingim1', fetchFn })).toEqual({ lichess: 3, chesscom: 0 })
    // second sync: the server sends back one game we already have
    expect(await sync({ lichessUser: 'penguingim1', fetchFn })).toEqual({ lichess: 0, chesscom: 0 })
    expect(await db.games.count()).toBe(3)
    expect(urls[0]).not.toContain('since=')
    const newest = Math.max(...lichessLines.map(l => JSON.parse(l).createdAt))
    expect(urls[1]).toContain(`since=${newest + 1}`)
  })

  it('sends the token and reports a revoked one', async () => {
    let auth: string | null = null
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('Authorization')
      return new Response('', { status: 401 })
    }) as typeof fetch
    await expect(sync({ lichessUser: 'penguingim1', lichessToken: 'lio_old', fetchFn })).rejects.toBeInstanceOf(SignInExpired)
    expect(auth).toBe('Bearer lio_old')
  })

  it('never overwrites a stored game', async () => {
    const fetchFn = (async () => ndjson(lichessLines)) as typeof fetch
    await sync({ lichessUser: 'penguingim1', fetchFn })
    await db.games.update('lichess:lN5WRjf1', { analyzedAt: 1 })
    await db.syncState.clear() // force a full re-fetch
    await sync({ lichessUser: 'penguingim1', fetchFn })
    expect((await db.games.get('lichess:lN5WRjf1'))!.analyzedAt).toBe(1)
  })

  it('skips finished chess.com months on later syncs', async () => {
    const requested: string[] = []
    const base = 'https://api.chess.com/pub/player/hikaru/games'
    const fetchFn = (async (url: string) => {
      requested.push(url)
      if (url.endsWith('/archives')) return Response.json({ archives: [`${base}/2026/09`, `${base}/2026/10`] })
      return Response.json(url.endsWith('2026/09') ? chesscom : { games: [] })
    }) as typeof fetch
    const now = new Date('2026-10-06T00:00:00Z')

    await sync({ chesscomUser: 'Hikaru', fetchFn, now })
    expect(await db.games.count()).toBe(3)
    requested.length = 0
    await sync({ chesscomUser: 'Hikaru', fetchFn, now })
    // September is done, so only the archive list and October are fetched
    expect(requested).toEqual([`${base}/archives`, `${base}/2026/10`])
  })

  it('stops a first chess.com sync once it has enough games', async () => {
    const base = 'https://api.chess.com/pub/player/hikaru/games'
    const month = (m: string) => ({
      games: Array.from({ length: 70 }, (_, i) => ({ ...chesscom.games[i % 3], url: `https://www.chess.com/game/live/${m}-${i}` })),
    })
    const months = ['2026/05', '2026/06', '2026/07', '2026/08', '2026/09']
    const requested: string[] = []
    const fetchFn = (async (url: string) => {
      requested.push(url)
      if (url.endsWith('/archives')) return Response.json({ archives: months.map(m => `${base}/${m}`) })
      return Response.json(month(url.split('/games/')[1]))
    }) as typeof fetch
    await sync({ chesscomUser: 'Hikaru', fetchFn, now: new Date('2026-10-06T00:00:00Z') })
    // 70 a month: three months reach 200, the two oldest are skipped
    expect(requested.filter(u => !u.endsWith('/archives'))).toEqual([`${base}/2026/09`, `${base}/2026/08`, `${base}/2026/07`])
    expect(await db.games.count()).toBe(210)
  })
})
