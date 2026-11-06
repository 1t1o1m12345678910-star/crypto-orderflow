import { describe, expect, it } from "vitest";
import { parseKlines } from "../src/market/candles";
import { FootprintBook, barDelta, cellDelta } from "../src/market/footprint";
import { priceToTick } from "../src/market/price";
import { bucketStart } from "../src/market/time";

describe("footprint volume and delta bins", () => {
  it("bins aggressive buy and sell onto the tick and computes delta", () => {
    const book = new FootprintBook(0.1);
    book.addTrade({ symbol: "BTCUSDT", time: 60_000, price: 100.14, qty: 2, buyerIsMaker: false });
    book.addTrade({ symbol: "BTCUSDT", time: 61_000, price: 100.1, qty: 1.5, buyerIsMaker: true });
    book.addTrade({ symbol: "BTCUSDT", time: 62_000, price: 100.16, qty: 0.5, buyerIsMaker: false });

    const bar = book.bar(60_000, "1m");
    expect(bar).toBeDefined();
    const sellTick = priceToTick(100.1, 0.1);
    const buyTick = priceToTick(100.2, 0.1);
    const sellCell = bar!.levels.get(sellTick)!;
    const buyCell = bar!.levels.get(buyTick)!;
    expect(sellCell.buy).toBe(2);
    expect(sellCell.sell).toBe(1.5);
    expect(cellDelta(sellCell)).toBeCloseTo(0.5);
    expect(buyCell.buy).toBeCloseTo(0.5);
    expect(buyCell.sell).toBe(0);
    expect(bar!.buy).toBeCloseTo(2.5);
    expect(bar!.sell).toBeCloseTo(1.5);
    expect(barDelta(bar!)).toBeCloseTo(1);
    expect(bar!.open).toBeCloseTo(100.1);
    expect(bar!.high).toBeCloseTo(100.2);
    expect(bar!.low).toBeCloseTo(100.1);
    expect(bar!.close).toBeCloseTo(100.2);
  });

  it("keeps the same trade in every timeframe bucket", () => {
    const book = new FootprintBook(0.01);
    book.addTrade({
      symbol: "ETHUSDT",
      time: 300_000,
      price: 3500.01,
      qty: 4,
      buyerIsMaker: true,
    });
    expect(book.bar(300_000, "1m")?.sell).toBe(4);
    expect(book.bar(300_000, "5m")?.sell).toBe(4);
    expect(book.bar(0, "15m")?.sell).toBe(4);
    expect(book.bar(300_000, "1m")?.buy).toBe(0);
  });
});

describe("timeframe boundaries", () => {
  it("puts an exact boundary on the new bar and the previous millisecond on the old bar", () => {
    expect(bucketStart(120_000, "1m")).toBe(120_000);
    expect(bucketStart(119_999, "1m")).toBe(60_000);
    expect(bucketStart(300_000, "5m")).toBe(300_000);
    expect(bucketStart(299_999, "5m")).toBe(0);
    expect(bucketStart(300_001, "5m")).toBe(300_000);
    const fifteen = 15 * 60_000;
    expect(bucketStart(fifteen - 1, "15m")).toBe(0);
    expect(bucketStart(fifteen, "15m")).toBe(fifteen);
    expect(bucketStart(fifteen + fifteen - 1, "15m")).toBe(fifteen);
    expect(bucketStart(fifteen * 2, "15m")).toBe(fifteen * 2);
  });

  it("does not leak a trade across the 5m boundary", () => {
    const book = new FootprintBook(0.1);
    book.addTrade({ symbol: "BTCUSDT", time: 299_999, price: 10, qty: 1, buyerIsMaker: false });
    book.addTrade({ symbol: "BTCUSDT", time: 300_000, price: 10, qty: 3, buyerIsMaker: true });
    expect(book.bar(0, "5m")?.buy).toBe(1);
    expect(book.bar(0, "5m")?.sell).toBe(0);
    expect(book.bar(300_000, "5m")?.sell).toBe(3);
    expect(book.bar(300_000, "5m")?.buy).toBe(0);
    expect(book.bar(0, "1m")).toBeUndefined();
    expect(book.bar(240_000, "1m")?.buy).toBe(1);
    expect(book.bar(300_000, "1m")?.sell).toBe(3);
  });

  it("aligns a non-zero epoch the same way Binance klines do", () => {
    const open = 1_763_000_000_000;
    const aligned = bucketStart(open, "15m");
    expect(aligned % (15 * 60_000)).toBe(0);
    expect(bucketStart(aligned, "15m")).toBe(aligned);
    expect(bucketStart(aligned - 1, "15m")).toBe(aligned - 15 * 60_000);
  });
});

describe("exchange candles are not footprint history", () => {
  it("parses kline volume as a single total and leaves footprint empty", () => {
    const candles = parseKlines([
      [0, "100", "110", "90", "105", "50.5", 59999, "0", 10, "0", "0", "0"],
    ]);
    expect(candles).toEqual([
      { openTime: 0, open: 100, high: 110, low: 90, close: 105, volume: 50.5 },
    ]);
    expect("buy" in candles[0]).toBe(false);
    const book = new FootprintBook(0.1);
    expect(book.bars("1m")).toEqual([]);
    expect(book.bar(0, "1m")).toBeUndefined();
  });
});
