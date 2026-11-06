import { bucketStart, timeframeMs, type Timeframe } from "./time";

/** Aggressive buy minus aggressive sell. Buyer-is-maker is an aggressive sell. */
export function tradeDelta(buyerIsMaker: boolean, qty: number): number {
  return buyerIsMaker ? -qty : qty;
}

export interface CvdPoint {
  openTime: number;
  /** This bar only. Positive means more aggressive buy than sell. */
  delta: number;
  /** Session sum through this bar, including bars dropped to save memory. */
  cvd: number;
}

export interface CvdGap {
  from: number;
  to: number;
}

export interface CvdSnapshot {
  points: CvdPoint[];
  /** Delta of discarded bars. Still inside every point's cvd. */
  prefix: number;
  total: number;
  firstTradeTime: number | null;
  gaps: CvdGap[];
}

/**
 * CVD for one session and one timeframe.
 * The zero is the moment before the first trade this page actually received.
 * Zoom, pan, and a view reset must not call reset(). Symbol changes and
 * switching between live and demo replace the whole session instead.
 */
export class SessionCvd {
  private readonly bars = new Map<number, number>();
  private prefix = 0;
  private total = 0;
  private firstTradeTime: number | null = null;
  private gaps: CvdGap[] = [];

  constructor(
    private readonly timeframe: Timeframe,
    private readonly maxBars = 520,
  ) {}

  add(time: number, buyerIsMaker: boolean, qty: number): void {
    if (!(qty > 0) || !Number.isFinite(time)) return;
    const delta = tradeDelta(buyerIsMaker, qty);
    const openTime = bucketStart(time, this.timeframe);
    if (this.firstTradeTime === null || time < this.firstTradeTime) this.firstTradeTime = time;
    this.total += delta;
    if (this.bars.size >= this.maxBars && !this.bars.has(openTime)) {
      let oldest: number | null = null;
      for (const key of this.bars.keys()) {
        if (oldest === null || key < oldest) oldest = key;
      }
      if (oldest !== null && openTime < oldest) {
        this.prefix += delta;
        return;
      }
    }
    this.bars.set(openTime, (this.bars.get(openTime) ?? 0) + delta);
    this.trimToMax();
  }

  private trimToMax(): void {
    while (this.bars.size > this.maxBars) {
      let oldest: number | null = null;
      for (const key of this.bars.keys()) {
        if (oldest === null || key < oldest) oldest = key;
      }
      if (oldest === null) return;
      this.prefix += this.bars.get(oldest) ?? 0;
      this.bars.delete(oldest);
    }
  }

  /** Marks a hole. The sum is not reset and the missing trades are not filled with zero. */
  noteGap(from: number, to: number): void {
    if (!(to > from) || !Number.isFinite(from) || !Number.isFinite(to)) return;
    const all = [...this.gaps, { from, to }].sort((a, b) => a.from - b.from);
    const merged: CvdGap[] = [];
    for (const gap of all) {
      const last = merged[merged.length - 1];
      if (last && gap.from <= last.to) last.to = Math.max(last.to, gap.to);
      else merged.push({ from: gap.from, to: gap.to });
    }
    this.gaps = merged.slice(-24);
  }

  reset(): void {
    this.bars.clear();
    this.prefix = 0;
    this.total = 0;
    this.firstTradeTime = null;
    this.gaps = [];
  }

  snapshot(): CvdSnapshot {
    const times = [...this.bars.keys()].sort((a, b) => a - b);
    let running = this.prefix;
    const points = times.map((openTime) => {
      const delta = this.bars.get(openTime) ?? 0;
      running += delta;
      return { openTime, delta, cvd: running };
    });
    return {
      points,
      prefix: this.prefix,
      total: this.total,
      firstTradeTime: this.firstTradeTime,
      gaps: this.gaps.map((gap) => ({ ...gap })),
    };
  }
}

/** Points inside a window keep their session CVD. The left edge is not a new zero. */
export function cvdInView(snapshot: CvdSnapshot, from: number, to: number): CvdPoint[] {
  return snapshot.points.filter((point) => point.openTime < to && point.openTime >= from);
}

/** Split the polyline where a recorded hole lies between two bars. */
export function cvdSegments(points: CvdPoint[], gaps: CvdGap[]): CvdPoint[][] {
  const segments: CvdPoint[][] = [];
  let current: CvdPoint[] = [];
  let previous: CvdPoint | null = null;
  for (const point of points) {
    const prior = previous;
    if (prior && gaps.some((gap) => gap.from < point.openTime && gap.to > prior.openTime)) {
      if (current.length > 0) segments.push(current);
      current = [point];
    } else {
      current.push(point);
    }
    previous = point;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function barSpansGap(openTime: number, timeframe: Timeframe, gaps: CvdGap[]): boolean {
  const end = openTime + timeframeMs(timeframe);
  return gaps.some((gap) => gap.from < end && gap.to > openTime);
}
