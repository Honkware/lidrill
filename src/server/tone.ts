import type { Band } from '../db'

// Closed tone dictionaries for explanation text (V-TONE). Fixed lists, not a
// model's judgement, so a check passes or fails the same way every time.
// Change the lists only together with the version string.

export const TONE_VERSION = 'tone/1.0'

// Words that talk down to a strong player: "just", "simply" and "obviously"
// tell them the move was easy, which helps nobody who missed it.
export const CONDESCENSION: string[] = [
  'just',
  'simply',
  'obviously',
  'obvious',
  'clearly',
  'of course',
  'easy',
  'easily',
  'trivial',
  'basic',
  'little',
  'tiny',
  'baby',
  'buddy',
  'champ',
  'kiddo',
  'everyone knows',
]

// Labels that tell a beginner they are bad at chess rather than what to do
export const DISCOURAGING: string[] = [
  'terrible',
  'awful',
  'bad',
  'stupid',
  'dumb',
  'horrible',
  'hopeless',
  'pathetic',
  'silly',
  'careless',
  'lazy',
  'blunder',
  'blunders',
  'blundered',
  '??',
]

// Sarcasm frames, banned at every band
export const SARCASM: string[] = [
  'nice try',
  'nice one',
  'good job',
  'great job',
  'well done',
  'way to go',
  'congratulations',
  'oh well',
  'thanks for',
  'genius',
  'what were you thinking',
]

// Rhetorical questions about the player's worth, banned at every band
export const WORTH_QUESTIONS: RegExp[] = [
  /\b(how could you|why would you|why did you|why do you|why can't you)\b[^?]*\?/i,
  /\b(are you even|do you even|did you even|can't you see|are you serious|seriously|really)\b[^?]*\?/i,
]

// The only move-quality labels an explanation may use
export const MOVE_LABELS: string[] = ['best', 'only move', 'winning', 'holds', 'mistake', 'blunder']

// Quality words outside the label set. Matched only as a move label, so
// plain English ("a great deal") stays allowed.
const OFF_LABEL =
  /\b(brilliant|excellent|amazing|superb|beautiful|perfect|great|dubious|weak|poor|lousy|ugly|inaccurate)\s+(move|moves|play|choice|idea)\b|\b(inaccuracy|brilliancy)\b|!!|!\?|\?!/i

export const EXCLAMATION_CAP: Record<Band, number> = { beginner: 1, club: 0, advanced: 0 }

const phrase = (p: string) => {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return /^\w/.test(p) ? new RegExp(`\\b${esc}\\b`, 'i') : new RegExp(esc)
}
const hits = (text: string, list: string[]) => list.filter(p => phrase(p).test(text))

// Every tone rule the text breaks at this band, empty when it is clean
export function toneViolations(text: string, band: Band): string[] {
  const out: string[] = []
  if (band === 'advanced') for (const w of hits(text, CONDESCENSION)) out.push(`condescension: "${w}"`)
  if (band === 'beginner') for (const w of hits(text, DISCOURAGING)) out.push(`discouraging: "${w}"`)
  for (const w of hits(text, SARCASM)) out.push(`sarcasm: "${w}"`)
  for (const re of WORTH_QUESTIONS) {
    const m = text.match(re)
    if (m) out.push(`worth question: "${m[0]}"`)
  }
  const off = text.match(OFF_LABEL)
  if (off) out.push(`move label outside set: "${off[0]}"`)
  // Annotation pairs (!!, !?) are caught above; count the rest
  const bangs = (text.replace(/!!|!\?|\?!/g, '').match(/!/g) ?? []).length
  if (bangs > EXCLAMATION_CAP[band]) out.push(`exclamations ${bangs} > ${EXCLAMATION_CAP[band]}`)
  return out
}
