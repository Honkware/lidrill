// The keys of a puzzle, in one place. Lichess's puzzle keys (arrows or j/k
// to step through the line, Home and End, f to flip, n to move on) and the
// ones for a run of puzzles: Space or Enter for the next, h for the hint,
// w for "Why?", b to bury and r to try the puzzle again.

export type DrillAction = 'next' | 'hint' | 'why' | 'bury' | 'retry' | 'back' | 'forward' | 'first' | 'last' | 'flip'

export const DRILL_KEYS: Record<string, DrillAction> = {
  ' ': 'next',
  enter: 'next',
  n: 'next',
  h: 'hint',
  w: 'why',
  b: 'bury',
  r: 'retry',
  arrowleft: 'back',
  k: 'back',
  arrowright: 'forward',
  j: 'forward',
  home: 'first',
  end: 'last',
  f: 'flip',
}

const FIELDS = ['INPUT', 'TEXTAREA', 'SELECT']
const PRESSED = ['BUTTON', 'A', 'SUMMARY']

type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'>

// What a key press means, given the tag of the element with the focus.
// Typing in a field is never a shortcut, nor is a key with a modifier, and
// Space and Enter belong to the button or link they are pressed on.
export function drillAction(e: Key, focus?: string): DrillAction | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey || (focus && FIELDS.includes(focus))) return undefined
  const name = e.key.toLowerCase()
  const press = name === ' ' || name === 'enter'
  if (press && (e.defaultPrevented || (focus && PRESSED.includes(focus)))) return undefined
  return Object.hasOwn(DRILL_KEYS, name) ? DRILL_KEYS[name] : undefined
}
