import { describe, expect, it } from "vitest";
import { aggressorFromBuyerMaker, parseAggTrade } from "../src/market/aggressor";

describe("maker-side aggressor", () => {
  it("treats buyer-is-maker as an aggressive sell", () => {
    expect(aggressorFromBuyerMaker(true)).toBe("sell");
  });

  it("treats seller-is-maker as an aggressive buy", () => {
    expect(aggressorFromBuyerMaker(false)).toBe("buy");
  });

  it("parses futures aggTrade without guessing a missing flag", () => {
    const sell = parseAggTrade({
      e: "aggTrade",
      s: "BTCUSDT",
      p: "96420.1",
      q: "0.015",
      T: 1_700_000_000_000,
      m: true,
    });
    expect(sell).toMatchObject({ buyerIsMaker: true, qty: 0.015, price: 96420.1 });
    expect(aggressorFromBuyerMaker(sell!.buyerIsMaker)).toBe("sell");

    const buy = parseAggTrade({
      e: "aggTrade",
      s: "ETHUSDT",
      p: "3500.01",
      q: "1.2",
      T: 1_700_000_000_100,
      m: false,
    });
    expect(aggressorFromBuyerMaker(buy!.buyerIsMaker)).toBe("buy");
    expect(parseAggTrade({ e: "aggTrade", s: "BTCUSDT", p: "1", q: "1", T: 1 })).toBeNull();
  });
});
