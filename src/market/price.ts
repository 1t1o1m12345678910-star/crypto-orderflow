export function decimalsOf(tickSize: number): number {
  if (!(tickSize > 0) || !Number.isFinite(tickSize)) return 0;
  const text = tickSize.toString().toLowerCase();
  if (text.includes("e-")) {
    const [base, exp] = text.split("e-");
    const baseDecimals = base.includes(".") ? base.split(".")[1].length : 0;
    return Number(exp) + baseDecimals;
  }
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Round a trade price onto the exchange tick grid without accumulating float drift. */
export function priceToTick(price: number, tickSize: number): number {
  const scaled = price / tickSize;
  if (!Number.isFinite(scaled)) return 0;
  const nudged = scaled + Math.sign(scaled) * 1e-8;
  return Math.round(nudged);
}

export function tickToPrice(tick: number, tickSize: number): number {
  const decimals = decimalsOf(tickSize);
  const scale = 10 ** decimals;
  const tickUnits = Math.round(tickSize * scale);
  return (tick * tickUnits) / scale;
}
