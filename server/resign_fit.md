# Resign and draw fit

Written by fit_resign.py from lichess_db_standard_rated_2025-10.pgn.zst.part. Games at 180+0, 180+2, 300+0, 300+3, 600+0, 600+5, 900+10, rated, no bots, ratings 600 to 2399. A score is Maia's expected score for the side to move (a win plus half a draw) from its value head, at the calibrated setting nearest the player's rating.

## Where people resign

The resigner's score at the last position with them to move.

| rating | games | median move | median score | p75 | p90 |
|---|---|---|---|---|---|
| 600-799 | 300 | 18 | 0.234 | 0.369 | 0.496 |
| 800-999 | 300 | 24 | 0.199 | 0.292 | 0.395 |
| 1000-1199 | 300 | 24 | 0.140 | 0.228 | 0.365 |
| 1200-1399 | 300 | 28 | 0.107 | 0.201 | 0.324 |
| 1400-1599 | 300 | 27 | 0.111 | 0.189 | 0.294 |
| 1600-1799 | 300 | 29 | 0.079 | 0.136 | 0.281 |
| 1800-1999 | 300 | 33 | 0.085 | 0.151 | 0.262 |
| 2000-2199 | 300 | 31 | 0.069 | 0.126 | 0.213 |
| 2200-2399 | 300 | 32 | 0.086 | 0.140 | 0.270 |

5% of all resignations came before move 9.

## How long people play on

Median number of their own turns spent under a score, for players who were mated and for players who did not lose.

| rating | mated | under 0.05 | under 0.1 | under 0.2 | did not lose | under 0.05 | under 0.1 | under 0.2 |
|---|---|---|---|---|---|---|---|---|
| 600-799 | 60 | 0 | 0 | 2 | 120 | 0 | 0 | 0 |
| 800-999 | 60 | 0 | 0 | 4 | 120 | 0 | 0 | 0 |
| 1000-1199 | 60 | 0 | 0 | 2 | 120 | 0 | 0 | 0 |
| 1200-1399 | 60 | 0 | 1 | 2 | 120 | 0 | 0 | 0 |
| 1400-1599 | 60 | 0 | 2 | 6 | 120 | 0 | 0 | 0 |
| 1600-1799 | 60 | 0 | 1 | 3 | 120 | 0 | 0 | 0 |
| 1800-1999 | 60 | 0 | 2 | 5 | 120 | 0 | 0 | 0 |
| 2000-2199 | 60 | 1 | 2 | 6 | 120 | 0 | 0 | 0 |
| 2200-2399 | 60 | 1 | 2 | 6 | 120 | 0 | 0 | 0 |

## The rule

Maia resigns when its score has been under its band's threshold on each of its last 3 turns, from move 9 on. The threshold is the highest of 0.01 to 0.49 that would have resigned for at most 2% of the players who did not lose in the band and the bands either side. The share in the table is for the band alone, on the same games the threshold was chosen on.

| rating | threshold | resigns, did not lose | resigns, mated | median turns before mate | resignations under it |
|---|---|---|---|---|---|
| 600-799 | 0.20 | 1.7% | 40% | 10 | 37% |
| 800-999 | 0.19 | 0.8% | 48% | 7 | 47% |
| 1000-1199 | 0.13 | 2.5% | 25% | 8 | 48% |
| 1200-1399 | 0.14 | 3.3% | 28% | 7 | 61% |
| 1400-1599 | 0.14 | 0.0% | 43% | 9 | 62% |
| 1600-1799 | 0.13 | 1.7% | 32% | 10 | 72% |
| 1800-1999 | 0.08 | 0.8% | 23% | 5 | 47% |
| 2000-2199 | 0.08 | 4.2% | 30% | 10 | 54% |
| 2200-2399 | 0.07 | 0.0% | 30% | 9 | 40% |

## Agreed draws

A draw by agreement is not marked in the PGN, so these are the draws whose final position was not stalemate, a threefold repetition, the fifty-move rule or insufficient material. A repetition claimed before the position came up a third time, or a draw agreed in a repeated position, would be counted wrong. Who offered is not recorded either, so the table gives how far the final position was from even.

| games | median move | p5 move | median abs(score - 0.5) | p75 | p90 |
|---|---|---|---|---|---|
| 540 | 33 | 3 | 0.062 | 0.132 | 0.279 |

Maia accepts a draw offered from move 20 on, a chosen number, when its own score is at most 0.5 + 0.06, the gap in 50% of these draws.
