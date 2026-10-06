import type { Band, Game } from './db'
import type { Perf, Speed } from './lichess/api'

// Defaults per level
export const BAND_DEFAULTS: Record<Band, { swingThresholdCp: number; marginCp: number }> = {
  beginner: { swingThresholdCp: 300, marginCp: 150 },
  club: { swingThresholdCp: 150, marginCp: 100 },
  advanced: { swingThresholdCp: 100, marginCp: 80 },
}

const bandOf = (rating: number): Band => (rating < 1000 ? 'beginner' : rating < 1800 ? 'club' : 'advanced')

// The current Lichess rating in the speed played most, rapid/classical first
//Settled ratings win; failing that, a provisional one with 5+ games,
// which still beats game ratings that start every new account at 1500.
export function bandFromRatings(perfs: Partial<Record<Speed, Perf>>): Band | undefined {
  for (const settled of [true, false])
    for (const speeds of [['rapid', 'classical'], ['blitz', 'bullet']] as Speed[][]) {
      const known = speeds
        .map(s => perfs[s])
        .filter((p): p is Perf => !!p && (settled ? p.games > 0 && !p.prov : p.games >= 5))
      known.sort((a, b) => b.games - a.games)
      if (known.length) return bandOf(known[0].rating)
    }
  return undefined
}

// Median rating of the last 50 rapid/classical games. Blitz counts only
// when there are no slower games, since most beginners don't play rapid.
// Signed-in players get their live Lichess rating instead, when it's settled.
export function computeBand(games: Game[], perfs?: Partial<Record<Speed, Perf>>): Band {
  const fromLichess = perfs && bandFromRatings(perfs)
  if (fromLichess) return fromLichess
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
  return bandOf(ratings[Math.floor(ratings.length / 2)])
}
