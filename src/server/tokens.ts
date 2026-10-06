// Moves and squares as they're written in an explanation: SAN with an
// optional move number and check mark ("Nf3", "10...exd5", "O-O", "e8=Q+"),
// or a bare square ("e4"). Shared by the server's checker and the client's
// board links so both read the text the same way.
export const TOKEN = /\b(?:\d+\.(?:\.\.)?\s?)?(O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?(?![\w-])/g

export const isSquare = (s: string) => /^[a-h][1-8]$/.test(s)

export interface Token {
  text: string // as written
  san: string // without move number or + / #
  index: number
}

export function tokens(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map(m => ({ text: m[0], san: m[1], index: m.index }))
}
