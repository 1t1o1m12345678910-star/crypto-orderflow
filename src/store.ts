import type { Aggressor } from "./market/aggressor";
import type { Candle } from "./market/candles";
import { FuturesDepthBook } from "./market/depthBook";
import { FootprintBook } from "./market/footprint";
import { HeatmapTape } from "./market/heatmap";
import type { Liquidation } from "./market/liquidations";
import type { Timeframe } from "./market/time";

export type SymbolId = "BTCUSDT" | "ETHUSDT";
export type StatusKind = "loading" | "ok" | "warn" | "bad" | "demo";

export class MarketStore {
  symbol: SymbolId = "BTCUSDT";
  timeframe: Timeframe = "1m";
  tickSize = 0.1;
  mode: "live" | "demo" = "live";
  footprint = new FootprintBook(0.1);
  book = new FuturesDepthBook(0.1);
  heatmap = new HeatmapTape();
  liquidations: Liquidation[] = [];
  candles: Candle[] = [];
  lastPrice: number | null = null;
  lastAggressor: Aggressor | null = null;
  sessionStartedAt: number | null = null;
  tradesSeen = 0;
  statusKind: StatusKind = "loading";
  statusText = "準備連線";
  detail = "足跡、掛單熱圖與清算只會在連上公開行情之後出現。";
  continuityWarning = "";
  bestBid: number | null = null;
  bestAsk: number | null = null;

  resetMarket(tickSize: number): void {
    this.tickSize = tickSize;
    this.footprint = new FootprintBook(tickSize);
    this.book = new FuturesDepthBook(tickSize);
    this.heatmap = new HeatmapTape();
    this.liquidations = [];
    this.candles = [];
    this.lastPrice = null;
    this.lastAggressor = null;
    this.sessionStartedAt = null;
    this.tradesSeen = 0;
    this.bestBid = null;
    this.bestAsk = null;
    this.continuityWarning = "";
  }
}
