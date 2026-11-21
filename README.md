# lidrill

lidrill ([lidrill.org](https://lidrill.org)) pulls your games from Lichess or Chess.com, runs Stockfish over them in the browser, and gives you back the positions where you went wrong as a short daily drill. The puzzles are scheduled with spaced repetition, so the ones you keep missing come back more often.

## Explanations

After a puzzle you can tap "Why?" to get an explanation in plain language. I didn't want an LLM guessing about a chess position, since they get moves wrong often, so the model never sees the board:

1. Stockfish searches the position in your browser.
2. The Worker turns the engine's lines into a list of facts, such as the evals, the threat, captures, mates and any tactical patterns it detected.
3. The model writes the explanation, but it can only point at those facts by id.
4. A rule-based checker rejects a draft that mentions a move, pattern or mate that isn't in the facts, and a second model drops any claim with no fact behind it.
5. If the draft still fails after one repair attempt, you get a simpler explanation built directly from the facts.

The moves in the final text are filled in from the engine's lines by the renderer. An explanation costs between 1 and 2 cents in model calls.

## What else it does

- Turning Points replays one of your games and stops at the moves where it turned.
- Conversion and defense drills let you play out your own positions against Stockfish.
- Signed-in accounts sync between devices. Otherwise everything stays in your browser.

## Development

You need [Bun](https://bun.sh).

```sh
bun install
bun run dev
bun run test
```

`bun run dev` starts the app without explanations, because those need the Worker. To try them locally, run `bun run build` and then `wrangler dev`, with your OpenRouter key in `.dev.vars` (there is a `.dev.vars.example` to copy).

If you want to host your own copy, change the route in `wrangler.jsonc` and the allowed origins in `worker/index.ts`, create a `PACKETS` KV namespace, and set the `OPENROUTER_API_KEY` and `POW_SECRET` secrets. The sync service lives in `server/` and is described in `docs/server-tier.md`.

## Licence and credits

lidrill is AGPL-3.0-or-later because the move labels and the pattern rules are ported from [lila](https://github.com/lichess-org/lila) and [lichess-puzzler](https://github.com/ornicar/lichess-puzzler). The board is [chessground](https://github.com/lichess-org/chessground), the rules come from [chessops](https://github.com/niklasf/chessops), and the engine is [Stockfish](https://stockfishchess.org) 19 through [stockfish.js](https://github.com/nmrugg/stockfish.js). Licences for the piece sets and fonts are in `public/`.

This is an independent project and has no connection to Lichess or Chess.com beyond using their public APIs.
