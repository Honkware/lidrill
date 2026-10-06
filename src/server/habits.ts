import type { Band } from '../db'
import type { PuzzleKind } from './explain'

// Habits to take into the next game, as fixed text. The narrator names a
// habit by id and the renderer inserts the string as written, so the model
// never words a habit itself. Each is an implementation intention ("When
// <trigger>, I <action>."), the form that turns advice into a cue the player
// meets over the board. Change the texts only together with the version.

export const HABIT_LIB_VERSION = 'habit/1.0'

export type Family = 'safety' | 'tactics' | 'conversion' | 'defense'

// What kind of thinking the puzzle trained
export function family(kind: PuzzleKind): Family {
  switch (kind) {
    case 'hang':
      return 'safety'
    case 'missed-win':
    case 'lichess':
      return 'tactics'
    case 'conversion':
      return 'conversion'
    case 'hold':
    case 'defensive':
      return 'defense'
  }
}

export interface Habit {
  id: string // 'habit:<slug>', stable once published
  family: Family
  bands: Band[]
  text: string // 'When …, I ….'
}

const ALL: Band[] = ['beginner', 'club', 'advanced']
const UPPER: Band[] = ['club', 'advanced']

// Order matters: selection takes the first habit that fits, so the most
// basic habit of each family comes first.
export const HABITS: Habit[] = [
  // Safety: the blunder check, "loose pieces drop off" and "what does their
  // move do" (Heisman)
  { id: 'habit:blunder-check', family: 'safety', bands: ALL, text: 'When I pick a move, I check what it leaves loose.' },
  { id: 'habit:loose-pieces', family: 'safety', bands: ALL, text: 'When my piece has no guard, I guard it or move it.' },
  { id: 'habit:their-move', family: 'safety', bands: ALL, text: 'When they move, I ask what their move wants to do.' },
  { id: 'habit:safe-square', family: 'safety', bands: ALL, text: 'When I move a piece, I check the new square is safe.' },
  {
    id: 'habit:count-captures',
    family: 'safety',
    bands: UPPER,
    text: 'When they can take a piece of mine, I count attackers and guards before I move.',
  },
  {
    id: 'habit:open-king',
    family: 'safety',
    bands: ['advanced'],
    text: 'When the position opens near my king, I list their checks and sacrifices before I move.',
  },

  // Tactics: checks, captures and threats (Heisman), and "look for a better
  // move" (Lasker)
  { id: 'habit:cct-scan', family: 'tactics', bands: ALL, text: 'When I move, I first look at checks, captures and threats.' },
  { id: 'habit:two-targets', family: 'tactics', bands: ALL, text: 'When two of their pieces are loose, I look to hit both.' },
  { id: 'habit:better-move', family: 'tactics', bands: ALL, text: 'When I find a good move, I look for a better one.' },
  { id: 'habit:king-boxed', family: 'tactics', bands: ALL, text: 'When their king has no free squares, I look for checks.' },
  {
    id: 'habit:overworked',
    family: 'tactics',
    bands: UPPER,
    text: 'When one of their pieces guards two things, I look for a way to take one.',
  },
  {
    id: 'habit:forcing-line',
    family: 'tactics',
    bands: ['advanced'],
    text: 'When I see a forcing line, I calculate it to the end before I trust it.',
  },

  // Conversion: "when ahead, trade pieces and stop counterplay", and
  // prophylaxis, "what does my opponent want"
  { id: 'habit:trade-down', family: 'conversion', bands: ALL, text: 'When I am ahead, I trade pieces and keep my pawns.' },
  { id: 'habit:what-they-want', family: 'conversion', bands: ALL, text: 'When I am ahead, I ask what they want and stop it.' },
  { id: 'habit:king-first', family: 'conversion', bands: ALL, text: 'When I am winning, I make my king safe, then grab more.' },
  { id: 'habit:no-rush', family: 'conversion', bands: ['beginner'], text: 'When I am winning, I take my time and stop their threats.' },
  {
    id: 'habit:stop-counterplay',
    family: 'conversion',
    bands: UPPER,
    text: 'When I am ahead, I trade pieces and stop their counterplay first.',
  },
  {
    id: 'habit:prophylaxis',
    family: 'conversion',
    bands: UPPER,
    text: 'When I am winning, I ask what my opponent wants before I make my plan.',
  },

  // Defense: "when worse, list their forcing moves"
  { id: 'habit:list-forcing', family: 'defense', bands: ALL, text: 'When I am worse, I list their checks, captures and threats.' },
  { id: 'habit:stop-threat', family: 'defense', bands: ALL, text: 'When they make a threat, I list ways to stop it.' },
  { id: 'habit:king-room', family: 'defense', bands: ALL, text: 'When my king is short of squares, I make room for it.' },
  { id: 'habit:keep-fighting', family: 'defense', bands: ALL, text: 'When I am lost, I set traps and make them work.' },
  {
    id: 'habit:trade-attackers',
    family: 'defense',
    bands: UPPER,
    text: 'When they attack my king, I trade off their best attacking piece.',
  },
  {
    id: 'habit:only-moves',
    family: 'defense',
    bands: ['advanced'],
    text: 'When the position is critical, I look for the only move before I look for comfort.',
  },
]

export interface HabitQuery {
  kind: PuzzleKind
  band: Band
  weeklyFocusHabitId?: string
  recent: string[] // habit ids of past explanations, oldest first
}

// How many past explanations a habit sits out after it is used
const RECENT_WINDOW = 3

// Picked mechanically when the packet is built: filter by family and band,
// then the weekly focus wins if it is in that pool (never across families,
// and it repeats on purpose), then drop habits from the last 3
// explanations, then take the first one left in list order.
export function selectHabit(q: HabitQuery): Habit {
  const fam = family(q.kind)
  const pool = HABITS.filter(h => h.family === fam && h.bands.includes(q.band))
  const focus = q.weeklyFocusHabitId && pool.find(h => h.id === q.weeklyFocusHabitId)
  if (focus) return focus
  const recent = new Set(q.recent.slice(-RECENT_WINDOW))
  // All used lately: repeating the first is better than saying nothing
  return pool.find(h => !recent.has(h.id)) ?? pool[0]
}
