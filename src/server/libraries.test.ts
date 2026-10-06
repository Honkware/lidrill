import { describe, expect, it } from 'vitest'
import type { Band } from '../db'
import type { PuzzleKind } from './explain'
import { family, HABITS, HABIT_LIB_VERSION, selectHabit, type Family } from './habits'
import { MOTIF_KEYS, MOTIF_LIB_VERSION, motifEntry } from './motifLib'
import { checkCeilings, fkGrade, READABILITY_VERSION, sentences, smog, syllables, words } from './readability'
import { TONE_VERSION, toneViolations } from './tone'

const BANDS: Band[] = ['beginner', 'club', 'advanced']
const FAMILIES: Family[] = ['safety', 'tactics', 'conversion', 'defense']
const problems = (text: string, band: Band) => [...checkCeilings(text, band), ...toneViolations(text, band)]

describe('versions', () => {
  it('are pinned', () => {
    expect(READABILITY_VERSION).toBe('fk-smog/1.0')
    expect(HABIT_LIB_VERSION).toBe('habit/1.0')
    expect(MOTIF_LIB_VERSION).toBe('motifLib/1.0')
    expect(TONE_VERSION).toBe('tone/1.0')
  })
})

describe('readability scorer', () => {
  it('counts syllables by its fixed rules', () => {
    expect(syllables('cat')).toBe(1) // three letters or fewer
    expect(syllables('jumped')).toBe(1) // silent "ed"
    expect(syllables('wanted')).toBe(2) // "ed" after t is spoken
    expect(syllables('takes')).toBe(1) // silent "es"
    expect(syllables('boxes')).toBe(2) // "es" after x is spoken
    expect(syllables('pieces')).toBe(2) // "es" after c is spoken
    expect(syllables('move')).toBe(1) // silent "e"
    expect(syllables('table')).toBe(2) // "le" after a consonant is spoken
    expect(syllables('your')).toBe(1) // leading y is a consonant
    expect(syllables('material')).toBe(3) // a, e, ia
    expect(syllables('back-rank')).toBe(2) // sum of the parts
  })

  it('counts chess tokens as one syllable', () => {
    for (const t of ['e4', 'Nf3', 'exd5', 'Qxe7+', 'R8c3#', 'O-O', 'O-O-O', 'e8=Q']) expect(syllables(t)).toBe(1)
  })

  it('splits words and sentences, keeping move numbers inside a sentence', () => {
    expect(words('Back-rank mate, at last!')).toEqual(['Back-rank', 'mate', 'at', 'last'])
    expect(words('29. Ra1 R8c3#')).toEqual(['29', 'Ra1', 'R8c3#'])
    expect(sentences('29. Ra1 R8c3# wins. Then 29... Nc4 holds!')).toEqual(['29. Ra1 R8c3# wins.', 'Then 29... Nc4 holds!'])
    expect(sentences('No end mark')).toEqual(['No end mark'])
    expect(sentences('')).toEqual([])
  })

  it('matches hand-computed reference values', () => {
    // "The cat sat on the mat." 6 words, 1 sentence, 6 syllables, 0 of 3+:
    // FK = 0.39·6 + 11.8·1 − 15.59 = −1.45; SMOG = 1.043·0 + 3.1291 = 3.1291
    const easy = 'The cat sat on the mat.'
    expect(fkGrade(easy)).toBeCloseTo(-1.45, 6)
    expect(smog(easy)).toBeCloseTo(3.1291, 6)

    // removing 3, the 1, defender 3, wins 1, material 3, Look 1, for 1,
    // loose 1, pieces 2: 9 words, 2 sentences, 16 syllables, 3 of 3+.
    // FK = 0.39·4.5 + 11.8·16/9 − 15.59 = 1.755 + 20.977778 − 15.59 = 7.142778
    // SMOG = 1.043·√(3·30/2) + 3.1291 = 1.043·6.708204 + 3.1291 = 10.125757
    const hard = 'Removing the defender wins material. Look for loose pieces.'
    expect(fkGrade(hard)).toBeCloseTo(7.142778, 5)
    expect(smog(hard)).toBeCloseTo(10.125757, 5)

    expect(fkGrade('')).toBe(0)
    expect(smog('')).toBe(0)
  })

  it('reports each broken ceiling', () => {
    // 13 words: too long for a beginner sentence, fine at club
    const long = 'When I move a piece I look at the square it goes to.'
    expect(checkCeilings(long, 'beginner')).toEqual([expect.stringMatching(/^sentence 13 words > 12/)])
    expect(checkCeilings(long, 'club')).toEqual([])
    // 132 words in two-word sentences
    const many = 'Go now. '.repeat(66)
    expect(checkCeilings(many, 'beginner')).toEqual(['total 132 words > 130'])
    expect(checkCeilings(many, 'club')).toEqual([])
    // The "hard" reference: FK 7.14 and SMOG 10.13 pass only at advanced
    const hard = 'Removing the defender wins material. Look for loose pieces.'
    expect(checkCeilings(hard, 'club')).toEqual(['fk 7.14 > 7', 'smog 10.13 > 9'])
    expect(checkCeilings(hard, 'advanced')).toEqual([])
  })
})

