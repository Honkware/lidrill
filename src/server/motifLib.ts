import type { Band } from '../db'
import type { MotifName } from './motifs'

// What each tactical pattern is and the rule to carry from it, as fixed text
// per band. The narrator names an entry by id and the renderer inserts the
// strings as written, so the model never defines a chess term itself.
// Beginner text defines the terms it uses; advanced text says the same thing
// plainly, without talking down. Change the texts only together with the
// version.

export const MOTIF_LIB_VERSION = 'motifLib/1.0'

export type MotifKey = MotifName | 'none'

export interface MotifEntry {
  id: string // 'gloss:<camelCaseMotif>', the same at every band
  gloss: string // what it is, one short sentence
  rule: string // the rule to take into the next game, one short sentence
}

type Texts = Record<Band, { gloss: string; rule: string }>

const TEXTS: Record<MotifKey, Texts> = {
  'smothered mate': {
    beginner: {
      gloss: 'Smothered mate: a knight checks a king boxed in by its men.',
      rule: 'When the king has no free squares, look for knight checks.',
    },
    club: {
      gloss: 'In a smothered mate, a knight mates a king boxed in by its own pieces.',
      rule: 'When the king is hemmed in by its own pieces, look for knight checks.',
    },
    advanced: {
      gloss: 'A smothered mate is a knight mate against a king blocked in by its own pieces.',
      rule: 'Against a king with no flight squares, test each knight check, sacrifices first.',
    },
  },
  'back-rank mate': {
    beginner: {
      gloss: 'Back rank mate: a rook checks a king stuck behind its pawns.',
      rule: 'Give your king a free square, and check theirs.',
    },
    club: {
      gloss: 'In a back-rank mate, a rook or queen mates a king trapped behind its own pawns.',
      rule: 'Make sure your king has an escape square, and look for kings without one.',
    },
    advanced: {
      gloss: 'A back-rank mate lands on the first rank against a king walled in by its pawns.',
      rule: 'Count the guards of the back rank; an overloaded guard often decides it.',
    },
  },
  'double check': {
    beginner: {
      gloss: 'Double check: two pieces give check at once.',
      rule: 'The king must move, since no one block or take stops both.',
    },
    club: {
      gloss: 'In a double check, two pieces give check at the same time.',
      rule: 'The king has to move, so look for checks that open a second line.',
    },
    advanced: {
      gloss: 'A double check attacks the king with two pieces at once, so only a king move answers it.',
      rule: 'When a discovered check is possible, see whether the moving piece can check too.',
    },
  },
  promotion: {
    beginner: {
      gloss: 'To promote, a pawn reaches the last row and becomes a queen.',
      rule: 'Push a free pawn, and stop theirs before it gets far.',
    },
    club: {
      gloss: 'Promotion: a pawn that reaches the last rank becomes a new piece, most often a queen.',
      rule: 'Count the moves to promote, and stop passed pawns early.',
    },
    advanced: {
      gloss: 'Promotion turns a pawn on the last rank into a new piece, often with a tempo.',
      rule: 'Count the race to promotion, and look for checks or deflections that clear the path.',
    },
  },
  'trapped piece': {
    beginner: {
      gloss: 'A trapped piece has no safe square to go to.',
      rule: 'Before you move a piece out, make sure it can get back.',
    },
    club: {
      gloss: 'A trapped piece is attacked and has no safe square left.',
      rule: 'Keep a way out for each piece, and look for enemy pieces without one.',
    },
    advanced: {
      gloss: 'A trapped piece has no safe square left, so an attack on it wins material.',
      rule: 'Check the retreat squares of advanced pieces, yours and theirs, before you commit.',
    },
  },
  fork: {
    beginner: {
      gloss: 'A fork is one piece that hits two things at once.',
      rule: 'Look for a move that hits two of their pieces.',
    },
    club: {
      gloss: 'A fork is one piece attacking two targets at once.',
      rule: 'Look for squares where one of your pieces can hit two loose pieces or the king.',
    },
    advanced: {
      gloss: 'A fork attacks two targets with one piece, and only one can be saved.',
      rule: 'List loose pieces and the king first; forks follow from those targets.',
    },
  },
  skewer: {
    beginner: {
      gloss: 'A skewer attacks a big piece; it moves, the one behind falls.',
      rule: 'Look for their king or queen lined up with a piece behind.',
    },
    club: {
      gloss: 'A skewer attacks a valuable piece; when it moves, the piece behind it is taken.',
      rule: 'Keep your king and queen off lines with a loose piece behind them.',
    },
    advanced: {
      gloss: 'A skewer attacks a valuable piece and wins the one behind it once it moves.',
      rule: 'Check every line through the king and queen for a loose piece behind.',
    },
  },
  pin: {
    beginner: {
      gloss: 'A pinned piece cannot move, or the big piece behind it falls.',
      rule: 'Look for a piece stuck in front of their king or queen.',
    },
    club: {
      gloss: 'In a pin, a piece cannot move because a stronger piece behind it would hang.',
      rule: 'Attack the pinned piece again, because it cannot run.',
    },
    advanced: {
      gloss: 'A pin freezes a piece because moving it would expose a more valuable piece behind.',
      rule: 'Pile up on the pinned piece, and remember a pinned piece does not defend.',
    },
  },
  'discovered attack': {
    beginner: {
      gloss: 'A piece moves off a line, and the piece behind now attacks.',
      rule: 'Check what your pieces would open up when they move.',
    },
    club: {
      gloss: 'In a discovered attack, one piece moves and opens a line for the piece behind.',
      rule: 'Make the moving piece threaten something too, so they cannot meet both.',
    },
    advanced: {
      gloss: 'A discovered attack uncovers a line piece, so the moving piece gets a free tempo.',
      rule: 'Spend that free move on a check or a capture.',
    },
  },
  'removing the defender': {
    beginner: {
      gloss: 'Take the piece that guards a target, then take the target.',
      rule: 'Ask which of their pieces holds the rest up.',
    },
    club: {
      gloss: 'Take the piece that guards a target first, then take the target.',
      rule: 'Ask which of their pieces guards the most, and attack it.',
    },
    advanced: {
      gloss: 'Removing the defender captures or deflects a guard, so what it guarded falls.',
      rule: 'Map what each defender guards; one with two jobs is the target.',
    },
  },
  'hanging piece': {
    beginner: {
      gloss: 'A hanging piece has no guard and can be taken for free.',
      rule: 'Before each move, check which pieces have no guard.',
    },
    club: {
      gloss: 'A hanging piece is unprotected and can be taken for free.',
      rule: 'Check every capture first: loose pieces drop off.',
    },
    advanced: {
      gloss: 'A hanging piece is undefended, so taking it costs nothing.',
      rule: 'Scan both sides for loose pieces before each move; they drop off.',
    },
  },
  none: {
    beginner: {
      gloss: 'No one trick decides this; the best move does the most work.',
      rule: 'Look at checks, then takes, then threats.',
    },
    club: {
      gloss: 'No named pattern decides this; the best move is the most forcing one.',
      rule: 'Check checks, captures and threats, in that order.',
    },
    advanced: {
      gloss: 'No named pattern decides this; it comes down to concrete calculation.',
      rule: 'Rank candidate moves by how forcing they are, and calculate those first.',
    },
  },
}

const idOf = (m: MotifKey) => `gloss:${m.replace(/[- ](\w)/g, (_, c: string) => c.toUpperCase())}`

export const MOTIF_KEYS = Object.keys(TEXTS) as MotifKey[]

// The entry for a motif at a band
export function motifEntry(motif: MotifKey, band: Band): MotifEntry {
  return { id: idOf(motif), ...TEXTS[motif][band] }
}
