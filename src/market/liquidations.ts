/**
 * USD-M `@forceOrder` is a snapshot stream, not a full liquidation tape.
 * Changelog effective 2026-04-14: the wording changed from "the latest"
 * liquidation in the window to "the largest" liquidation in the window.
 * https://developers.binance.com/docs/derivatives
 */
export const LIQUIDATION_FEED = {
  complete: false,
  windowMs: 1000,
  selection: "largest",
  quantityUnit: "base",
  priceUnit: "USDT",
} as const;

export interface Liquidation {
  time: number;
  price: number;
  qty: number;
  /** Order side. SELL liquidates a long; BUY liquidates a short. */
  side: "BUY" | "SELL";
}

const MAX_LIQUIDATIONS = 400;

export function parseForceOrder(data: unknown, symbol: string): Liquidation | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (row.e !== "forceOrder" || !row.o || typeof row.o !== "object") return null;
  const order = row.o as Record<string, unknown>;
  if (order.s !== symbol) return null;
  if (order.S !== "BUY" && order.S !== "SELL") return null;
  const price = Number(order.ap ?? order.p);
  const filled = Number(order.z);
  const qty = filled > 0 ? filled : Number(order.q);
  const time = Number(order.T ?? row.E);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(time)) return null;
  if (price <= 0 || qty <= 0) return null;
  return { time, price, qty, side: order.S };
}

export function pushLiquidation(list: Liquidation[], next: Liquidation): void {
  list.push(next);
  if (list.length > MAX_LIQUIDATIONS) list.splice(0, list.length - MAX_LIQUIDATIONS);
}

export function liquidationNote(): string {
  return `清算標記不完整。幣安公開 forceOrder 每個合約每 ${LIQUIDATION_FEED.windowMs} 毫秒只推送該窗內最大的一筆，較小的強平不會出現；沒有強平時也不會推送。數量是基礎資產，價格是 ${LIQUIDATION_FEED.priceUnit}。SELL 是多單被強平，BUY 是空單被強平。`;
}
