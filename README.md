# lidrill

lidrill ([lidrill.org](https://lidrill.org)) is a personal mistake coach for chess. It turns your own Lichess and Chess.com games into a short daily drill, scheduled with spaced repetition so the positions you keep missing come back more often, and it explains each mistake with engine-checked text and arrows on the board. You can also play Maia-3, a model that plays like a person, at about your own level: the level is set with the rating calibration measured in [LevelRL](https://github.com/Honkware/levelrl) (`maia-calibrate` on PyPI) and follows your results, and the mistakes you make in those games become puzzles too.

## What it does

- Train is the daily drill. A first visit opens on three sample puzzles, before any sign-in.
- "Why?" explains a mistake. The model never sees the board: Stockfish certifies the position in the browser, the server turns the engine's lines into numbered facts, and a rule-based checker rejects any draft that names a move, pattern or mate outside them. A draft that fails gets a fixed text built from the same facts.
- Openings teaches the openings you pick against the replies Maia-3 gives at your rating, reviews them on the same schedule as the puzzles, and lets you spar an opening from move 1.
- Play Maia is a whole game with a clock, at human think times, and Turning Points replays one of your own games and stops where it turned.
- Everything is stored in the browser and works offline. A Lichess sign-in or a sync code keeps devices in step.

[docs/compared.md](docs/compared.md) sets it beside Lichess's "Learn from your mistakes", Chess.com Game Review and Chessable. [ARCHITECTURE.md](ARCHITECTURE.md) has the diagram and every endpoint, [docs/explanations.md](docs/explanations.md) follows a "Why?" request step by step, and [docs/maia.md](docs/maia.md) covers the calibrated level and the fitted think times and resignations.

The paid evaluation of the explanations (`bun run test:gate`) was last run in October 2026, so the current prompt has only been run against the scripted drafts that `bun run gate:offline` checks in CI.

## Development

You need [Bun](https://bun.sh).

```sh
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

`bun run dev` serves the app at `http://localhost:5173` and starts the Worker beside it. Explanations need your own OpenRouter key in `.dev.vars`, and sync, Play Maia and the opening trees need the Python service, which `server/README.md` shows how to start. To host your own copy, follow the configuration table in `ARCHITECTURE.md`.

## Licence and credits

lidrill is AGPL-3.0-or-later because the move labels, the move list and the pattern rules are ported from [lila](https://github.com/lichess-org/lila) and [lichess-puzzler](https://github.com/ornicar/lichess-puzzler). The board is [chessground](https://github.com/lichess-org/chessground), the rules come from [chessops](https://github.com/niklasf/chessops), and the engine is [Stockfish](https://stockfishchess.org) 19 through [stockfish.js](https://github.com/nmrugg/stockfish.js). [Maia-3](https://github.com/CSSLab/maia3) is by the CSSLab at the University of Toronto, and its code and weights are AGPL-3.0. The weights are not in this repo. Licences for the piece sets, fonts and sounds are in `public/`.

This is an independent project with no connection to Lichess, Chess.com, Chessable or the CSSLab beyond using the first two's public APIs.
