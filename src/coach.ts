import type { TimeProfile } from './time'

// One line over the day's puzzles, made of numbers other screens already
// show: the puzzles due, the week's games with a hang (the last of the
// weekly bars on Train) and how often the clock ran low (the time profile
// on Games). A part with nothing behind it is left out, and so is the line.

export interface Coach {
  due: number
  week?: { games: number; clean: number }
  time?: Pick<TimeProfile, 'speed' | 'games' | 'trouble'>
}

export function coachLine(c: Coach): string | undefined {
  const parts: string[] = []
  if (c.due > 0) parts.push(`${c.due} due`)
  if (c.week?.games) parts.push(`a hang in ${c.week.games - c.week.clean} of ${c.week.games} games this week`)
  if (c.time?.trouble) parts.push(`time trouble in ${c.time.trouble} of ${c.time.games} ${c.time.speed} games`)
  return parts.length ? parts.join(' · ') : undefined
}
