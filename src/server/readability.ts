import type { Band } from '../db'

// A small, pinned readability scorer for the explanation text. It is vendored
// rather than pulled from a package so the numbers never move under us: a
// library update must not turn a passing gloss into a failing one. Change the
// rules only together with the version string.

export const READABILITY_VERSION = 'fk-smog/1.0'

// Chess tokens read as one unit, so they count as one-syllable words:
// anything with a digit (squares, SAN, move numbers) and castling.
const CHESS_TOKEN = /\d|^O-O(-O)?[+#]?[!?]*$/

// Syllables in one word, by a fixed English heuristic:
//  1. chess tokens (see CHESS_TOKEN) count 1;
//  2. hyphenated words are the sum of their parts;
//  3. words of three letters or fewer count 1;
//  4. a final "ed" is silent unless it follows t or d ("jumped" 1, "wanted" 2);
//  5. a final "es" is silent unless it follows a vowel, l, s, x, z, c, g or h
//     ("takes" 1, "boxes" 2, "pieces" 2);
//  6. a final "e" is silent after a consonant, except "le" after a consonant
//     ("move" 1, "table" 2);
//  7. a leading "y" is a consonant ("your" 1);
//  8. the rest is the number of vowel groups (a, e, i, o, u, y), at least 1.
export function syllables(word: string): number {
  if (CHESS_TOKEN.test(word)) return 1
  const parts = word.toLowerCase().split('-').filter(p => /[a-z]/.test(p))
  if (parts.length > 1) return parts.reduce((n, p) => n + syllables(p), 0)
  let w = (parts[0] ?? '').replace(/[^a-z]/g, '')
  if (w.length === 0) return 0
  if (w.length <= 3) return 1
  w = w.replace(/([^td])ed$/, '$1').replace(/([^aeiouylsxzcgh])es$/, '$1')
  if (/[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) w = w.slice(0, -1)
  w = w.replace(/^y/, '')
  return Math.max(1, (w.match(/[aeiouy]+/g) ?? []).length)
}

// Words: whitespace-separated tokens that hold a letter or a digit, with
// surrounding punctuation dropped. "back-rank" is one word.
export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map(t => t.replace(/^[^\w]+|[^\w#+]+$/g, ''))
    .filter(t => /[A-Za-z0-9]/.test(t))
}

// Sentences end at . ! or ? followed by a space or the end of the text. A
// move number ("29." or "29...") does not end one, so notation reads as part
// of its sentence.
export function sentences(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const tok of text.trim().split(/\s+/)) {
    cur = cur ? `${cur} ${tok}` : tok
    if (/[.!?]$/.test(tok) && !/^\d+\.+$/.test(tok)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur) out.push(cur)
  return out.filter(s => words(s).length > 0)
}

const counts = (text: string) => {
  const ws = words(text)
  const syl = ws.map(syllables)
  return {
    words: ws.length,
    sentences: Math.max(1, sentences(text).length),
    syllables: syl.reduce((a, b) => a + b, 0),
    polysyllables: syl.filter(n => n >= 3).length,
  }
}

// Flesch–Kincaid grade: 0.39·(words/sentences) + 11.8·(syllables/words) − 15.59
export function fkGrade(text: string): number {
  const c = counts(text)
  if (c.words === 0) return 0
  return 0.39 * (c.words / c.sentences) + 11.8 * (c.syllables / c.words) - 15.59
}

// SMOG: 1.0430·√(polysyllables·30/sentences) + 3.1291
export function smog(text: string): number {
  const c = counts(text)
  if (c.words === 0) return 0
  return 1.043 * Math.sqrt((c.polysyllables * 30) / c.sentences) + 3.1291
}

export interface Ceiling {
  fk: number // highest Flesch–Kincaid grade
  smog: number // highest SMOG grade
  sentenceWords: number // longest sentence, in words
  totalWords: number // longest text, in words
}

// Two metrics, because FK alone lets long words through in short sentences
// and SMOG alone ignores sentence length.
export const CEILINGS: Record<Band, Ceiling> = {
  beginner: { fk: 4.5, smog: 6, sentenceWords: 12, totalWords: 130 },
  club: { fk: 7, smog: 9, sentenceWords: 18, totalWords: 160 },
  advanced: { fk: 9, smog: 12, sentenceWords: 24, totalWords: 200 },
}

const round = (n: number) => Math.round(n * 100) / 100

// Every way the text breaks its band's ceiling, empty when it fits
export function checkCeilings(text: string, band: Band): string[] {
  const c = CEILINGS[band]
  const out: string[] = []
  const fk = fkGrade(text)
  const sm = smog(text)
  if (fk > c.fk) out.push(`fk ${round(fk)} > ${c.fk}`)
  if (sm > c.smog) out.push(`smog ${round(sm)} > ${c.smog}`)
  for (const s of sentences(text)) {
    const n = words(s).length
    if (n > c.sentenceWords) out.push(`sentence ${n} words > ${c.sentenceWords}: "${s}"`)
  }
  const total = words(text).length
  if (total > c.totalWords) out.push(`total ${total} words > ${c.totalWords}`)
  return out
}
