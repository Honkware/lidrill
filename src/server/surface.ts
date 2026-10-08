// Single rendering surface, one-liner tier: the
// explanation path renders through packet → validator → renderer, but three
// surfaces show a certified swing as a single sentence outside any packet -
// the drill result card's game-move line, the review journal's hang line, and
// the band note's threshold rule. A full packet is overkill for one sentence,
// so this module is the one place those sentences are composed. It is the
// same deal as the renderer: deterministic words from validated inputs only.
// Every input is fail-closed - a non-finite or non-positive centipawn count
// or a missing SAN returns undefined and the view omits the sentence, never
// invents a number. Views must not compose swing/cost/threat phrasing
// anywhere else (fixed the drill card's frame gating; moved
// the composition itself here).

// Centipawns in words a player uses: "a pawn and a half", "three pawns".
// One magnitude, one rendering - the old parenthetical second bucket
// ("three pawns (about a knight or bishop)") restated the same swing and is
// gone
export function costWords(cp: number): string | undefined {
  if (!Number.isFinite(cp) || cp <= 0) return undefined
  const n = Math.round(cp / 50) / 2
  if (n >= 9) return 'a queen or more'
  if (n <= 1) return 'a pawn'
  if (n === 1.5) return 'a pawn and a half'
  const word = ['', '', 'two', 'three', 'four', 'five'][Math.floor(n)]
  return Number.isInteger(n) && word ? `${word} pawns` : `${n} pawns`
}

// The drill result card's game-move line (miss frame only - the view gates
// the frame, mirroring the server's membership of the solving move,)
export function drillGameLine(played: { san?: string }, swingCp: number): string | undefined {
  if (!played.san) return undefined
  const words = costWords(swingCp)
  return words ? ` In the game: ${played.san}, giving away about ${words}.` : undefined
}

// The review journal's hang line over the stored certified hang: [prefix,
// san, suffix] so the view can link the SAN without composing any words
export function journalHangParts(hung: { san?: string; swingCp?: number; ply?: number }): [string, string, string] | undefined {
  if (!hung.san || typeof hung.ply !== 'number' || hung.ply < 1) return undefined
  const words = costWords(hung.swingCp ?? NaN)
  return words ? [`Gave away about ${words} on move ${Math.ceil(hung.ply / 2)} (`, hung.san, `).`] : undefined
}

// The band note's threshold rule - definitional copy over the calibrated plan
// parameter, not a claim about a position, but it names an amount, so the
// words come from here too
export function thresholdWords(cp: number): string | undefined {
  return costWords(cp)
}
