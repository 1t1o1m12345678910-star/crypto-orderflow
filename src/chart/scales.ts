export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function timeToX(time: number, right: number, span: number, plot: Rect): number {
  return plot.x + ((time - (right - span)) / span) * plot.w;
}

export function xToTime(x: number, right: number, span: number, plot: Rect): number {
  return right - span + ((x - plot.x) / plot.w) * span;
}

export function priceToY(price: number, min: number, max: number, plot: Rect): number {
  const range = max - min || 1;
  return plot.y + ((max - price) / range) * plot.h;
}

export function yToPrice(y: number, min: number, max: number, plot: Rect): number {
  const range = max - min || 1;
  return max - ((y - plot.y) / plot.h) * range;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
