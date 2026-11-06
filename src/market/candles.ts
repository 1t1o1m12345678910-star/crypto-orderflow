export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Exchange total volume. This is not split into aggressive buy and sell. */
  volume: number;
}

/** REST klines are OHLC plus total volume. They never carry footprint cells. */
export function parseKlines(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const candles: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const openTime = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (![openTime, open, high, low, close, volume].every(Number.isFinite)) continue;
    candles.push({ openTime, open, high, low, close, volume });
  }
  return candles;
}
