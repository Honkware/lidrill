# lidrill

Turns your own chess games into puzzles. Sign in with Lichess, and lidrill
runs Stockfish over your games in the browser, finds the moves that cost
you, and schedules them as a short daily drill (FSRS). Chess.com games can
be added by username.

Live at <https://lidrill.org>.

Besides the daily puzzles: Turning Points replays a game and stops where it
turned; conversion and defense drills play positions from your games out
against Stockfish; a journal and a zero-hang streak track the games
themselves. Signed in, it also reads your Lichess puzzle dashboard and
mixes in puzzles you failed there (at most 30% of a day).

Games, analysis and puzzles live in IndexedDB in your browser, and the
Lichess token too (revoked when you sign out). The network calls go to
Lichess and Chess.com, plus one to lidrill's own Worker when you tap "Why?"
after a puzzle: it sends that position and Stockfish's lines, and gets back
a two-sentence explanation from a model on OpenRouter.

The first sync pulls your newest 200 games per site. Games Lichess has
already analyzed reuse its evals. The rest are analyzed at depth 14 with
the single-threaded Stockfish 19 lite build, on up to four workers at once
(cores minus one). A full first pass still takes a while; puzzles show up
as each game finishes.

## Development

Needs [Bun](https://bun.sh).

```sh
bun install
bun run dev       # copies the engine into public/engine, then starts Vite
bun run test      # vitest
bun run test:golden  # also the slow Stockfish checks on the reference games
bun run lint      # oxlint
bun run build     # typecheck + production build into dist/
```

Sign-in redirects to `<origin>/auth`, so it works from `localhost` too.
Lichess needs no app registration for this. The default sign-in asks only
for `puzzle:read`; `study:write` and `preference:read` are requested the
first time you use the feature that needs them.

`bun run deploy` builds and publishes `dist/` as Cloudflare Workers static
assets (`wrangler.jsonc`, which also binds lidrill.org). Wrangler reads
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment.
The CSP and other headers are in `public/_headers`. The Worker
(`worker/index.ts`) only handles `/api/explain`; it needs the secret
`OPENROUTER_API_KEY` (`wrangler secret put OPENROUTER_API_KEY`).

The design and its reasoning are in [docs/spec.md].

## License

GPL-3.0-or-later. Piece set credits are in `public/pieces/README.md`.