describe('tone', () => {
  it('bans condescension at advanced only', () => {
    expect(toneViolations('Simply take the rook.', 'advanced')).toEqual(['condescension: "simply"'])
    expect(toneViolations('It was just an easy fork.', 'advanced')).toEqual(['condescension: "just"', 'condescension: "easy"'])
    expect(toneViolations('Of course the pawn falls.', 'advanced')).toEqual(['condescension: "of course"'])
    expect(toneViolations('Simply take the rook.', 'beginner')).toEqual([])
    expect(toneViolations('Justice is a word, not a cue.', 'advanced')).toEqual([])
  })

  it('bans discouraging labels at beginner only', () => {
    expect(toneViolations('That was a terrible move.', 'beginner')).toEqual(['discouraging: "terrible"'])
    expect(toneViolations('This blunder lost the queen.', 'beginner')).toEqual(['discouraging: "blunder"'])
    expect(toneViolations('Ra1?? loses.', 'beginner')).toEqual(['discouraging: "??"'])
    expect(toneViolations('This blunder lost the queen.', 'club')).toEqual([])
    expect(toneViolations('The badge is fine.', 'beginner')).toEqual([])
  })

  it('bans sarcasm and worth questions at every band', () => {
    for (const band of BANDS) {
      expect(toneViolations('Nice try, but the rook hangs.', band)).toContain('sarcasm: "nice try"')
      expect(toneViolations('How could you miss that?', band)).toEqual(['worth question: "How could you miss that?"'])
      expect(toneViolations('Do you even look at checks?', band)).toHaveLength(1)
    }
    // A plain question about the position is fine
    expect(toneViolations('What does the knight attack?', 'club')).toEqual([])
  })

  it('allows only the closed move-quality labels', () => {
    expect(toneViolations('Nc4 was the best move and the only move.', 'club')).toEqual([])
    expect(toneViolations('Nc4 is a brilliant move.', 'club')).toEqual(['move label outside set: "brilliant move"'])
    expect(toneViolations('That was an inaccuracy.', 'advanced')).toEqual(['move label outside set: "inaccuracy"'])
    expect(toneViolations('Nf3!? is sharp.', 'advanced')).toEqual(['move label outside set: "!?"'])
  })

  it('caps exclamations at 1 for beginner and 0 above', () => {
    expect(toneViolations('Look for the fork!', 'beginner')).toEqual([])
    expect(toneViolations('Look! A fork!', 'beginner')).toEqual(['exclamations 2 > 1'])
    expect(toneViolations('Look for the fork!', 'club')).toEqual(['exclamations 1 > 0'])
    expect(toneViolations('Look for the fork!', 'advanced')).toEqual(['exclamations 1 > 0'])
  })
})

describe('habit library', () => {
  it('maps every puzzle kind to a family', () => {
    const kinds: [PuzzleKind, Family][] = [
      ['hang', 'safety'],
      ['missed-win', 'tactics'],
      ['lichess', 'tactics'],
      ['conversion', 'conversion'],
      ['hold', 'defense'],
      ['defensive', 'defense'],
    ]
    for (const [k, f] of kinds) expect(family(k)).toBe(f)
  })

  it('has unique ids in implementation-intention form', () => {
    expect(new Set(HABITS.map(h => h.id)).size).toBe(HABITS.length)
    for (const h of HABITS) {
      expect(h.id).toMatch(/^habit:[a-z-]+$/)
      expect(h.text).toMatch(/^When [^,]+, I [^,].*\.$/)
      expect(h.bands.length).toBeGreaterThan(0)
    }
  })

  it('covers every band in every family, with at least 4 habits per family', () => {
    for (const f of FAMILIES) {
      expect(HABITS.filter(h => h.family === f).length).toBeGreaterThanOrEqual(4)
      for (const b of BANDS) expect(HABITS.some(h => h.family === f && h.bands.includes(b)), `${f} × ${b}`).toBe(true)
    }
  })

  it('passes ceilings and tone at every band it is tagged with', () => {
    for (const h of HABITS) for (const b of h.bands) expect(problems(h.text, b), `${h.id} at ${b}`).toEqual([])
  })
})

