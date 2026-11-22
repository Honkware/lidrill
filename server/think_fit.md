# Think-time fit

Written by fit_think.py from lichess_db_standard_rated_2025-10.pgn.zst.part: 24967 moves from 6988 games to fit and 6322 moves from 1750 other games held out. Time controls 180+0, 180+2, 300+0, 300+3, 600+0, 600+5, 900+10, ratings 600 to 2399, up to 500 moves per time control and 200-point band and 2 per player per game. Times are whole seconds, and a 0 s move counts as 0.5 s in the fit.

## The data

| ply | moves | median s | p90 s |
|---|---|---|---|
| 2-9 | 4393 | 2 | 11 |
| 10-19 | 4876 | 4 | 21 |
| 20-39 | 7377 | 6 | 28 |
| 40-59 | 4459 | 6 | 26 |
| 60+ | 3862 | 3 | 13 |

| rating | moves | median s | p90 s |
|---|---|---|---|
| 600-799 | 2768 | 5 | 22 |
| 800-999 | 2774 | 5 | 21 |
| 1000-1199 | 2850 | 5 | 20 |
| 1200-1399 | 2799 | 4 | 20 |
| 1400-1599 | 2882 | 4 | 21 |
| 1600-1799 | 2752 | 4 | 20 |
| 1800-1999 | 2736 | 4 | 22 |
| 2000-2199 | 2765 | 4 | 24 |
| 2200-2399 | 2641 | 4 | 22 |

| time control | moves | median s | p90 s |
|---|---|---|---|
| 180+0 | 3604 | 2 | 9 |
| 180+2 | 3518 | 3 | 13 |
| 300+0 | 3568 | 3 | 13 |
| 300+3 | 3614 | 5 | 20 |
| 600+0 | 3666 | 5 | 20 |
| 600+5 | 3569 | 7 | 31 |
| 900+10 | 3428 | 10 | 46 |

| clock left / base | moves | median s | p90 s |
|---|---|---|---|
| <0.1 | 949 | 2 | 10 |
| <0.25 | 1203 | 4 | 16 |
| <0.5 | 2668 | 5 | 24 |
| <0.75 | 4396 | 6 | 29 |
| >=0.75 | 15751 | 4 | 19 |

| recapture | moves | median s | p90 s |
|---|---|---|---|
| no | 22755 | 5 | 22 |
| yes | 2212 | 2 | 9 |

| in check | moves | median s | p90 s |
|---|---|---|---|
| no | 23263 | 4 | 22 |
| yes | 1704 | 3 | 12 |

| plausible moves | moves | median s | p90 s |
|---|---|---|---|
| <1.5 | 3473 | 2 | 11 |
| <3 | 5680 | 4 | 18 |
| <6 | 7648 | 5 | 21 |
| >=6 | 8166 | 6 | 27 |

## Candidate features

All candidates fitted together. Effect is the change in predicted time across the feature's 10th to 90th percentile, or from 0 to 1 for a flag; under 5% it is dropped.

| feature | coef | effect | kept |
|---|---|---|---|
| check | +0.722 | +106% | yes |
| inc | +0.061 | +84% | yes |
| log_base | +0.457 | +109% | yes |
| log_left | +0.010 | +2% | no |
| log_legal | +0.317 | +40% | yes |
| log_p | -0.110 | -30% | yes |
| ply_10 | +0.560 | +75% | yes |
| ply_20 | +0.937 | +155% | yes |
| ply_40 | +0.966 | +163% | yes |
| ply_60 | +0.534 | +71% | yes |
| rating | +0.005 | +7% | yes |
| recapture | -0.431 | -35% | yes |
| spread | +0.283 | +81% | yes |

## Final fit

OLS on log seconds with check, inc, log_base, log_legal, log_p, ply_10, ply_20, ply_40, ply_60, rating, recapture, spread. Residual sd 0.926 in log seconds, R squared 0.346 on the fitted moves and 0.327 on the held-out ones. At play time the time is drawn from a lognormal around the prediction with that sd, at least 0.5 s and at most a quarter of the clock left plus the increment. People went over that cap on 2.0% of the fitted moves. With no clock the ceiling is 38 s, the 97th percentile of 600+0 moves.

| feature | coef |
|---|---|
| const | -3.6443 |
| check | +0.7226 |
| inc | +0.0611 |
| log_base | +0.4682 |
| log_legal | +0.3175 |
| log_p | -0.1097 |
| ply_10 | +0.5598 |
| ply_20 | +0.9346 |
| ply_40 | +0.9592 |
| ply_60 | +0.5211 |
| rating | +0.0050 |
| recapture | -0.4308 |
| spread | +0.2830 |

## Held-out games

Data against one draw per move from the model, capped by each move's own clock.

| ply | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| 2-9 | 1163 | 3 | 11 | 2.6 | 10.6 |
| 10-19 | 1152 | 4 | 20 | 4.5 | 19.3 |
| 20-39 | 1851 | 6 | 29 | 6.5 | 26.2 |
| 40-59 | 1164 | 6 | 26 | 5.9 | 23.7 |
| 60+ | 992 | 3 | 13 | 3.0 | 13.1 |

| rating | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| 600-799 | 732 | 5 | 19 | 4.8 | 20.7 |
| 800-999 | 726 | 5 | 20 | 4.5 | 21.0 |
| 1000-1199 | 650 | 5 | 20 | 4.9 | 20.3 |
| 1200-1399 | 701 | 4 | 22 | 4.8 | 21.5 |
| 1400-1599 | 618 | 4 | 20 | 4.7 | 20.6 |
| 1600-1799 | 748 | 4 | 22 | 4.6 | 23.1 |
| 1800-1999 | 764 | 4 | 24 | 4.3 | 16.8 |
| 2000-2199 | 735 | 4 | 24 | 4.5 | 17.6 |
| 2200-2399 | 648 | 4 | 21 | 3.5 | 16.4 |

| time control | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| 180+0 | 896 | 2 | 8 | 2.7 | 11.2 |
| 180+2 | 982 | 3 | 15 | 2.9 | 12.3 |
| 300+0 | 932 | 3 | 13 | 3.4 | 14.2 |
| 300+3 | 886 | 5 | 21 | 4.2 | 15.0 |
| 600+0 | 834 | 5 | 20 | 5.0 | 18.4 |
| 600+5 | 931 | 8 | 31 | 6.7 | 26.5 |
| 900+10 | 861 | 10 | 48 | 11.7 | 40.9 |

| clock left / base | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| <0.1 | 257 | 2 | 9 | 2.5 | 7.7 |
| <0.25 | 325 | 4 | 17 | 3.4 | 13.5 |
| <0.5 | 675 | 5 | 25 | 4.3 | 17.3 |
| <0.75 | 1050 | 6 | 29 | 5.3 | 21.0 |
| >=0.75 | 4015 | 4 | 20 | 4.6 | 21.4 |

| recapture | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| no | 5726 | 5 | 22 | 4.8 | 20.8 |
| yes | 596 | 2 | 11 | 2.4 | 10.4 |

| plausible moves | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| <1.5 | 858 | 2 | 13 | 2.7 | 10.9 |
| <3 | 1483 | 3 | 18 | 3.7 | 15.0 |
| <6 | 1896 | 5 | 22 | 4.6 | 21.3 |
| >=6 | 2085 | 6 | 26 | 6.1 | 24.6 |
