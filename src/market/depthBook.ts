import { priceToTick } from "./price";

export interface DepthDiff {
  U: number;
  u: number;
  pu: number;
  bids: ReadonlyArray<readonly [string, string]>;
  asks: ReadonlyArray<readonly [string, string]>;
}

export type DepthResult =
  | { type: "buffered" }
  | { type: "ignored" }
  | { type: "applied" }
  | { type: "snapshot"; bridged: boolean }
  | { type: "gap"; reason: "bridge" | "sequence" | "overflow" };

const MAX_BUFFER = 5_000;

/**
 * Local USD-M futures book.
 *
 * Official procedure (not the spot procedure):
 * https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly
 *
 * 1. Subscribe to `<symbol>@depth@100ms` on wss://fstream.binance.com and buffer.
 * 2. REST GET https://fapi.binance.com/fapi/v1/depth?symbol=&limit=1000
 * 3. Drop buffered events with u < snapshot.lastUpdateId.
 * 4. The first applied event must satisfy U <= lastUpdateId AND u >= lastUpdateId.
 *    A direct continuation with pu === lastUpdateId is also accepted. Live futures
 *    streams often chain that way when U jumps past the snapshot.
 * 5. Every later event must have pu === previous event u. Overlap of U is not enough
 *    after the bridge. Spot's "U === previous u + 1" rule is not used: on futures U
 *    routinely jumps while pu stays continuous.
 * 6. Quantities are absolute. Zero removes a level. Removing a missing level is normal.
 * 7. u <= the applied id is a duplicate or stale event and is ignored, so a replay
 *    cannot force a false gap.
 */
export class FuturesDepthBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private buffer: DepthDiff[] = [];
  private lastUpdateId: number | null = null;
  private bridged = false;
  private mode: "buffer" | "live" | "gap" = "buffer";

  constructor(private readonly tickSize: number) {
    if (!(tickSize > 0)) throw new Error("tickSize must be positive");
  }

  get updateId(): number | null {
    return this.lastUpdateId;
  }

  /** Snapshot is installed and no sequence gap is open. The first diff may still be pending. */
  get synced(): boolean {
    return this.mode === "live";
  }

  get hasBridge(): boolean {
    return this.bridged;
  }

  /** Drop the book and buffered diffs. Used on socket reconnect so old ids cannot mix in. */
  reconnect(): void {
    this.bids.clear();
    this.asks.clear();
    this.buffer = [];
    this.lastUpdateId = null;
    this.bridged = false;
    this.mode = "buffer";
  }

  onDiff(diff: DepthDiff): DepthResult {
    if (this.mode !== "live") return this.pushBuffer(diff);
    const result = this.applyIfContinuous(diff);
    if (result.type === "gap") {
      this.mode = "gap";
      this.bridged = false;
      this.buffer.push(diff);
    }
    return result;
  }

  applySnapshot(
    lastUpdateId: number,
    bids: ReadonlyArray<readonly [string, string]>,
    asks: ReadonlyArray<readonly [string, string]>,
  ): DepthResult {
    this.bids.clear();
    this.asks.clear();
    this.writeLevels(this.bids, bids);
    this.writeLevels(this.asks, asks);
    this.lastUpdateId = lastUpdateId;
    this.bridged = false;
    this.mode = "live";

    const pending = dedupeByFinalId(this.buffer);
    this.buffer = [];
    for (let i = 0; i < pending.length; i++) {
      const result = this.applyIfContinuous(pending[i]);
      if (result.type === "gap") {
        this.mode = "gap";
        this.bridged = false;
        this.buffer = pending.slice(i);
        return result;
      }
    }
    return { type: "snapshot", bridged: this.bridged };
  }

  qty(side: "bid" | "ask", price: number | string): number {
    const numeric = typeof price === "string" ? Number(price) : price;
    const tick = priceToTick(numeric, this.tickSize);
    return (side === "bid" ? this.bids : this.asks).get(tick) ?? 0;
  }

  bestBidTick(): number | null {
    let best: number | null = null;
    for (const tick of this.bids.keys()) if (best === null || tick > best) best = tick;
    return best;
  }

  bestAskTick(): number | null {
    let best: number | null = null;
    for (const tick of this.asks.keys()) if (best === null || tick < best) best = tick;
    return best;
  }

  entries(side: "bid" | "ask"): Array<[number, number]> {
    return [...(side === "bid" ? this.bids : this.asks)];
  }

  private pushBuffer(diff: DepthDiff): DepthResult {
    this.buffer.push(diff);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = [];
      this.mode = "gap";
      this.bridged = false;
      return { type: "gap", reason: "overflow" };
    }
    return { type: "buffered" };
  }

  private applyIfContinuous(diff: DepthDiff): DepthResult {
    const last = this.lastUpdateId;
    if (last === null) return { type: "buffered" };
    const { U, u, pu } = diff;
    if (!Number.isInteger(U) || !Number.isInteger(u) || !Number.isInteger(pu)) {
      return { type: "gap", reason: "sequence" };
    }
    if (u < last) return { type: "ignored" };

    if (!this.bridged) {
      const overlaps = U <= last && u >= last;
      const continues = pu === last && u >= last;
      if (!overlaps && !continues) return { type: "gap", reason: "bridge" };
      this.writeLevels(this.bids, diff.bids);
      this.writeLevels(this.asks, diff.asks);
      this.lastUpdateId = u;
      this.bridged = true;
      return { type: "applied" };
    }

    if (u === last) return { type: "ignored" };
    if (pu !== last) return { type: "gap", reason: "sequence" };
    this.writeLevels(this.bids, diff.bids);
    this.writeLevels(this.asks, diff.asks);
    this.lastUpdateId = u;
    return { type: "applied" };
  }

  private writeLevels(
    book: Map<number, number>,
    levels: ReadonlyArray<readonly [string, string]>,
  ): void {
    for (const [priceText, qtyText] of levels) {
      const price = Number(priceText);
      const qty = Number(qtyText);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
      const tick = priceToTick(price, this.tickSize);
      if (qty <= 0) book.delete(tick);
      else book.set(tick, qty);
    }
  }
}

function dedupeByFinalId(events: DepthDiff[]): DepthDiff[] {
  const ordered = events.map((diff, index) => ({ diff, index }));
  ordered.sort((a, b) => a.diff.u - b.diff.u || a.index - b.index);
  const out: DepthDiff[] = [];
  for (const item of ordered) {
    const prev = out[out.length - 1];
    if (prev && prev.u === item.diff.u) out[out.length - 1] = item.diff;
    else out.push(item.diff);
  }
  return out;
}
