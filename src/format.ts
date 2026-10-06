// "+1.2" / "−0.5" from centipawns
export const pawns = (cp: number) => `${cp >= 0 ? '+' : '−'}${(Math.abs(cp) / 100).toFixed(1)}`
