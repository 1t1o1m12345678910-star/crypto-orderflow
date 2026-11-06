import { aggressorFromBuyerMaker, type AggTrade } from "./aggressor";
import { priceToTick, tickToPrice } from "./price";
import { bucketStart, type Timeframe, TIMEFRAMES } from "./time";

export interface FootprintCell {
  buy: number;
  sell: number;
}

export interface FootprintBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buy: number;
  sell: number;
  levels: Map<number, FootprintCell>;
}

const MAX_BARS = 520;

export class FootprintBook {
  private readonly series: Record<Timeframe, Map<number, FootprintBar>> = {
    "1m": new Map(),
    "5m": new Map(),
    "15m": new Map(),
  };

  constructor(readonly tickSize: number) {}

  addTrade(trade: AggTrade): void {
    for (const timeframe of TIMEFRAMES) this.addTo(timeframe, trade);
  }

  bar(openTime: number, timeframe: Timeframe): FootprintBar | undefined {
    return this.series[timeframe].get(openTime);
  }

  bars(timeframe: Timeframe): FootprintBar[] {
    return [...this.series[timeframe].values()].sort((a, b) => a.openTime - b.openTime);
  }

  private addTo(timeframe: Timeframe, trade: AggTrade): void {
    const openTime = bucketStart(trade.time, timeframe);
    const book = this.series[timeframe];
    const tick = priceToTick(trade.price, this.tickSize);
    const price = tickToPrice(tick, this.tickSize);
    let bar = book.get(openTime);
    if (!bar) {
      if (book.size >= MAX_BARS) this.dropOldest(book);
      bar = {
        openTime,
        open: price,
        high: price,
        low: price,
        close: price,
        buy: 0,
        sell: 0,
        levels: new Map(),
      };
      book.set(openTime, bar);
    }
    if (price > bar.high) bar.high = price;
    if (price < bar.low) bar.low = price;
    bar.close = price;
    const side = aggressorFromBuyerMaker(trade.buyerIsMaker);
    bar[side] += trade.qty;
    let cell = bar.levels.get(tick);
    if (!cell) {
      cell = { buy: 0, sell: 0 };
      bar.levels.set(tick, cell);
    }
    cell[side] += trade.qty;
  }

  private dropOldest(book: Map<number, FootprintBar>): void {
    let oldest: number | null = null;
    for (const key of book.keys()) {
      if (oldest === null || key < oldest) oldest = key;
    }
    if (oldest !== null) book.delete(oldest);
  }
}

export function barDelta(bar: FootprintBar): number {
  return bar.buy - bar.sell;
}

export function cellDelta(cell: FootprintCell): number {
  return cell.buy - cell.sell;
}
