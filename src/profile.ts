import type { Band, Game } from './db'

// Defaults per level
export const BAND_DEFAULTS: Record<Band, { swingThresholdCp: number; marginCp: number }> = {
  beginner: { swingThresholdCp: 300, marginCp: 150 },
  club: { swingThresholdCp: 150, marginCp: 100 },
  advanced: { swingThresholdCp: 100, marginCp: 80 },
}

// Median rating of the last 50 rapid/classical games. Blitz counts only
// when there are no slower games, since most beginners don't play rapid.
export function computeBand(games: Game[]): Band {
  const recent = (speeds: string[]) =>
    games
      .filter(g => speeds.includes(g.speed) && g.rating > 0)
      .sort((a, b) => b.playedAt - a.playedAt)
      .slice(0, 50)
      .map(g => g.rating)
  let ratings = recent(['rapid', 'classical'])
  if (!ratings.length) ratings = recent(['blitz', 'bullet'])
  if (!ratings.length) return 'beginner'
  ratings.sort((a, b) => a - b)
  const median = ratings[Math.floor(ratings.length / 2)]
  return median < 1000 ? 'beginner' : median < 1800 ? 'club' : 'advanced'
}
