import type { FuturesDepthBook } from "./depthBook";

export interface HeatSide {
  ticks: Int32Array;
  qty: Float32Array;
}

export interface HeatColumn {
  time: number;
  bids: HeatSide;
  asks: HeatSide;
}

/** About seven minutes at one sample per second. Older columns are dropped. */
const MAX_COLUMNS = 420;
/** Nearest levels to the mid, per side. The public snapshot is not infinite. */
const MAX_LEVELS = 700;

export class HeatmapTape {
  columns: HeatColumn[] = [];

  /** Samples only a synced book. There is no historical depth endpoint to warm this up. */
  sample(time: number, book: FuturesDepthBook): boolean {
    if (!book.synced) return false;
    const bid = book.bestBidTick();
    const ask = book.bestAskTick();
    if (bid === null || ask === null) return false;
    const mid = Math.round((bid + ask) / 2);
    this.columns.push({
      time,
      bids: nearest(book.entries("bid"), mid),
      asks: nearest(book.entries("ask"), mid),
    });
    if (this.columns.length > MAX_COLUMNS) {
      this.columns.splice(0, this.columns.length - MAX_COLUMNS);
    }
    return true;
  }

  clear(): void {
    this.columns = [];
  }
}

export function sumQty(side: HeatSide, lo: number, hi: number): number {
  const { ticks, qty } = side;
  if (hi < lo || ticks.length === 0) return 0;
  let index = lowerBound(ticks, lo);
  let total = 0;
  for (; index < ticks.length && ticks[index] <= hi; index++) total += qty[index];
  return total;
}

function nearest(entries: Array<[number, number]>, mid: number): HeatSide {
  const ranked = entries
    .filter(([, qty]) => qty > 0)
    .sort((a, b) => Math.abs(a[0] - mid) - Math.abs(b[0] - mid) || a[0] - b[0])
    .slice(0, MAX_LEVELS)
    .sort((a, b) => a[0] - b[0]);
  const ticks = new Int32Array(ranked.length);
  const qty = new Float32Array(ranked.length);
  for (let i = 0; i < ranked.length; i++) {
    ticks[i] = ranked[i][0];
    qty[i] = ranked[i][1];
  }
  return { ticks, qty };
}

function lowerBound(ticks: Int32Array, target: number): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
