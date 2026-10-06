# lidrill

Turns your own chess games into puzzles. Sign in with Lichess, and lidrill
runs Stockfish over your games in the browser, finds the moves that cost
you, and schedules them as a short daily drill (FSRS). Chess.com games can
be added by username.

Live at <https://lidrill.lidrill.workers.dev>.

There is no server. Games, analysis and puzzles live in IndexedDB in your
browser; the only network calls go to Lichess and Chess.com. The Lichess
token is stored there too and revoked when you sign out.

The first sync pulls your newest 200 games per site. Analysis runs at
depth 14 with the single-threaded Stockfish 19 lite build, which comes to
roughly 5-11 seconds a game, so a full first pass takes a while. Puzzles
show up as each game finishes.

## Development

Needs [Bun](https://bun.sh).

```sh
bun install
bun run dev       # copies the engine into public/engine, then starts Vite
bun run test      # vitest
bun run lint      # oxlint
bun run build     # typecheck + production build into dist/
```

Sign-in redirects to `<origin>/auth`, so it works from `localhost` too.
Lichess needs no app registration for this.

`bun run deploy` builds and publishes `dist/` as Cloudflare Workers static
assets (`wrangler.jsonc`). Wrangler reads `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` from the environment.

The design and its reasoning are in [docs/spec.md].

## License

GPL-3.0-or-later.
