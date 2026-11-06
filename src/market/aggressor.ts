export type Aggressor = "buy" | "sell";

/**
 * Binance aggTrade `m` is true when the buyer is the maker.
 * The aggressive side is the taker: buyer-maker means an aggressive sell.
 * USD-M futures uses the same flag as spot for this field.
 */
export function aggressorFromBuyerMaker(buyerIsMaker: boolean): Aggressor {
  return buyerIsMaker ? "sell" : "buy";
}

export interface AggTrade {
  symbol: string;
  time: number;
  price: number;
  qty: number;
  buyerIsMaker: boolean;
}

export function parseAggTrade(data: unknown): AggTrade | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (row.e !== "aggTrade") return null;
  if (typeof row.m !== "boolean") return null;
  const price = Number(row.p);
  const qty = Number(row.q);
  const time = Number(row.T);
  const symbol = row.s;
  if (typeof symbol !== "string") return null;
  if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(time)) return null;
  if (qty <= 0 || price <= 0) return null;
  return { symbol, time, price, qty, buyerIsMaker: row.m };
}
