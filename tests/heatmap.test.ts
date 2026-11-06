import { describe, expect, it } from "vitest";
import { FuturesDepthBook } from "../src/market/depthBook";
import { HeatmapTape, sumQty } from "../src/market/heatmap";
import { LIQUIDATION_FEED, parseForceOrder } from "../src/market/liquidations";

describe("heatmap and liquidation limits", () => {
  it("does not sample a book that has no snapshot", () => {
    const tape = new HeatmapTape();
    const book = new FuturesDepthBook(0.1);
    expect(tape.sample(1_000, book)).toBe(false);
    expect(tape.columns).toHaveLength(0);
    book.applySnapshot(1, [["100", "2"]], [["100.2", "3"]]);
    expect(tape.sample(2_000, book)).toBe(true);
    expect(tape.columns).toHaveLength(1);
    expect(sumQty(tape.columns[0].bids, 1000, 1000)).toBeCloseTo(2);
  });

  it("describes forceOrder as the largest print per 1000ms, in base asset and USDT", () => {
    expect(LIQUIDATION_FEED.complete).toBe(false);
    expect(LIQUIDATION_FEED.windowMs).toBe(1000);
    expect(LIQUIDATION_FEED.selection).toBe("largest");
    expect(LIQUIDATION_FEED.quantityUnit).toBe("base");
    expect(LIQUIDATION_FEED.priceUnit).toBe("USDT");
    const row = parseForceOrder(
      {
        e: "forceOrder",
        E: 2_000,
        o: {
          s: "BTCUSDT",
          S: "SELL",
          q: "1.5",
          p: "100",
          ap: "99.5",
          z: "1.25",
          T: 1_900,
        },
      },
      "BTCUSDT",
    );
    expect(row).toEqual({ time: 1_900, price: 99.5, qty: 1.25, side: "SELL" });
    expect(parseForceOrder({ e: "forceOrder", o: { s: "ETHUSDT", S: "BUY", q: "1", p: "1", z: "1", T: 1 } }, "BTCUSDT")).toBeNull();
  });
});
