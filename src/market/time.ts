export const TIMEFRAMES = ["1m", "5m", "15m"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Binance kline buckets are aligned to the Unix epoch, not a local calendar. */
export function timeframeMs(timeframe: Timeframe): number {
  if (timeframe === "1m") return 60_000;
  if (timeframe === "5m") return 300_000;
  return 900_000;
}

export function bucketStart(timeMs: number, timeframe: Timeframe): number {
  const size = timeframeMs(timeframe);
  return Math.floor(timeMs / size) * size;
}
