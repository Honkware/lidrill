import { describe, expect, it } from 'vitest'
import { landSound, scoreSound, setSound, soundOn } from './sound'

describe('landSound', () => {
  it('a check outranks a capture, a capture outranks a plain move', () => {
    expect(landSound(false, false)).toBe('move')
    expect(landSound(true, false)).toBe('capture')
    expect(landSound(false, true)).toBe('check')
    expect(landSound(true, true)).toBe('check')
  })
})

describe('scoreSound', () => {
  it('reads a Turning Points score as win, loss or draw', () => {
    expect(scoreSound(4, 4)).toBe('win')
    expect(scoreSound(0, 4)).toBe('lose')
    expect(scoreSound(2, 4)).toBe('draw')
  })
  it('a game with no stops has no result sound', () => {
    expect(scoreSound(0, 0)).toBeUndefined()
  })
})

describe('the toggle', () => {
  it('defaults to on, flips, and persists', () => {
    expect(soundOn()).toBe(true)
    setSound(false)
    expect(soundOn()).toBe(false)
    expect(localStorage.getItem('lidrill.sound')).toBe('0')
    setSound(true)
    expect(soundOn()).toBe(true)
    expect(localStorage.getItem('lidrill.sound')).toBe('1')
  })
})
