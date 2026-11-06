import { tickToPrice } from "../market/price";
import { aggressorFromBuyerMaker } from "../market/aggressor";
import { parseKlines } from "../market/candles";
import { pushLiquidation } from "../market/liquidations";
import type { Timeframe } from "../market/time";
import type { MarketStore, SymbolId } from "../store";
import { DEPTH_FRESH_MS, TRADE_FRESH_MS, describeFeed, shouldReconnectSilentSocket } from "./channelHealth";
import {
  FAPI_ORIGIN,
  MarketDataError,
  decodeSocketData,
  fetchMarketJson,
  marketStreamUrl,
  parseDepthSnapshot,
  parseTickSize,
  publicStreamUrl,
  routeStreamMessage,
} from "./binance";

type Phase = "boot" | "live" | "gap" | "reconnecting" | "stale" | "failed" | "offline";

export class LiveSession {
  private generation = 0;
  private marketBind = 0;
  private publicBind = 0;
  private snapSeq = 0;
  private attempt = 0;
  private phase: Phase = "boot";
  private stopped = true;
  private marketSocket: WebSocket | null = null;
  private publicSocket: WebSocket | null = null;
  private abort: AbortController | null = null;
  private marketOpen = false;
  private publicOpen = false;
  private marketOpenedAt: number | null = null;
  private publicOpenedAt: number | null = null;
  private lastTradeAt: number | null = null;
  private lastDepthAt: number | null = null;
  private hiddenAt = 0;
  private marketReconnectAt = 0;
  private publicReconnectAt = 0;
  private snapshotTimer = 0;
  private publicReconnectTimer = 0;
  private staleTimer = 0;
  private heatTimer = 0;
  private reconnectTimer = 0;

  constructor(
    private readonly store: MarketStore,
    private readonly onChange: () => void,
  ) {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("online", this.onOnline);
  }

  start(symbol: SymbolId): void {
    this.stopNetwork();
    this.stopped = false;
    this.store.symbol = symbol;
    this.store.mode = "live";
    this.phase = "boot";
    this.attempt = 0;
    const generation = ++this.generation;
    this.abort = new AbortController();
    void this.bootstrap(generation);
  }

  setTimeframe(timeframe: Timeframe): void {
    this.store.timeframe = timeframe;
    if (this.stopped || this.store.mode !== "live" || !this.abort) {
      this.onChange();
      return;
    }
    void this.refreshCandles(this.generation);
  }

  stop(): void {
    this.stopped = true;
    this.phase = "failed";
    this.stopNetwork();
  }

