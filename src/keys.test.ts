import { describe, expect, it } from 'vitest'
import { DRILL_KEYS, drillAction } from './keys'

// The key map of the puzzle screens, and the cases where a key is left to
// the browser.

const key = (k: string, mod: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented', boolean>> = {}) => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...mod,
})

describe('drill keys', () => {
  it('maps every key to its action', () => {
    expect(DRILL_KEYS).toEqual({
      ' ': 'next', enter: 'next', n: 'next',
      h: 'hint', w: 'why', b: 'bury', r: 'retry',
      arrowleft: 'back', k: 'back', arrowright: 'forward', j: 'forward',
      home: 'first', end: 'last', f: 'flip',
    })
  })

  it('reads keys as the browser names them, in either case', () => {
    expect([' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'h', 'H', 'W', 'B', 'R'].map(k => drillAction(key(k)))).toEqual([
      'next', 'next', 'back', 'forward', 'first', 'last', 'hint', 'hint', 'why', 'bury', 'retry',
    ])
  })

  it('ignores keys with no action and names from the object prototype', () => {
    expect(['x', 'Escape', 'toString', 'constructor'].map(k => drillAction(key(k)))).toEqual([undefined, undefined, undefined, undefined])
  })

  it('leaves typing in a field alone', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(['b', ' ', 'Enter'].map(k => drillAction(key(k), tag))).toEqual([undefined, undefined, undefined])
  })

  it('leaves a key with a modifier to the browser', () => {
    expect([{ ctrlKey: true }, { metaKey: true }, { altKey: true }].map(mod => drillAction(key('r', mod)))).toEqual([undefined, undefined, undefined])
  })

  it('leaves Space and Enter to the focused button or link, but not the letters', () => {
    for (const tag of ['BUTTON', 'A', 'SUMMARY']) expect([' ', 'Enter', 'h'].map(k => drillAction(key(k), tag))).toEqual([undefined, undefined, 'hint'])
  })

  it('leaves Space and Enter alone once something else has handled them', () => {
    expect([' ', 'Enter', 'w'].map(k => drillAction(key(k, { defaultPrevented: true }), 'SPAN'))).toEqual([undefined, undefined, 'why'])
  })
})
