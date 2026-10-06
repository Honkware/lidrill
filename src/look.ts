import type { Profile } from './db'

// Piece sets and boards on offer, only sets whose licences fit a GPL app:
// cburnett and merida are GPLv2+, mpchess GPLv3+, chessnut Apache 2.0
// and Prettier is free to use (credits in public/pieces/README.md).
export const PIECE_SETS = [
  { key: 'cburnett', name: 'Lichess (cburnett)' },
  { key: 'merida', name: 'Merida' },
  { key: 'mpchess', name: 'MPChess' },
  { key: 'chessnut', name: 'Chessnut' },
  { key: 'prettier', name: 'Prettier' },
] as const

export const BOARDS = [
  { key: 'brown', name: 'Brown' },
  { key: 'walnut', name: 'Walnut' },
  { key: 'green', name: 'Green' },
  { key: 'blue', name: 'Blue' },
] as const

export const DEFAULT_PIECES = 'cburnett'
export const DEFAULT_BOARD = 'brown'

const ROLES = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' }

export function pieceCss(set: string): string {
  return Object.entries(ROLES)
    .flatMap(([role, letter]) =>
      (['white', 'black'] as const).map(
        color => `.cg-wrap piece.${color}.${role}, .piece-preview.${color}.${role} { background-image: url('/pieces/${set}/${color[0]}${letter}.svg'); }`,
      ),
    )
    .join('\n')
}

export function applyLook(profile?: Pick<Profile, 'theme' | 'pieces' | 'board'>) {
  const root = document.documentElement
  root.dataset.theme = profile?.theme ?? 'dark'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', root.dataset.theme === 'light' ? '#fbf1c7' : '#1d2021')
  root.dataset.board = profile?.board ?? DEFAULT_BOARD
  let style = document.getElementById('piece-set')
  if (!style) {
    style = document.createElement('style')
    style.id = 'piece-set'
    document.head.append(style)
  }
  style.textContent = pieceCss(profile?.pieces ?? DEFAULT_PIECES)
}
