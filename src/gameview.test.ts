import { describe, expect, it } from 'vitest'
import { stepKey } from './gameview'

// Stepping through a reviewed game from the keyboard, with Lichess's keys.

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, ...init })

describe('stepKey', () => {
  it('steps with the arrows and with j and k', () => {
    expect([key('ArrowLeft'), key('k'), key('ArrowRight'), key('j')].map(e => stepKey(e, 5, 40))).toEqual([4, 4, 6, 6])
  })

  it('jumps to the start with up, 0 or home and to the end with down, $ or end', () => {
    expect([key('ArrowUp'), key('0'), key('Home'), key('ArrowDown'), key('$'), key('End')].map(e => stepKey(e, 5, 40))).toEqual([0, 0, 0, 40, 40, 40])
  })

  it('leaves other keys and the browser’s shortcuts alone', () => {
    expect([key('x'), key('0', { ctrlKey: true }), key('k', { metaKey: true })].map(e => stepKey(e, 5, 40))).toEqual([undefined, undefined, undefined])
  })

  it('leaves keys typed into a text box alone', () => {
    const box = document.createElement('textarea')
    document.body.append(box)
    const e = key('j', { bubbles: true })
    let seen: number | undefined = -1
    box.addEventListener('keydown', ev => (seen = stepKey(ev, 5, 40)))
    box.dispatchEvent(e)
    expect(seen).toBeUndefined()
    box.remove()
  })
})
