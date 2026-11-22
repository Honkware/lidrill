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

| Maia's p of the opponent's move | moves | median s | p90 s |
|---|---|---|---|
| <0.05 | 3106 | 5 | 23 |
| <0.2 | 5700 | 5 | 23 |
| <0.5 | 7072 | 4 | 21 |
| >=0.5 | 9089 | 4 | 19 |

## Candidate features

All candidates fitted together. Effect is the change in predicted time across the feature's 10th to 90th percentile, or from 0 to 1 for a flag; under 5% it is dropped.

| feature | coef | effect | kept |
|---|---|---|---|
| check | +0.715 | +104% | yes |
| inc | +0.062 | +85% | yes |
| log_base | +0.453 | +107% | yes |
| log_left | +0.012 | +3% | no |
| log_legal | +0.310 | +39% | yes |
| log_p | -0.109 | -29% | yes |
| ply_10 | +0.565 | +76% | yes |
| ply_20 | +0.945 | +157% | yes |
| ply_40 | +0.977 | +166% | yes |
| ply_60 | +0.551 | +73% | yes |
| prev_log_p | -0.051 | -15% | yes |
| rating | +0.006 | +8% | yes |
| recapture | -0.406 | -33% | yes |
| spread | +0.280 | +80% | yes |

## Final fit

OLS on log seconds with check, inc, log_base, log_legal, log_p, ply_10, ply_20, ply_40, ply_60, prev_log_p, rating, recapture, spread. Residual sd 0.923 in log seconds, R squared 0.351 on the fitted moves and 0.332 on the held-out ones. At play time the time is drawn from a lognormal around the prediction with that sd, at least 0.5 s and at most a quarter of the clock left plus the increment. People went over that cap on 2.0% of the fitted moves. With no clock the ceiling is 38 s, the 97th percentile of 600+0 moves.

| feature | coef |
|---|---|
| const | -3.6893 |
| check | +0.7154 |
| inc | +0.0617 |
| log_base | +0.4665 |
| log_legal | +0.3099 |
| log_p | -0.1088 |
| ply_10 | +0.5644 |
| ply_20 | +0.9417 |
| ply_40 | +0.9690 |
| ply_60 | +0.5347 |
| prev_log_p | -0.0510 |
| rating | +0.0057 |
| recapture | -0.4063 |
| spread | +0.2805 |

## Held-out games

Data against one draw per move from the model, capped by each move's own clock.

| ply | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| 2-9 | 1163 | 3 | 11 | 2.6 | 10.8 |
| 10-19 | 1152 | 4 | 20 | 4.5 | 19.3 |
| 20-39 | 1851 | 6 | 29 | 6.6 | 25.8 |
| 40-59 | 1164 | 6 | 26 | 5.9 | 24.5 |
| 60+ | 992 | 3 | 13 | 2.9 | 13.5 |

| rating | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| 600-799 | 732 | 5 | 19 | 4.7 | 20.0 |
| 800-999 | 726 | 5 | 20 | 4.5 | 20.8 |
| 1000-1199 | 650 | 5 | 20 | 4.9 | 20.5 |
| 1200-1399 | 701 | 4 | 22 | 4.7 | 20.5 |
| 1400-1599 | 618 | 4 | 20 | 4.7 | 20.7 |
| 1600-1799 | 748 | 4 | 22 | 4.7 | 22.9 |
| 1800-1999 | 764 | 4 | 24 | 4.3 | 17.5 |
| 2000-2199 | 735 | 4 | 24 | 4.4 | 17.9 |
| 2200-2399 | 648 | 4 | 21 | 3.5 | 16.0 |

| time control | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| 180+0 | 896 | 2 | 8 | 2.7 | 11.2 |
| 180+2 | 982 | 3 | 15 | 2.9 | 12.0 |
| 300+0 | 932 | 3 | 13 | 3.4 | 14.2 |
| 300+3 | 886 | 5 | 21 | 4.2 | 15.3 |
| 600+0 | 834 | 5 | 20 | 4.9 | 19.1 |
| 600+5 | 931 | 8 | 31 | 6.7 | 26.9 |
| 900+10 | 861 | 10 | 48 | 11.4 | 41.9 |

| clock left / base | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| <0.1 | 257 | 2 | 9 | 2.5 | 7.8 |
| <0.25 | 325 | 4 | 17 | 3.4 | 13.4 |
| <0.5 | 675 | 5 | 25 | 4.3 | 16.9 |
| <0.75 | 1050 | 6 | 29 | 5.3 | 20.9 |
| >=0.75 | 4015 | 4 | 20 | 4.6 | 21.3 |

| recapture | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| no | 5726 | 5 | 22 | 4.8 | 20.8 |
| yes | 596 | 2 | 11 | 2.4 | 10.3 |

| plausible moves | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| <1.5 | 858 | 2 | 13 | 2.7 | 11.2 |
| <3 | 1483 | 3 | 18 | 3.7 | 14.9 |
| <6 | 1896 | 5 | 22 | 4.6 | 21.3 |
| >=6 | 2085 | 6 | 26 | 6.1 | 24.6 |

| Maia's p of the opponent's move | moves | median s | p90 s | model median s | model p90 s |
|---|---|---|---|---|---|
| <0.05 | 803 | 5 | 24 | 6.2 | 26.1 |
| <0.2 | 1419 | 5 | 21 | 4.8 | 22.1 |
| <0.5 | 1759 | 4 | 22 | 4.2 | 17.8 |
| >=0.5 | 2341 | 4 | 20 | 4.1 | 18.1 |
