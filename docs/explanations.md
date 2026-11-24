# Puzzles and explanations

A puzzle is a position from one of your games where you had one good move and played another. "Why?" explains the difference in words a model wrote but could not make up, because every move, piece and number in the text has to come from a fact Stockfish certified. This page follows a mistake from the game to the puzzle, and a "Why?" tap from the browser to the text on screen.

## From a mistake to a puzzle

`findCandidates` in `src/puzzles/generate.ts` takes each of your moves after ply 10 that is out of book and dropped the eval by the band's threshold (300, 150 or 100 centipawns), in a position that was not already decided. `generatePuzzles` then searches the position at depth 16 with two lines and keeps it only if all of these hold:

1. The best move beats the second by the band's margin, or it is the only one that mates (`isUnique`). When two or three moves hold and yours was not one of them, the position becomes a hold puzzle that accepts any of them.
2. The second move does not also win. `ALSO_WINS_CP` is 500, the eval that `verdictOf` calls winning. A mate counts as its own answer only when the solution is long enough to play it out.
3. The best move takes, checks, promotes, starts a pattern `motifs.ts` can name, attacks or saves a loose piece, or changes a feature `features.ts` can name. A quiet move with none of that has to beat the second by `QUIET_GAP_CP`, 300.
4. It is not a plain recapture, and the engine at depth does not prefer the move you played.
5. Maia-3, asked as a player 300 points above your rating in that game, gives the move at least `MAIA_MIN_P`, 0.01. The probability is stored on the puzzle as `maiaP`. When Maia cannot be reached the puzzle is made without it.
6. The solution fits the band's cap of 2, 3 or 5 plies.

A game that is analysed again only adds puzzles it did not have, so a card's schedule is never reset.

## The arrows

`whyShapes` in `src/puzzles/whyShapes.ts` returns chessground shapes from the puzzle row and whatever is stored for it: the move played in red, the capture or mate it allowed (or the certified threat) in orange, the best move in green, and a green circle where the best line lands next. It makes no engine call and no request.

## A "Why?" request

| Step | Where | What happens |
| --- | --- | --- |
| Saved row | `src/explain.ts` | An explanation already in IndexedDB for this puzzle, wrong try and solving move is shown as it is. |
| Certify | `src/explain.ts` | Stockfish searches the position, the position with the move passed, and the position after the game move, to depth 24. The runs are kept in `db.certs`, and idle time certifies today's and tomorrow's queue ahead. |
| Packet | `src/server/packet.ts` | The Worker replays every line, detects patterns and builds the list of facts with their ids. `POST /api/packet` stores it for 30 days under a hash of the position, solution, band and versions. |
| Ask | `worker/index.ts` | `POST /api/explain` carries a proof of work and either the packet's hash or the whole report. It is limited to 8 a minute per visitor. |
| Caches | `worker/index.ts` | The Cache API answers a repeat of the same request for a day. The packet store answers a repeat of the same position, game move, best move, band, wrong try and solving move for 30 days, under `why/<prompt version>/<explanation version>/`. Neither costs a model call. |
| Draft | `src/server/narrate.ts` | The first model writes three or four slots as JSON, with `{ref:id}` wherever a fact goes. It never sees the board. |
| Validator | `src/server/slots.ts` | Rules reject notation outside a ref, an unknown id, an uncertified pattern, mate, "only move" or "stops", the wrong owner, and text over the band's reading budget. A rejected draft gets one repair call. |
| Trace | `src/server/trace.ts` | If every word the model wrote is in a list of plain words or appears in a fact cited in the same sentence, the draft is served. |
| Claim check | `src/server/narrate.ts` | Any other draft goes to a second model at temperature 0, which splits it into claims. Claims with no fact behind them are cut, and if more than 30% go the floor is used. |
| Floor | `src/server/floor.ts` | A fixed text built from the facts, used whenever the packet was not certified, a draft failed twice, or the budget of 5 calls and $0.05 ran out. |
| Render | `src/server/render.ts` | The browser turns each id into a move, amount or library sentence from the packet and links moves to the board. |

Every answer carries `x-lidrill-path` (`cache`, `one-pass`, `repair`, `second-pass` or `floor`), `x-lidrill-calls` and `x-lidrill-cost`, and the Worker logs the same on one `[explain]` line.

## Checking it

`bun run gate:offline` rebuilds the packets from saved engine reports, writes known errors into the floor text and fails if the validator misses one, or if an unsupported claim would be served without the claim check. `bun run test:gate` runs the real models and costs money, so a change to the prompt is not proven until it has been run.
