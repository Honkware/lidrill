// Stockfish runs as its own worker script, so it has to be served as a plain
// file next to the app rather than bundled.
import { copyFileSync, mkdirSync } from 'node:fs'

const from = 'node_modules/stockfish/bin/'
const to = 'public/engine/'
mkdirSync(to, { recursive: true })
for (const file of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  copyFileSync(from + file, to + file)
}