describe('habit selection', () => {
  const pick = (kind: PuzzleKind, band: Band, recent: string[] = [], weeklyFocusHabitId?: string) =>
    selectHabit({ kind, band, recent, weeklyFocusHabitId }).id

  it('takes the first habit in family and band, in list order', () => {
    expect(pick('hang', 'beginner')).toBe('habit:blunder-check')
    expect(pick('missed-win', 'club')).toBe('habit:cct-scan')
    expect(pick('lichess', 'advanced')).toBe('habit:cct-scan')
    expect(pick('conversion', 'beginner')).toBe('habit:trade-down')
    expect(pick('defensive', 'advanced')).toBe('habit:list-forcing')
    for (const kind of ['hang', 'missed-win', 'conversion', 'hold'] as PuzzleKind[])
      for (const band of BANDS) {
        const first = HABITS.find(h => h.family === family(kind) && h.bands.includes(band))
        expect(pick(kind, band)).toBe(first?.id)
      }
  })

  it('honours the weekly focus only within the puzzle family and band', () => {
    expect(pick('missed-win', 'beginner', [], 'habit:two-targets')).toBe('habit:two-targets')
    // A tactics focus does not override a safety puzzle
    expect(pick('hang', 'beginner', [], 'habit:two-targets')).toBe('habit:blunder-check')
    // A club-only habit is not offered to a beginner
    expect(pick('conversion', 'beginner', [], 'habit:stop-counterplay')).toBe('habit:trade-down')
    expect(pick('conversion', 'club', [], 'habit:stop-counterplay')).toBe('habit:stop-counterplay')
    // The focus repeats on purpose, even if used lately
    expect(pick('missed-win', 'club', ['habit:two-targets'], 'habit:two-targets')).toBe('habit:two-targets')
    // An unknown id is ignored
    expect(pick('hang', 'club', [], 'habit:nope')).toBe('habit:blunder-check')
  })

  it('drops habits from the last 3 explanations only', () => {
    expect(pick('hang', 'beginner', ['habit:blunder-check'])).toBe('habit:loose-pieces')
    expect(pick('hang', 'beginner', ['habit:blunder-check', 'habit:loose-pieces', 'habit:their-move'])).toBe(
      'habit:safe-square',
    )
    // Four back, blunder-check is out of the window and wins again
    expect(
      pick('hang', 'beginner', ['habit:blunder-check', 'habit:loose-pieces', 'habit:their-move', 'habit:safe-square']),
    ).toBe('habit:blunder-check')
    // Habits from other families in the window don't matter
    expect(pick('hang', 'beginner', ['habit:cct-scan', 'habit:trade-down', 'habit:list-forcing'])).toBe(
      'habit:blunder-check',
    )
  })

  it('rotates through the pool in a stable order', () => {
    const recent: string[] = []
    const seen: string[] = []
    for (let i = 0; i < 8; i++) {
      const id = pick('hold', 'beginner', recent)
      seen.push(id)
      recent.push(id)
    }
    const pool = HABITS.filter(h => h.family === 'defense' && h.bands.includes('beginner')).map(h => h.id)
    expect(seen).toEqual([...pool, ...pool].slice(0, 8))
  })
})

describe('motif library', () => {
  it('has an entry for every motif and "none" at every band', () => {
    expect(MOTIF_KEYS).toHaveLength(12)
    expect(MOTIF_KEYS).toContain('none')
    expect(motifEntry('back-rank mate', 'club').id).toBe('gloss:backRankMate')
    expect(motifEntry('removing the defender', 'beginner').id).toBe('gloss:removingTheDefender')
    expect(motifEntry('none', 'advanced').id).toBe('gloss:none')
  })

  it('keeps each gloss and rule to one sentence that passes ceilings and tone', () => {
    for (const m of MOTIF_KEYS)
      for (const b of BANDS) {
        const e = motifEntry(m, b)
        for (const t of [e.gloss, e.rule]) {
          expect(sentences(t), `${m} at ${b}: ${t}`).toHaveLength(1)
          expect(problems(t, b), `${m} at ${b}: ${t}`).toEqual([])
        }
        expect(problems(`${e.gloss} ${e.rule}`, b), `${m} at ${b}`).toEqual([])
      }
  })
})
