import { describe, expect, it } from "vitest";
import { parseAggTrade } from "../src/market/aggressor";
import {
  TRADE_FRESH_MS,
  DEPTH_FRESH_MS,
  describeFeed,
  shouldReconnectSilentSocket,
} from "../src/net/channelHealth";
import { decodeSocketData, marketStreamUrl, publicStreamUrl, routeStreamMessage } from "../src/net/binance";

const liveTrade = {
  stream: "btcusdt@aggTrade",
  data: {
    e: "aggTrade",
    E: 1794004704361,
    a: 1,
    s: "BTCUSDT",
    p: "75964.50",
    q: "0.002",
    nq: "0.002",
    f: 10,
    l: 10,
    T: 1794004704360,
    m: false,
    st: 1,
  },
};

describe("routed futures sockets", () => {
  it("puts depth on /public and trades plus liquidations on /market", () => {
    expect(publicStreamUrl("BTCUSDT")).toBe(
      "wss://fstream.binance.com/public/stream?streams=btcusdt@depth@100ms",
    );
    expect(marketStreamUrl("ETHUSDT")).toBe(
      "wss://fstream.binance.com/market/stream?streams=ethusdt@aggTrade/ethusdt@forceOrder",
    );
    expect(publicStreamUrl("BTCUSDT")).not.toContain("fstream.binance.com/stream?");
    expect(marketStreamUrl("BTCUSDT")).not.toContain("fstream.binance.com/stream?");
  });

  it("accepts a wrapped aggTrade that also carries the newer nq and st fields", () => {
    const routed = routeStreamMessage(liveTrade, "BTCUSDT");
    expect(routed.kind).toBe("aggTrade");
    if (routed.kind !== "aggTrade") return;
    expect(routed.trade).toMatchObject({ price: 75964.5, qty: 0.002, buyerIsMaker: false, time: 1794004704360 });
    expect(parseAggTrade(liveTrade.data)?.buyerIsMaker).toBe(false);
  });

  it("routes depth and trades independently, in either order", () => {
    const depth = {
      stream: "btcusdt@depth@100ms",
      data: { e: "depthUpdate", E: 1, T: 1, s: "BTCUSDT", U: 10, u: 11, pu: 9, b: [["100", "1"]], a: [] },
    };
    expect(routeStreamMessage(depth, "BTCUSDT").kind).toBe("depth");
    expect(routeStreamMessage(liveTrade, "BTCUSDT").kind).toBe("aggTrade");
    expect(routeStreamMessage(liveTrade, "ETHUSDT").kind).toBe("ignore");
    const again = [depth, liveTrade].map((message) => routeStreamMessage(message, "BTCUSDT").kind);
    expect(again).toEqual(["depth", "aggTrade"]);
  });

  it("reads a text payload delivered as a Blob", async () => {
    const blob = new Blob([JSON.stringify(liveTrade)]);
    const decoded = await decodeSocketData(blob);
    expect(routeStreamMessage(decoded, "BTCUSDT").kind).toBe("aggTrade");
  });
});

describe("channel health", () => {
  it("does not call a synced book with no trades fully live", () => {
    const status = describeFeed({
      now: 20_000,
      marketOpen: true,
      publicOpen: true,
      bookSynced: true,
      lastTradeAt: null,
      lastDepthAt: 19_500,
      tradeCount: 0,
      liquidationCount: 0,
    });
    expect(status.kind).not.toBe("ok");
    expect(status.title).toBe("部分可用");
    expect(status.trades).toBe("waiting");
    expect(status.depth).toBe("live");
    expect(status.detail).toContain("aggTrade");
    expect(status.detail).toContain("強平 0 筆");
  });

  it("keeps a snapshot-only book out of the green live state", () => {
    const status = describeFeed({
      now: 5_000,
      marketOpen: true,
      publicOpen: true,
      bookSynced: true,
      lastTradeAt: null,
      lastDepthAt: null,
      tradeCount: 0,
      liquidationCount: 0,
    });
    expect(status.kind).toBe("warn");
    expect(status.detail).toContain("快照");
    expect(status.trades).toBe("waiting");
    expect(status.depth).toBe("waiting");
  });

  it("turns green only when both trades and depth diffs are inside the freshness window", () => {
    const now = 100_000;
    const status = describeFeed({
      now,
      marketOpen: true,
      publicOpen: true,
      bookSynced: true,
      lastTradeAt: now - 1_000,
      lastDepthAt: now - 500,
      tradeCount: 12,
      liquidationCount: 0,
    });
    expect(status.kind).toBe("ok");
    expect(status.title).toBe("即時");
    expect(status.trades).toBe("live");
    expect(status.depth).toBe("live");
    expect(TRADE_FRESH_MS).toBe(8_000);
    expect(DEPTH_FRESH_MS).toBe(3_000);
  });

  it("marks a quiet trade socket stale without treating a quiet liquidation count as failure", () => {
    const now = 50_000;
    const status = describeFeed({
      now,
      marketOpen: true,
      publicOpen: true,
      bookSynced: true,
      lastTradeAt: now - TRADE_FRESH_MS - 1,
      lastDepthAt: now - 100,
      tradeCount: 4,
      liquidationCount: 0,
    });
    expect(status.trades).toBe("stale");
    expect(status.kind).toBe("warn");
    expect(status.detail).toContain("強平 0 筆");
    expect(shouldReconnectSilentSocket(true, "stale")).toBe(true);
    expect(shouldReconnectSilentSocket(true, "waiting")).toBe(false);
    expect(shouldReconnectSilentSocket(false, "stale")).toBe(false);
    const silent = describeFeed({
      now: 30_000,
      marketOpen: true,
      publicOpen: true,
      marketOpenedAt: 0,
      publicOpenedAt: 29_000,
      bookSynced: true,
      lastTradeAt: null,
      lastDepthAt: 29_500,
      tradeCount: 0,
      liquidationCount: 0,
    });
    expect(silent.trades).toBe("stale");
    expect(silent.depth).toBe("live");
    expect(silent.title).toBe("部分可用");
  });
});
