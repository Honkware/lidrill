import { readFileSync } from 'node:fs'
import { Chess } from 'chessops/chess'
import { parseFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { describe, expect, it } from 'vitest'
import type { Puzzle } from '../db'
import { failedPuzzles, fromBatch, snapshot, weakThemes } from './puzzles'

// Frozen from the reference account on Oct 6 2026 (the live dashboard rolls)
const dashboard = JSON.parse(readFileSync('src/lichess/fixtures/dashboard-90.json', 'utf8'))
const activity = readFileSync('src/lichess/fixtures/activity.ndjson', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const batch = JSON.parse(readFileSync('src/lichess/fixtures/batch-rookEndgame.json', 'utf8'))

const playable = (p: Puzzle) => {
  const pos = Chess.fromSetup(parseFen(p.fen).unwrap()).unwrap()
  return p.solution.every(uci => {
    const move = parseUci(uci)
    if (!move || !pos.isLegal(move)) return false
    pos.play(move)
    return true
  })
}

describe('puzzle dashboard', () => {
  it('picks themes 100+ below performance with 5+ attempts', () => {
    expect(dashboard.global.performance).toBe(1120)
    expect(weakThemes(dashboard).map(t => t.theme)).toEqual(['rookEndgame', 'kingsideAttack', 'trappedPiece', 'sacrifice', 'promotion'])
    // 757 performance, but only 4 attempts
    expect(dashboard.themes.defensiveMove.results.nb).toBe(4)
  })

  it('snapshots by the week\'s Monday', () => {
    const s = snapshot(dashboard, new Date('2026-10-08T12:00:00Z'))
    expect(s.week).toBe('2026-10-05')
    expect(s.themes.rookEndgame).toEqual({ nb: 7, firstWins: 2, performance: 926 })
  })
})

describe('failed Lichess puzzles', () => {
  it('keeps failures not solved since, and they play out from the given FEN', () => {
    const now = new Date()
    const failed = failedPuzzles(activity, now)
    const losses = new Set(activity.filter((a: { win: boolean }) => !a.win).map((a: { puzzle: { id: string } }) => a.puzzle.id))
    expect(failed.length).toBe(losses.size)
    expect(failed.every(p => p.source === 'lichess' && p.gameId === '')).toBe(true)
    expect(failed.every(playable)).toBe(true)
  })

  it('drops a failure that was solved later', () => {
    const [miss] = activity.filter((a: { win: boolean }) => !a.win)
    const later = { ...miss, date: miss.date + 1000, win: true }
    expect(failedPuzzles([miss, later], new Date())).toEqual([])
  })
})

describe('theme batches', () => {
  it('rebuilds the puzzle position from the game moves', () => {
    const puzzles = batch.puzzles.map((b: never) => fromBatch(b, new Date()))
    expect(puzzles.length).toBe(2)
    expect(puzzles.every(playable)).toBe(true)
  })
})
