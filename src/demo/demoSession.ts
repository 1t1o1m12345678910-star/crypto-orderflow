import { tickToPrice } from "../market/price";
import { pushLiquidation } from "../market/liquidations";
import type { MarketStore } from "../store";

export class DemoSession {
  private tradeTimer = 0;
  private heatTimer = 0;
  private price = 0;
  private random: () => number = Math.random;
  private stopped = true;

  constructor(
    private readonly store: MarketStore,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    this.stop();
    this.stopped = false;
    const bitcoin = this.store.symbol === "BTCUSDT";
    const tick = bitcoin ? 0.1 : 0.01;
    this.store.mode = "demo";
    this.store.resetMarket(tick);
    this.price = bitcoin ? 96_420.4 : 3_521.42;
    this.random = mulberry32(bitcoin ? 20261106 : 771324);
    const now = Date.now();
    this.store.sessionStartedAt = now - 48 * 60_000;
    this.seed(now);
    this.store.statusKind = "demo";
    this.store.statusText = "示範模式";
    this.store.detail =
      "圖上的成交、掛單與清算都是這台瀏覽器裡的合成資料，不是幣安行情，也不能用來下單。要看真行情請按「即時」。";
    this.tradeTimer = window.setInterval(() => this.step(), 360);
    this.heatTimer = window.setInterval(() => this.sampleHeat(), 1_000);
    this.onChange();
  }

  stop(): void {
    this.stopped = true;
    window.clearInterval(this.tradeTimer);
    window.clearInterval(this.heatTimer);
  }

  private seed(now: number): void {
    for (let minute = 48; minute >= 1; minute--) this.emitTrades(now - minute * 60_000, 60_000, 16);
    for (let second = 360; second >= 0; second--) {
      this.price += (this.random() - 0.5) * this.store.tickSize * 2;
      this.publishBook(now - second * 1_000);
      this.store.heatmap.sample(now - second * 1_000, this.store.book);
    }
    const marks = [
      { ago: 40, side: "SELL" as const, qty: 1.8 },
      { ago: 28, side: "BUY" as const, qty: 6.2 },
      { ago: 17, side: "SELL" as const, qty: 0.9 },
      { ago: 9, side: "BUY" as const, qty: 3.4 },
      { ago: 3, side: "SELL" as const, qty: 2.1 },
    ];
    for (const mark of marks) {
      pushLiquidation(this.store.liquidations, {
        time: now - mark.ago * 60_000,
        price: this.price * (mark.side === "SELL" ? 0.998 : 1.002),
        qty: this.store.symbol === "ETHUSDT" ? mark.qty * 8 : mark.qty,
        side: mark.side,
      });
    }
    this.syncBbo();
  }

  private step(): void {
    if (this.stopped) return;
    const drift = (this.random() - 0.47) * this.store.tickSize * 6;
    this.price = Math.max(this.store.tickSize * 20, this.price + drift);
    this.emitTrades(Date.now() - 400, 400, 1 + (this.random() > 0.65 ? 1 : 0));
    if (this.random() < 0.05) {
      const side = this.random() > 0.5 ? "SELL" : "BUY";
      pushLiquidation(this.store.liquidations, {
        time: Date.now(),
        price: this.price,
        qty: this.store.symbol === "BTCUSDT" ? 0.4 + this.random() * 2 : 4 + this.random() * 20,
        side,
      });
    }
    this.onChange();
  }

  private sampleHeat(): void {
    if (this.stopped) return;
    this.publishBook(Date.now());
    this.store.heatmap.sample(Date.now(), this.store.book);
    this.syncBbo();
    this.onChange();
  }

  private emitTrades(start: number, duration: number, count: number): void {
    const tick = this.store.tickSize;
    const span = tick * (8 + Math.floor(this.random() * 18));
    const low = this.price - span * this.random();
    const high = low + span;
    for (let i = 0; i < count; i++) {
      const time = start + Math.floor((duration * (i + 0.15)) / Math.max(count, 1));
      const price = i === count - 1 ? this.price : low + (high - low) * this.random();
      const buyerIsMaker = this.random() > 0.5;
      const qty =
        this.store.symbol === "BTCUSDT" ? 0.015 + this.random() * 1.6 : 0.3 + this.random() * 22;
      this.store.footprint.addTrade({
        symbol: this.store.symbol,
        time,
        price,
        qty,
        buyerIsMaker,
      });
      this.store.tradesSeen += 1;
      this.store.lastPrice = price;
      this.store.lastAggressor = buyerIsMaker ? "sell" : "buy";
    }
  }

  private publishBook(updateId: number): void {
    const tick = this.store.tickSize;
    const digits = tick < 0.1 ? 2 : 1;
    const bids: Array<[string, string]> = [];
    const asks: Array<[string, string]> = [];
    for (let level = 1; level <= 70; level++) {
      const decay = Math.exp(-level / 24);
      const bidQty = (decay * (0.5 + this.random() * 4)).toFixed(4);
      const askQty = (decay * (0.5 + this.random() * 4)).toFixed(4);
      bids.push([(this.price - level * tick).toFixed(digits), bidQty]);
      asks.push([(this.price + level * tick).toFixed(digits), askQty]);
    }
    this.store.book.applySnapshot(updateId, bids, asks);
  }

  private syncBbo(): void {
    const bid = this.store.book.bestBidTick();
    const ask = this.store.book.bestAskTick();
    this.store.bestBid = bid === null ? null : tickToPrice(bid, this.store.tickSize);
    this.store.bestAsk = ask === null ? null : tickToPrice(ask, this.store.tickSize);
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
