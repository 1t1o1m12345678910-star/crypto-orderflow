import type { DepthDiff } from "../market/depthBook";
import { parseAggTrade, type AggTrade } from "../market/aggressor";
import { parseForceOrder, type Liquidation } from "../market/liquidations";

/** USD-M futures REST. Spot is api.binance.com and is intentionally unused. */
export const FAPI_ORIGIN = "https://fapi.binance.com";
/** High-frequency public streams. Depth lives here, not on the legacy unrouted URL. */
export const PUBLIC_STREAM_ORIGIN = "wss://fstream.binance.com/public/stream";
/** Regular market streams. aggTrade and forceOrder are not delivered on /public. */
export const MARKET_STREAM_ORIGIN = "wss://fstream.binance.com/market/stream";

export class MarketDataError extends Error {
  readonly kind: "region" | "network" | "http";

  constructor(kind: "region" | "network" | "http", message: string) {
    super(message);
    this.name = "MarketDataError";
    this.kind = kind;
  }
}

/** @depth@100ms is a public stream and must not share a socket with market streams. */
export function publicStreamUrl(symbol: string): string {
  return `${PUBLIC_STREAM_ORIGIN}?streams=${symbol.toLowerCase()}@depth@100ms`;
}

/** aggTrade and forceOrder are market streams. The legacy /stream URL no longer pushes them. */
export function marketStreamUrl(symbol: string): string {
  const id = symbol.toLowerCase();
  return `${MARKET_STREAM_ORIGIN}?streams=${id}@aggTrade/${id}@forceOrder`;
}

export async function fetchMarketJson(url: string, parent: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(12_000)]);
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    if (parent.aborted) throw new DOMException("Aborted", "AbortError");
    throw new MarketDataError(
      "network",
      "瀏覽器無法連到幣安公開 API。可能是斷線、防火牆，或所在地無法使用幣安。",
    );
  }
  const text = await response.text();
  if (response.status === 451 || /restricted location/i.test(text)) {
    throw new MarketDataError("region", "restricted");
  }
  if (!response.ok) throw new MarketDataError("http", `幣安回應 HTTP ${response.status}。`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MarketDataError("http", "幣安回應不是 JSON。");
  }
}

export function parseTickSize(payload: unknown, symbol: string): number | null {
  if (!payload || typeof payload !== "object") return null;
  const symbols = (payload as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) return null;
  for (const item of symbols) {
    if (!item || typeof item !== "object") continue;
    const row = item as { symbol?: unknown; filters?: unknown };
    if (row.symbol !== symbol || !Array.isArray(row.filters)) continue;
    for (const filter of row.filters) {
      if (!filter || typeof filter !== "object") continue;
      const priceFilter = filter as { filterType?: unknown; tickSize?: unknown };
      if (priceFilter.filterType !== "PRICE_FILTER") continue;
      const tick = Number(priceFilter.tickSize);
      if (Number.isFinite(tick) && tick > 0) return tick;
    }
  }
  return null;
}

export function parseDepthSnapshot(payload: unknown): {
  lastUpdateId: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as { lastUpdateId?: unknown; bids?: unknown; asks?: unknown };
  const lastUpdateId = Number(row.lastUpdateId);
  if (!Number.isInteger(lastUpdateId)) return null;
  const bids = asLevels(row.bids);
  const asks = asLevels(row.asks);
  if (!bids || !asks) return null;
  return { lastUpdateId, bids, asks };
}

export function unwrapStream(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const row = payload as { data?: unknown };
  if (row.data && typeof row.data === "object") return row.data;
  return payload;
}

/** WebKit may hand a text frame over as a Blob. Both forms are real socket payloads. */
export async function decodeSocketData(raw: unknown): Promise<unknown> {
  if (typeof raw === "string") return JSON.parse(raw) as unknown;
  if (typeof Blob !== "undefined" && raw instanceof Blob) return JSON.parse(await raw.text()) as unknown;
  return raw;
}

export function parseDepthDiff(data: unknown): DepthDiff | null {
  if (!data || typeof data !== "object") return null;
  const row = data as { e?: unknown; U?: unknown; u?: unknown; pu?: unknown; b?: unknown; a?: unknown };
  if (row.e !== "depthUpdate") return null;
  const U = Number(row.U);
  const u = Number(row.u);
  const pu = Number(row.pu);
  if (!Number.isInteger(U) || !Number.isInteger(u) || !Number.isInteger(pu)) return null;
  const bids = asLevels(row.b);
  const asks = asLevels(row.a);
  if (!bids || !asks) return null;
  return { U, u, pu, bids, asks };
}

export type RoutedMessage =
  | { kind: "aggTrade"; trade: AggTrade }
  | { kind: "depth"; diff: DepthDiff }
  | { kind: "liquidation"; liquidation: Liquidation }
  | { kind: "ignore" };

/** One message is one channel. A depth frame never has to succeed before a trade frame. */
export function routeStreamMessage(payload: unknown, symbol: string): RoutedMessage {
  const data = unwrapStream(payload);
  const trade = parseAggTrade(data);
  if (trade && trade.symbol === symbol) return { kind: "aggTrade", trade };
  const liquidation = parseForceOrder(data, symbol);
  if (liquidation) return { kind: "liquidation", liquidation };
  const diff = parseDepthDiff(data);
  if (diff) return { kind: "depth", diff };
  return { kind: "ignore" };
}

function asLevels(value: unknown): Array<[string, string]> | null {
  if (!Array.isArray(value)) return null;
  const levels: Array<[string, string]> = [];
  for (const level of value) {
    if (!Array.isArray(level) || level.length < 2) return null;
    levels.push([String(level[0]), String(level[1])]);
  }
  return levels;
}
