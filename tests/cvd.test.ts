import { describe, expect, it } from "vitest";
import { parseKlines } from "../src/market/candles";
import { SessionCvd, cvdInView, cvdSegments, tradeDelta } from "../src/market/cvd";
import { FootprintBook } from "../src/market/footprint";
import { MarketStore } from "../src/store";

const buy = (time: number, qty: number, price = 100) =>
  ({ symbol: "BTCUSDT", time, price, qty, buyerIsMaker: false }) as const;
const sell = (time: number, qty: number, price = 100) =>
  ({ symbol: "BTCUSDT", time, price, qty, buyerIsMaker: true }) as const;

describe("CVD sign and running sum", () => {
  it("treats aggressive buy as positive delta and aggressive sell as negative", () => {
    expect(tradeDelta(false, 2)).toBe(2);
    expect(tradeDelta(true, 1.5)).toBe(-1.5);
    const book = new FootprintBook(0.1);
    book.addTrade(buy(60_000, 2));
    book.addTrade(sell(61_000, 1.5));
    book.addTrade(buy(62_000, 0.5));
    const series = book.cvdSeries("1m");
    expect(series.points).toHaveLength(1);
    expect(series.points[0].delta).toBeCloseTo(1);
    expect(series.points[0].cvd).toBeCloseTo(1);
    expect(series.total).toBeCloseTo(1);
    expect(series.firstTradeTime).toBe(60_000);
  });

  it("accumulates across bars and keeps the same total on every timeframe", () => {
    const book = new FootprintBook(0.1);
    book.addTrade(buy(60_000, 2));
    book.addTrade(sell(300_000, 0.5));
    book.addTrade(buy(900_000, 1));
    for (const timeframe of ["1m", "5m", "15m"] as const) {
      const series = book.cvdSeries(timeframe);
      expect(series.total).toBeCloseTo(2.5);
      expect(series.points[series.points.length - 1].cvd).toBeCloseTo(2.5);
      expect(series.points[0].cvd).toBeGreaterThan(0);
    }
    const oneMinute = book.cvdSeries("1m").points;
    expect(oneMinute.map((point) => point.delta)).toEqual([2, -0.5, 1]);
    expect(oneMinute.map((point) => point.cvd)).toEqual([2, 1.5, 2.5]);
  });

  it("does not build CVD from exchange klines", () => {
    const candles = parseKlines([[0, "100", "110", "90", "105", "80", 59999]]);
    expect(candles[0].volume).toBe(80);
    const book = new FootprintBook(0.1);
    expect(book.cvdSeries("1m").total).toBe(0);
    expect(book.cvdSeries("1m").points).toEqual([]);
  });
});

describe("CVD baseline", () => {
  it("keeps the first received trade as zero's anchor when later trades arrive", () => {
    const series = new SessionCvd("1m");
    series.add(120_000, false, 1);
    series.add(180_000, true, 0.25);
    expect(series.snapshot().firstTradeTime).toBe(120_000);
    series.add(119_000, false, 0.5);
    expect(series.snapshot().firstTradeTime).toBe(119_000);
    expect(series.snapshot().total).toBeCloseTo(1.25);
  });

  it("does not rebase CVD when a view window moves", () => {
    const series = new SessionCvd("1m");
    series.add(0, false, 5);
    series.add(60_000, false, 1);
    series.add(120_000, true, 2);
    const full = series.snapshot();
    const later = cvdInView(full, 60_000, 180_000);
    expect(later.map((point) => point.cvd)).toEqual([6, 4]);
    expect(later[0].cvd).toBe(full.points[1].cvd);
    expect(later[0].cvd).not.toBe(0);
    expect(later[0].cvd - later[0].delta).toBeCloseTo(5);
  });

  it("resets only the session that is cleared", () => {
    const session = new SessionCvd("5m");
    session.add(0, false, 3);
    session.reset();
    const cleared = session.snapshot();
    expect(cleared.total).toBe(0);
    expect(cleared.prefix).toBe(0);
    expect(cleared.points).toEqual([]);
    expect(cleared.firstTradeTime).toBeNull();
    expect(cleared.gaps).toEqual([]);
  });

  it("starts a new sum when the market session is replaced, and keeps the old one isolated", () => {
    const store = new MarketStore();
    store.mode = "live";
    store.symbol = "BTCUSDT";
    store.footprint.addTrade(buy(60_000, 4));
    const liveBook = store.footprint;
    expect(liveBook.cvdSeries("1m").total).toBeCloseTo(4);

    store.symbol = "ETHUSDT";
    store.mode = "demo";
    store.resetMarket(0.01);
    store.footprint.addTrade({ ...sell(60_000, 2, 3500), symbol: "ETHUSDT" });
    expect(store.footprint.cvdSeries("1m").total).toBeCloseTo(-2);
    expect(liveBook.cvdSeries("1m").total).toBeCloseTo(4);
    expect(store.footprint).not.toBe(liveBook);
  });
});

describe("disconnect holes and trimming", () => {
  it("records a hole without resetting CVD or filling the missing trades", () => {
    const book = new FootprintBook(0.1);
    book.addTrade(buy(0, 2));
    book.noteGap(30_000, 90_000);
    book.addTrade(sell(120_000, 0.5));
    const series = book.cvdSeries("1m");
    expect(series.total).toBeCloseTo(1.5);
    expect(series.gaps).toEqual([{ from: 30_000, to: 90_000 }]);
    const segments = cvdSegments(series.points, series.gaps);
    expect(segments).toHaveLength(2);
    expect(segments[0][0].cvd).toBeCloseTo(2);
    expect(segments[1][0].cvd).toBeCloseTo(1.5);
    book.noteGap(80_000, 100_000);
    expect(book.cvdSeries("1m").gaps).toEqual([{ from: 30_000, to: 100_000 }]);
    expect(book.cvdSeries("1m").total).toBeCloseTo(1.5);
  });

  it("keeps the dropped prefix inside later CVD values", () => {
    const book = new FootprintBook(0.1, 2);
    book.addTrade(buy(0, 5));
    book.addTrade(sell(60_000, 1));
    book.addTrade(buy(120_000, 2));
    const series = book.cvdSeries("1m");
    expect(series.prefix).toBeCloseTo(5);
    expect(series.points.map((point) => point.openTime)).toEqual([60_000, 120_000]);
    expect(series.points.map((point) => point.cvd)).toEqual([4, 6]);
    expect(series.total).toBeCloseTo(6);
    expect(series.points[0].cvd).not.toBeCloseTo(series.points[0].delta);

    book.addTrade(sell(10_000, 3));
    const afterLate = book.cvdSeries("1m");
    expect(afterLate.prefix).toBeCloseTo(2);
    expect(afterLate.total).toBeCloseTo(3);
    expect(afterLate.points[0].cvd).toBeCloseTo(1);
    expect(afterLate.points[1].cvd).toBeCloseTo(3);
  });
});
