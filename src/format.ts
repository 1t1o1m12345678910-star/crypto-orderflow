import { decimalsOf } from "./market/price";

export function formatPrice(price: number, tickSize: number): string {
  if (!Number.isFinite(price)) return "—";
  const digits = Math.min(Math.max(decimalsOf(tickSize), 0), 8);
  return price.toLocaleString("zh-Hant", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return "—";
  const abs = Math.abs(qty);
  if (abs >= 1000) return qty.toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
  if (abs >= 100) return qty.toFixed(1);
  if (abs >= 10) return qty.toFixed(2);
  if (abs >= 1) return qty.toFixed(3);
  if (abs >= 0.01) return qty.toFixed(4);
  return qty.toFixed(5);
}

export function formatDelta(delta: number): string {
  if (!Number.isFinite(delta)) return "—";
  const text = formatQty(Math.abs(delta));
  if (delta > 0) return `+${text}`;
  if (delta < 0) return `−${text}`;
  return "0";
}

export function formatClock(timeMs: number, withDate: boolean): string {
  const date = new Date(timeMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (!withDate) return `${hh}:${mm}`;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day} ${hh}:${mm}`;
}

export const BASE_ASSET: Record<"BTCUSDT" | "ETHUSDT", string> = {
  BTCUSDT: "BTC",
  ETHUSDT: "ETH",
};