  private stopNetwork(): void {
    window.clearTimeout(this.snapshotTimer);
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.publicReconnectTimer);
    window.clearInterval(this.staleTimer);
    window.clearInterval(this.heatTimer);
    this.staleTimer = 0;
    this.heatTimer = 0;
    this.detachSockets();
    this.abort?.abort();
    this.abort = null;
  }

  private alive(generation: number): boolean {
    return !this.stopped && generation === this.generation && this.store.mode === "live";
  }

  private async bootstrap(generation: number): Promise<void> {
    this.write("loading", "正在讀取合約規格", "正在向 fapi.binance.com 讀取最小跳動單位。");
    try {
      const parent = this.abort?.signal;
      if (!parent) return;
      const info = await fetchMarketJson(
        `${FAPI_ORIGIN}/fapi/v1/exchangeInfo?symbol=${this.store.symbol}`,
        parent,
      );
      if (!this.alive(generation)) return;
      const tick = parseTickSize(info, this.store.symbol);
      if (tick === null) throw new MarketDataError("http", "回應裡沒有這個合約的 tickSize。");
      this.store.resetMarket(tick);
      this.lastTradeAt = null;
      this.lastDepthAt = null;
      this.marketOpen = false;
      this.publicOpen = false;
      this.write(
        "loading",
        "正在讀取 K 線",
        "K 線只有開高低收與總成交量。它不是足跡，也不是掛單熱圖，左側不會被裝成已有訂單流。",
      );
      await this.refreshCandles(generation);
      if (!this.alive(generation)) return;
      this.openMarket(generation);
      this.openPublic(generation);
    } catch (error) {
      if (!this.alive(generation)) return;
      this.fail(error);
    }
  }

  private async refreshCandles(generation: number): Promise<void> {
    const parent = this.abort?.signal;
    if (!parent) return;
    try {
      const rows = await fetchMarketJson(
        `${FAPI_ORIGIN}/fapi/v1/klines?symbol=${this.store.symbol}&interval=${this.store.timeframe}&limit=180`,
        parent,
      );
      if (!this.alive(generation)) return;
      this.store.candles = parseKlines(rows);
      this.onChange();
    } catch (error) {
      if (!this.alive(generation) || this.phase === "boot") throw error;
      this.write("warn", "K 線更新失敗", "沒有拿到新的交易所 K 線。已收到的足跡仍在，沒有用假資料代替。");
    }
  }

  private openMarket(generation: number): void {
    if (!this.alive(generation)) return;
    this.detachMarket();
    const bindId = ++this.marketBind;
    let socket: WebSocket;
    try {
      socket = new WebSocket(marketStreamUrl(this.store.symbol));
    } catch {
      this.fail(new MarketDataError("network", "無法建立逐筆 WebSocket。"));
      return;
    }
    this.marketSocket = socket;
    socket.onopen = () => {
      if (bindId !== this.marketBind || !this.alive(generation)) return;
      this.marketOpen = true;
      this.marketOpenedAt = Date.now();
      this.attempt = 0;
      if (this.store.sessionStartedAt === null) this.store.sessionStartedAt = Date.now();
      this.armTimers(generation);
      this.publishHealth();
    };
    socket.onmessage = (event) => {
      if (bindId !== this.marketBind || !this.alive(generation)) return;
      void this.ingest(generation, "market", event.data);
    };
    socket.onerror = () => {
      /* close carries the reconnect */
    };
    socket.onclose = () => {
      if (bindId !== this.marketBind || !this.alive(generation)) return;
      this.marketOpen = false;
      if (this.lastTradeAt !== null) this.store.footprint.noteGap(this.lastTradeAt, Date.now());
      this.scheduleMarketReconnect(generation);
      this.publishHealth();
    };
  }

  private openPublic(generation: number): void {
    if (!this.alive(generation)) return;
    this.detachPublic();
    const bindId = ++this.publicBind;
    let socket: WebSocket;
    try {
      socket = new WebSocket(publicStreamUrl(this.store.symbol));
    } catch {
      this.fail(new MarketDataError("network", "無法建立深度 WebSocket。"));
      return;
    }
    this.publicSocket = socket;
    socket.onopen = () => {
      if (bindId !== this.publicBind || !this.alive(generation)) return;
      this.publicOpen = true;
      this.publicOpenedAt = Date.now();
      this.store.book.reconnect();
      this.armTimers(generation);
      void this.pullSnapshot(generation);
      this.publishHealth();
    };
    socket.onmessage = (event) => {
      if (bindId !== this.publicBind || !this.alive(generation)) return;
      void this.ingest(generation, "public", event.data);
    };
    socket.onerror = () => {
      /* close carries the reconnect */
    };
    socket.onclose = () => {
      if (bindId !== this.publicBind || !this.alive(generation)) return;
      this.publicOpen = false;
      this.store.book.reconnect();
      this.schedulePublicReconnect(generation);
      this.publishHealth();
    };
  }

  private async ingest(generation: number, source: "market" | "public", raw: unknown): Promise<void> {
    let payload: unknown;
    try {
      payload = await decodeSocketData(raw);
    } catch {
      return;
    }
    if (!this.alive(generation)) return;
    const routed = routeStreamMessage(payload, this.store.symbol);
    if (routed.kind === "aggTrade") {
      if (source !== "market") return;
      this.lastTradeAt = Date.now();
      this.store.footprint.addTrade(routed.trade);
      this.store.lastPrice = routed.trade.price;
      this.store.lastAggressor = aggressorFromBuyerMaker(routed.trade.buyerIsMaker);
      this.store.tradesSeen += 1;
      this.publishHealth();
      this.onChange();
      return;
    }
    if (routed.kind === "liquidation") {
      if (source !== "market") return;
      pushLiquidation(this.store.liquidations, routed.liquidation);
      this.onChange();
      return;
    }
    if (routed.kind !== "depth" || source !== "public") return;
    const result = this.store.book.onDiff(routed.diff);
    this.lastDepthAt = Date.now();
    this.store.depthDiffs += 1;
    this.syncBbo();
    if (result.type === "gap") {
      this.phase = "gap";
      this.write(
        "warn",
        "深度序號中斷",
        "後續深度事件的 pu 必須等於上一筆的 u。這本訂單簿已停下，正在重新抓快照。熱圖暫停取樣。逐筆若還在，不會被這次重抓清掉。",
      );
      this.scheduleSnapshot(generation, 700);
      return;
    }
    if (this.phase === "gap" && this.store.book.synced) this.phase = "boot";
    this.publishHealth();
    this.onChange();
  }

  private async pullSnapshot(generation: number): Promise<void> {
    const parent = this.abort?.signal;
    if (!parent || !this.alive(generation)) return;
    const seq = ++this.snapSeq;
    if (this.phase !== "gap") {
      this.write("loading", "正在同步訂單簿", "先緩衝深度，再套用 /fapi/v1/depth 快照，並用 U、u、pu 接上合約規則。");
    }
    try {
      const payload = await fetchMarketJson(
        `${FAPI_ORIGIN}/fapi/v1/depth?symbol=${this.store.symbol}&limit=1000`,
        parent,
      );
      if (!this.alive(generation) || seq !== this.snapSeq) return;
      const snapshot = parseDepthSnapshot(payload);
      if (!snapshot) throw new MarketDataError("http", "深度快照格式無法解析。");
      const result = this.store.book.applySnapshot(snapshot.lastUpdateId, snapshot.bids, snapshot.asks);
      this.syncBbo();
      if (result.type === "gap") {
        this.phase = "gap";
        this.write(
          "warn",
          "快照與深度接不起來",
          "第一筆深度沒有蓋到快照的 lastUpdateId，也沒有用 pu 接上。正在重新抓取，這段時間不畫新的熱圖。",
        );
        this.scheduleSnapshot(generation, 800);
      } else if (this.publicOpen) {
        this.phase = "boot";
        this.publishHealth();
      }
      this.onChange();
    } catch (error) {
      if (!this.alive(generation) || seq !== this.snapSeq) return;
      if (error instanceof MarketDataError && error.kind === "region") {
        this.fail(error);
        return;
      }
      this.phase = "gap";
      this.write("warn", "訂單簿快照失敗", "沒有拿到可用快照，所以不會顯示掛單熱圖。正在重試。");
      this.scheduleSnapshot(generation, 1_200);
    }
  }

  private scheduleSnapshot(generation: number, delay: number): void {
    window.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = window.setTimeout(() => {
      void this.pullSnapshot(generation);
    }, delay);
  }

  private scheduleMarketReconnect(generation: number): void {
    this.attempt += 1;
    const delay = Math.min(20_000, 1_000 * 2 ** Math.min(this.attempt - 1, 4));
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.openMarket(generation), delay);
  }

  private schedulePublicReconnect(generation: number): void {
    const delay = Math.min(20_000, 1_000 * 2 ** Math.min(this.attempt, 4));
    window.clearTimeout(this.publicReconnectTimer);
    this.publicReconnectTimer = window.setTimeout(() => this.openPublic(generation), delay);
  }

  private armTimers(generation: number): void {
    window.clearInterval(this.staleTimer);
    window.clearInterval(this.heatTimer);
    this.staleTimer = window.setInterval(() => {
      if (!this.alive(generation) || this.phase === "failed" || this.phase === "offline") return;
      const now = Date.now();
      const health = describeFeed(this.feedSnapshot(now));
      if (shouldReconnectSilentSocket(this.marketOpen, health.trades) && now >= this.marketReconnectAt) {
        this.marketReconnectAt = now + TRADE_FRESH_MS;
        this.openMarket(generation);
      }
      if (shouldReconnectSilentSocket(this.publicOpen, health.depth) && now >= this.publicReconnectAt) {
        this.publicReconnectAt = now + DEPTH_FRESH_MS;
        this.openPublic(generation);
      }
      if (this.phase !== "gap") this.publishHealth(now);
    }, 2_000);
    this.heatTimer = window.setInterval(() => {
      if (!this.alive(generation)) return;
      if (this.store.heatmap.sample(Date.now(), this.store.book)) this.onChange();
    }, 1_000);
  }

  private syncBbo(): void {
    const bid = this.store.book.bestBidTick();
    const ask = this.store.book.bestAskTick();
    this.store.bestBid = bid === null ? null : tickToPrice(bid, this.store.tickSize);
    this.store.bestAsk = ask === null ? null : tickToPrice(ask, this.store.tickSize);
  }

  private feedSnapshot(now: number) {
    return {
      now,
      marketOpen: this.marketOpen,
      publicOpen: this.publicOpen,
      marketOpenedAt: this.marketOpenedAt,
      publicOpenedAt: this.publicOpenedAt,
      bookSynced: this.store.book.synced,
      lastTradeAt: this.lastTradeAt,
      lastDepthAt: this.lastDepthAt,
      tradeCount: this.store.tradesSeen,
      liquidationCount: this.store.liquidations.length,
    };
  }

  private publishHealth(now = Date.now()): void {
    if (this.phase === "gap" || this.phase === "failed" || this.phase === "offline") return;
    const status = describeFeed(this.feedSnapshot(now));
    if (
      status.kind === this.store.statusKind &&
      status.title === this.store.statusText &&
      status.detail === this.store.detail
    ) {
      return;
    }
    this.write(status.kind, status.title, status.detail);
  }

  private fail(error: unknown): void {
    this.phase = "failed";
    this.stopped = true;
    this.stopNetwork();
    if (error instanceof MarketDataError && error.kind === "region") {
      this.write(
        "bad",
        "這個網路無法使用幣安",
        "幣安公開 API 回報此位置受地區限制（HTTP 451 或 restricted location）。此頁沒有後端，也不會透過代理繞過限制。請在可直接連上 fapi.binance.com 與 fstream.binance.com 的網路按「再試一次」，或改開「示範模式」。示範模式是合成資料，不是真行情。",
      );
      return;
    }
    if (error instanceof MarketDataError && error.kind === "network") {
      this.write(
        "bad",
        "連不到幣安",
        "瀏覽器無法讀取 fapi.binance.com 或 fstream.binance.com。受限地區常見的情況是幣安回 HTTP 451，但錯誤頁沒有 CORS 標頭，所以網頁只看得到連線失敗，讀不到狀態碼。也可能是斷線或防火牆。本工具不會改走代理。可以按「再試一次」，或開「示範模式」。示範是合成資料，不是真行情。",
      );
      return;
    }
    const message = error instanceof Error ? error.message : "未知錯誤";
    this.write("bad", "行情讀取失敗", `${message} 沒有改用模擬資料代替即時行情。`);
  }

  private write(kind: MarketStore["statusKind"], text: string, detail: string): void {
    this.store.statusKind = kind;
    this.store.statusText = text;
    this.store.detail = detail;
    this.onChange();
  }

  private detachSockets(): void {
    this.detachMarket();
    this.detachPublic();
  }

  private detachMarket(): void {
    this.detach(this.marketSocket);
    this.marketSocket = null;
    this.marketOpen = false;
  }

  private detachPublic(): void {
    this.detach(this.publicSocket);
    this.publicSocket = null;
    this.publicOpen = false;
  }

  private detach(socket: WebSocket | null): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.hiddenAt = Date.now();
      return;
    }
    if (!this.hiddenAt || this.stopped || this.store.mode !== "live") return;
    const started = this.hiddenAt;
    const away = Date.now() - started;
    this.hiddenAt = 0;
    if (away < 8_000) return;
    if (!this.marketOpen && !this.publicOpen) return;
    this.store.continuityWarning =
      "分頁在背景時可能漏掉逐筆。CVD 只累計實際收到的成交，不會把缺口補成 0，也不會重新從零起算。";
    this.store.footprint.noteGap(started, Date.now());
    this.store.book.reconnect();
    void this.pullSnapshot(this.generation);
    this.onChange();
  };

  private readonly onOffline = (): void => {
    if (this.stopped || this.store.mode !== "live") return;
    this.phase = "offline";
    this.write("bad", "瀏覽器離線", "目前沒有網路。恢復後會重新連線；離線期間不會製造假行情。");
  };

  private readonly onOnline = (): void => {
    if (this.stopped || this.store.mode !== "live" || this.phase === "failed") return;
    this.attempt = 0;
    this.phase = "boot";
    this.openMarket(this.generation);
    this.openPublic(this.generation);
  };
}
