# Maia-3 as an opponent

## A rating-calibrated level

Maia-3 takes a rating as input, but the strength it plays at differs from the rating it is given. [LevelRL](https://github.com/Honkware/levelrl) measured the dial value and sampling temperature that play at about every 100 points from 600 to 2300, and `server/maia.py` uses that table through `maia-calibrate`. A level between two measured settings plays each move with one of the two around it, so the number is an approximate Lichess blitz rating.

The level a player meets follows their results: an Elo-style estimate is updated after every game, separately for blitz, rapid and untimed games, and the next opponent is 50 above it (`src/maia.ts`).

## Human think times and resignations

Maia-3's own think-time head is untrained in the released checkpoint, so the time per move comes from a linear fit of log seconds on the position, Maia's move distribution and the clock, made on 24,967 moves from 6,988 Lichess games and checked on 6,322 moves from 1,750 others (`server/think_fit.md`). The fit explains about a third of the variance and the rest is drawn as lognormal noise. Maia resigns when its value head has been under a threshold for three turns, from move 9 on. The thresholds come from 2,700 resigned games, 300 per 200-point rating band, and each is the highest that would have resigned for at most 2% of the players in nearby bands who did not lose, of whom there are 120 per band (`server/resign_fit.md`). Those shares were measured on the same games the thresholds were chosen on.
