import type { Aggressor } from "../market/aggressor";
import type { Candle } from "../market/candles";
import type { CvdSnapshot } from "../market/cvd";
import { cvdInView, cvdSegments } from "../market/cvd";
import type { FootprintBar } from "../market/footprint";
import type { HeatColumn } from "../market/heatmap";
import { sumQty } from "../market/heatmap";
import type { Liquidation } from "../market/liquidations";
import { priceToTick, tickToPrice } from "../market/price";
import { timeframeMs, type Timeframe } from "../market/time";
import { formatClock, formatDelta, formatPrice } from "../format";
import { priceToY, timeToX, type Rect } from "./scales";

export interface ChartLayers {
  footprint: boolean;
  heatmap: boolean;
  liquidations: boolean;
  volume: boolean;
  candles: boolean;
  cvd: boolean;
}

export interface ChartModel {
  now: number;
  timeframe: Timeframe;
  tickSize: number;
  right: number;
  span: number;
  priceZoom: number;
  priceShift: number;
  candles: Candle[];
  bars: FootprintBar[];
  cvd: CvdSnapshot;
  heat: HeatColumn[];
  liquidations: Liquidation[];
  layers: ChartLayers;
  lastPrice: number | null;
  lastAggressor: Aggressor | null;
  sessionStartedAt: number | null;
  mode: "live" | "demo";
  hover: { x: number; y: number } | null;
}

export interface ChartLayout {
  plot: Rect;
  flow: Rect | null;
  volume: Rect | null;
  width: number;
  height: number;
  priceMin: number;
  priceMax: number;
}

const SANS =
  '"Segoe UI", "PingFang TC", "Noto Sans CJK TC", "Microsoft JhengHei", "WenQuanYi Micro Hei", "Droid Sans Fallback", sans-serif';
const MONO = '"Noto Sans Mono", ui-monospace, "Cascadia Mono", Menlo, monospace';

export class ChartRenderer {
  private bidBuf = new Float32Array(0);
  private askBuf = new Float32Array(0);
  private heatCanvas: HTMLCanvasElement | null = null;

  draw(ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number, dpr: number, model: ChartModel): ChartLayout {
    const width = Math.max(1, cssWidth);
    const height = Math.max(1, cssHeight);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0c1218";
    ctx.fillRect(0, 0, width, height);

    const volumeHeight = model.layers.volume ? Math.max(56, Math.min(84, height * 0.14)) : 0;
    const flowHeight = model.layers.cvd ? Math.max(64, Math.min(84, height * 0.15)) : 0;
    const plot: Rect = {
      x: 10,
      y: 12,
      w: Math.max(10, width - 84),
      h: Math.max(10, height - 36 - volumeHeight - flowHeight - (volumeHeight ? 8 : 0) - (flowHeight ? 8 : 0)),
    };
    let cursorY = plot.y + plot.h + 6;
    const flow: Rect | null = flowHeight ? { x: plot.x, y: cursorY, w: plot.w, h: flowHeight - 6 } : null;
    if (flow) cursorY += flowHeight;
    const volume: Rect | null = volumeHeight ? { x: plot.x, y: cursorY, w: plot.w, h: volumeHeight - 8 } : null;
    const range = priceRange(model);
    const layout: ChartLayout = { plot, flow, volume, width, height, priceMin: range.min, priceMax: range.max };

    this.drawPlotBackground(ctx, plot);
    if (model.layers.heatmap) this.drawHeat(ctx, model, layout);
    this.drawGrid(ctx, model, layout);
    if (model.layers.candles) this.drawHistoryCandles(ctx, model, layout);
    if (model.layers.footprint) this.drawFootprint(ctx, model, layout);
    if (model.layers.liquidations) this.drawLiquidations(ctx, model, layout);
    this.drawLastPrice(ctx, model, layout);
    if (model.mode === "demo") this.drawWatermark(ctx, plot);
    this.drawAxes(ctx, model, layout);
    if (flow && model.layers.cvd) this.drawFlow(ctx, model, layout, flow);
    if (volume && model.layers.volume) this.drawVolume(ctx, model, layout, volume);
    if (model.hover) this.drawCrosshair(ctx, model, layout);
    if (model.bars.length === 0 && model.candles.length === 0) {
      ctx.fillStyle = "#d5e2ee";
      ctx.font = `15px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("沒有可畫的行情", plot.x + plot.w / 2, plot.y + plot.h / 2);
      ctx.textAlign = "left";
    }
    return layout;
  }

  private drawPlotBackground(ctx: CanvasRenderingContext2D, plot: Rect): void {
    ctx.fillStyle = "#101820";
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
  }

  private drawHeat(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    const { plot, priceMin, priceMax } = layout;
    const heatW = Math.max(1, Math.min(960, Math.ceil(plot.w)));
    const heatH = Math.max(1, Math.min(640, Math.ceil(plot.h)));
    if (this.bidBuf.length !== heatW * heatH) {
      this.bidBuf = new Float32Array(heatW * heatH);
      this.askBuf = new Float32Array(heatW * heatH);
    } else {
      this.bidBuf.fill(0);
      this.askBuf.fill(0);
    }
    const t0 = model.right - model.span;
    const samples = model.heat.filter((column) => column.time >= t0 - 1_000 && column.time <= model.right + 1_000);
    if (samples.length === 0) return;
    const sx = heatW / plot.w;
    const columnPx = Math.max(1, Math.round(((1_000 / model.span) * plot.w * sx)));
    for (const sample of samples) {
      const x0 = Math.floor((timeToX(sample.time, model.right, model.span, plot) - plot.x) * sx);
      if (x0 >= heatW || x0 + columnPx < 0) continue;
      splat(this.bidBuf, sample.bids, x0, columnPx, heatW, heatH, priceMin, priceMax, model.tickSize);
      splat(this.askBuf, sample.asks, x0, columnPx, heatW, heatH, priceMin, priceMax, model.tickSize);
    }
    let max = 1e-6;
    for (let i = 0; i < this.bidBuf.length; i++) {
      const value = this.bidBuf[i] + this.askBuf[i];
      if (value > max) max = value;
    }
    const canvas = this.ensureHeatCanvas(heatW, heatH);
    const heatCtx = canvas.getContext("2d");
    if (!heatCtx) return;
    const image = heatCtx.createImageData(heatW, heatH);
    const data = image.data;
    for (let i = 0; i < this.bidBuf.length; i++) {
      const bid = this.bidBuf[i];
      const ask = this.askBuf[i];
      if (bid === 0 && ask === 0) continue;
      const bn = Math.sqrt(bid / max);
      const an = Math.sqrt(ask / max);
      const offset = i * 4;
      data[offset] = Math.round(32 + an * 230);
      data[offset + 1] = Math.round(48 + an * 110 + bn * 90);
      data[offset + 2] = Math.round(32 + bn * 220);
      data[offset + 3] = Math.round(255 * Math.min(0.82, bn * 0.9 + an * 0.9));
    }
    heatCtx.putImageData(image, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    ctx.drawImage(canvas, plot.x, plot.y, plot.w, plot.h);
    ctx.restore();
  }

  private ensureHeatCanvas(width: number, height: number): HTMLCanvasElement {
    if (!this.heatCanvas || this.heatCanvas.width !== width || this.heatCanvas.height !== height) {
      this.heatCanvas = document.createElement("canvas");
      this.heatCanvas.width = width;
      this.heatCanvas.height = height;
    }
    return this.heatCanvas;
  }

  private drawGrid(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    const { plot, priceMin, priceMax } = layout;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    ctx.strokeStyle = "rgba(148, 168, 188, 0.16)";
    ctx.lineWidth = 1;
    const step = niceStep((priceMax - priceMin) / 6);
    const first = Math.ceil(priceMin / step) * step;
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = "#8ea3b8";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let price = first; price <= priceMax; price += step) {
      const y = priceToY(price, priceMin, priceMax, plot);
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
    }
    const tStep = timeStep(model.span);
    const tStart = Math.ceil((model.right - model.span) / tStep) * tStep;
    for (let time = tStart; time <= model.right; time += tStep) {
      const x = timeToX(time, model.right, model.span, plot);
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
    }
    if (model.sessionStartedAt !== null && model.mode === "live") {
      const x = timeToX(model.sessionStartedAt, model.right, model.span, plot);
      if (x >= plot.x && x <= plot.x + plot.w) {
        ctx.strokeStyle = "rgba(240, 212, 138, 0.7)";
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  private drawHistoryCandles(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    const slot = timeframeMs(model.timeframe);
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.plot.x, layout.plot.y, layout.plot.w, layout.plot.h);
    ctx.clip();
    ctx.lineWidth = 1;
    for (const candle of model.candles) {
      const kind = classifyBar(candle.openTime, slot, model);
      if (kind !== "history" && kind !== "partial") continue;
      if (candle.openTime > model.right || candle.openTime + slot < model.right - model.span) continue;
      const x = timeToX(candle.openTime + slot / 2, model.right, model.span, layout.plot);
      const bodyWidth = Math.max(2, (timeToX(candle.openTime + slot, model.right, model.span, layout.plot) - timeToX(candle.openTime, model.right, model.span, layout.plot)) * 0.62);
      const yHigh = priceToY(candle.high, layout.priceMin, layout.priceMax, layout.plot);
      const yLow = priceToY(candle.low, layout.priceMin, layout.priceMax, layout.plot);
      const yOpen = priceToY(candle.open, layout.priceMin, layout.priceMax, layout.plot);
      const yClose = priceToY(candle.close, layout.priceMin, layout.priceMax, layout.plot);
      ctx.strokeStyle = kind === "partial" ? "rgba(240, 212, 138, 0.85)" : "rgba(154, 175, 194, 0.85)";
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();
      const top = Math.min(yOpen, yClose);
      const height = Math.max(1, Math.abs(yClose - yOpen));
      ctx.strokeRect(x - bodyWidth / 2, top, bodyWidth, height);
    }
    ctx.restore();
  }

  private drawFootprint(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    const slot = timeframeMs(model.timeframe);
    const { plot, priceMin, priceMax } = layout;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const bar of model.bars) {
      if (bar.openTime > model.right || bar.openTime + slot < model.right - model.span) continue;
      const x0 = timeToX(bar.openTime, model.right, model.span, plot);
      const x1 = timeToX(bar.openTime + slot, model.right, model.span, plot);
      const bodyWidth = Math.max(2, (x1 - x0) * 0.78);
      const x = (x0 + x1) / 2;
      const yHigh = priceToY(bar.high, priceMin, priceMax, plot);
      const yLow = priceToY(bar.low, priceMin, priceMax, plot);
      ctx.strokeStyle = "rgba(213, 226, 238, 0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();
      const rawCell = Math.abs(
        priceToY(0, priceMin, priceMax, plot) - priceToY(model.tickSize, priceMin, priceMax, plot),
      );
      const group = Math.max(1, Math.ceil(15 / Math.max(rawCell, 0.25)));
      const cellH = rawCell * group;
      const grouped = new Map<number, { buy: number; sell: number }>();
      for (const [tick, cell] of bar.levels) {
        const bucket = Math.floor(tick / group) * group;
        const row = grouped.get(bucket) ?? { buy: 0, sell: 0 };
        row.buy += cell.buy;
        row.sell += cell.sell;
        grouped.set(bucket, row);
      }
      for (const [bucket, cell] of grouped) {
        const price = tickToPrice(bucket + (group - 1) / 2, model.tickSize);
        if (price < priceMin || price > priceMax) continue;
        const y = priceToY(price, priceMin, priceMax, plot);
        const total = cell.buy + cell.sell;
        if (total <= 0) continue;
        const top = y - cellH / 2;
        const left = x - bodyWidth / 2;
        const half = bodyWidth / 2;
        if (cellH >= 2 && bodyWidth >= 4) {
          const sellTone = Math.min(0.85, 0.22 + cell.sell / total);
          const buyTone = Math.min(0.85, 0.22 + cell.buy / total);
          ctx.fillStyle = `rgba(255, 176, 32, ${sellTone})`;
          ctx.fillRect(left, top, half - 0.5, Math.max(1, cellH - 1));
          ctx.fillStyle = `rgba(78, 161, 255, ${buyTone})`;
          ctx.fillRect(left + half, top, half - 0.5, Math.max(1, cellH - 1));
        }
        if (cellH >= 13 && half >= 18) {
          ctx.font = `${cellH >= 18 ? 11 : 10}px ${MONO}`;
          ctx.fillStyle = "#ffe1ad";
          ctx.fillText(compactQty(cell.sell), left + half / 2, y);
          ctx.fillStyle = "#d7ebff";
          ctx.fillText(compactQty(cell.buy), left + half + half / 2, y);
        }
      }
    }
    ctx.restore();
  }

  private drawLiquidations(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    const { plot, priceMin, priceMax } = layout;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    ctx.font = `10px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const liquidation of model.liquidations) {
      const x = timeToX(liquidation.time, model.right, model.span, plot);
      const y = priceToY(liquidation.price, priceMin, priceMax, plot);
      if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) continue;
      const long = liquidation.side === "SELL";
      ctx.fillStyle = long ? "#ffd166" : "#d2b4ff";
      ctx.beginPath();
      if (long) {
        ctx.moveTo(x, y + 9);
        ctx.lineTo(x - 8, y - 6);
        ctx.lineTo(x + 8, y - 6);
      } else {
        ctx.moveTo(x, y - 9);
        ctx.lineTo(x - 8, y + 6);
        ctx.lineTo(x + 8, y + 6);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#1a1408";
      ctx.fillText(long ? "多" : "空", x, y + (long ? -1 : 1));
    }
    ctx.restore();
  }

  private drawLastPrice(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    if (model.lastPrice === null) return;
    const y = priceToY(model.lastPrice, layout.priceMin, layout.priceMax, layout.plot);
    if (y < layout.plot.y || y > layout.plot.y + layout.plot.h) return;
    const color = model.lastAggressor === "sell" ? "#ffb020" : "#4ea1ff";
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(layout.plot.x, y);
    ctx.lineTo(layout.plot.x + layout.plot.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = formatPrice(model.lastPrice, model.tickSize);
    ctx.font = `12px ${MONO}`;
    const boxW = ctx.measureText(label).width + 12;
    ctx.fillStyle = color;
    ctx.fillRect(layout.plot.x + layout.plot.w + 4, y - 9, boxW, 18);
    ctx.fillStyle = "#102033";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, layout.plot.x + layout.plot.w + 10, y);
    ctx.restore();
  }

  private drawWatermark(ctx: CanvasRenderingContext2D, plot: Rect): void {
    ctx.save();
    ctx.translate(plot.x + plot.w / 2, plot.y + plot.h / 2);
    ctx.rotate(-0.35);
    ctx.font = `28px ${SANS}`;
    ctx.fillStyle = "rgba(240, 212, 138, 0.13)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("示範資料", 0, 0);
    ctx.restore();
  }

  private drawAxes(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    const { plot, priceMin, priceMax, width, height } = layout;
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = "#9eb2c6";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const step = niceStep((priceMax - priceMin) / 6);
    const first = Math.ceil(priceMin / step) * step;
    for (let price = first; price <= priceMax; price += step) {
      const y = priceToY(price, priceMin, priceMax, plot);
      if (y < plot.y + 8 || y > plot.y + plot.h - 8) continue;
      ctx.fillText(formatPrice(price, model.tickSize), plot.x + plot.w + 8, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const tStep = timeStep(model.span);
    const tStart = Math.ceil((model.right - model.span) / tStep) * tStep;
    const withDate = model.span > 18 * 60 * 60_000;
    for (let time = tStart; time <= model.right; time += tStep) {
      const x = timeToX(time, model.right, model.span, plot);
      if (x < plot.x + 24 || x > plot.x + plot.w - 24) continue;
      ctx.fillText(formatClock(time, withDate), x, height - 18);
    }
    ctx.textAlign = "left";
    ctx.font = `11px ${SANS}`;
    ctx.fillStyle = "#7f93a8";
    ctx.fillText("USDT", width - 78, 2);
  }

  private drawFlow(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout, flow: Rect): void {
    ctx.fillStyle = "#0d141c";
    ctx.fillRect(flow.x, flow.y, flow.w, flow.h);
    const slot = timeframeMs(model.timeframe);
    const viewFrom = model.right - model.span;
    const visible = cvdInView(model.cvd, viewFrom, model.right + slot);
    ctx.save();
    ctx.beginPath();
    ctx.rect(flow.x, flow.y, flow.w, flow.h);
    ctx.clip();
    const midY = flow.y + flow.h * 0.62;
    ctx.strokeStyle = "rgba(148, 168, 188, 0.35)";
    ctx.beginPath();
    ctx.moveTo(flow.x, midY);
    ctx.lineTo(flow.x + flow.w, midY);
    ctx.stroke();
    let maxAbs = 1e-6;
    for (const point of visible) maxAbs = Math.max(maxAbs, Math.abs(point.delta));
    const deltaAmp = (flow.h * 0.28) / maxAbs;
    for (const point of visible) {
      const x0 = timeToX(point.openTime, model.right, model.span, layout.plot);
      const width = Math.max(1, (timeToX(point.openTime + slot, model.right, model.span, layout.plot) - x0) * 0.7);
      const height = point.delta * deltaAmp;
      ctx.fillStyle = point.delta >= 0 ? "rgba(78, 161, 255, 0.85)" : "rgba(255, 176, 32, 0.9)";
      ctx.fillRect(x0, height >= 0 ? midY - height : midY, width, Math.max(1, Math.abs(height)));
    }
    if (visible.length > 0) {
      let minCvd = Infinity;
      let maxCvd = -Infinity;
      for (const point of visible) {
        minCvd = Math.min(minCvd, point.cvd);
        maxCvd = Math.max(maxCvd, point.cvd);
      }
      if (minCvd === maxCvd) {
        minCvd -= 1;
        maxCvd += 1;
      }
      const pad = (maxCvd - minCvd) * 0.12;
      minCvd -= pad;
      maxCvd += pad;
      const yOf = (value: number) => flow.y + 12 + ((maxCvd - value) / (maxCvd - minCvd)) * (flow.h - 18);
      if (minCvd < 0 && maxCvd > 0) {
        ctx.strokeStyle = "rgba(240, 212, 138, 0.35)";
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(flow.x, yOf(0));
        ctx.lineTo(flow.x + flow.w, yOf(0));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = "#f0d48a";
      ctx.lineWidth = 1.6;
      for (const segment of cvdSegments(visible, model.cvd.gaps)) {
        ctx.beginPath();
        segment.forEach((point, index) => {
          const x = timeToX(point.openTime + slot / 2, model.right, model.span, layout.plot);
          const y = yOf(point.cvd);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      const last = visible[visible.length - 1];
      ctx.fillStyle = last.cvd >= 0 ? "#d7ebff" : "#ffe1ad";
      ctx.font = `11px ${MONO}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(formatDelta(last.cvd), flow.x + flow.w - 4, yOf(last.cvd));
    }
    if (model.cvd.firstTradeTime !== null) {
      const x = timeToX(model.cvd.firstTradeTime, model.right, model.span, layout.plot);
      if (x >= flow.x && x <= flow.x + flow.w) {
        ctx.fillStyle = "#f0d48a";
        ctx.fillRect(x - 1, flow.y + 2, 2, 8);
      }
    }
    for (const gap of model.cvd.gaps) {
      const x0 = timeToX(gap.from, model.right, model.span, layout.plot);
      const x1 = timeToX(gap.to, model.right, model.span, layout.plot);
      const left = Math.max(flow.x, Math.min(x0, x1));
      const right = Math.min(flow.x + flow.w, Math.max(x0, x1));
      if (right - left < 1) continue;
      ctx.fillStyle = "rgba(255, 176, 138, 0.16)";
      ctx.fillRect(left, flow.y, right - left, flow.h);
    }
    ctx.restore();
    ctx.fillStyle = "#8ea3b8";
    ctx.font = `11px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Delta 柱 · CVD 線", flow.x + 4, flow.y + 2);
  }

  private drawVolume(
    ctx: CanvasRenderingContext2D,
    model: ChartModel,
    layout: ChartLayout,
    volume: Rect,
  ): void {
    ctx.fillStyle = "#0d141c";
    ctx.fillRect(volume.x, volume.y, volume.w, volume.h);
    const slot = timeframeMs(model.timeframe);
    let max = 1e-6;
    const bars = new Map(model.bars.map((bar) => [bar.openTime, bar]));
    for (const candle of model.candles) {
      const kind = classifyBar(candle.openTime, slot, model);
      if (kind === "history") max = Math.max(max, candle.volume);
    }
    for (const bar of model.bars) max = Math.max(max, bar.buy + bar.sell);
    const t0 = model.right - model.span;
    ctx.save();
    ctx.beginPath();
    ctx.rect(volume.x, volume.y, volume.w, volume.h);
    ctx.clip();
    for (const candle of model.candles) {
      if (classifyBar(candle.openTime, slot, model) !== "history") continue;
      if (candle.openTime > model.right || candle.openTime + slot < t0) continue;
      const x0 = timeToX(candle.openTime, model.right, model.span, layout.plot);
      const width = Math.max(1, (timeToX(candle.openTime + slot, model.right, model.span, layout.plot) - x0) * 0.72);
      const height = (candle.volume / max) * (volume.h - 14);
      ctx.fillStyle = "rgba(154, 175, 194, 0.55)";
      ctx.fillRect(x0, volume.y + volume.h - height, width, height);
    }
    for (const bar of bars.values()) {
      if (bar.openTime > model.right || bar.openTime + slot < t0) continue;
      const x0 = timeToX(bar.openTime, model.right, model.span, layout.plot);
      const width = Math.max(1, (timeToX(bar.openTime + slot, model.right, model.span, layout.plot) - x0) * 0.72);
      const buyH = (bar.buy / max) * (volume.h - 14);
      const sellH = (bar.sell / max) * (volume.h - 14);
      const base = volume.y + volume.h;
      ctx.fillStyle = "#4ea1ff";
      ctx.fillRect(x0, base - buyH, width, buyH);
      ctx.fillStyle = "#ffb020";
      ctx.fillRect(x0, base - buyH - sellH, width, sellH);
    }
    ctx.restore();
    ctx.fillStyle = "#8ea3b8";
    ctx.font = `11px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("成交量", volume.x + 4, volume.y + 2);
  }

  private drawCrosshair(ctx: CanvasRenderingContext2D, model: ChartModel, layout: ChartLayout): void {
    const hover = model.hover;
    if (!hover) return;
    const { plot } = layout;
    if (hover.x < plot.x || hover.x > plot.x + plot.w || hover.y < plot.y || hover.y > plot.y + plot.h) return;
    ctx.save();
    ctx.strokeStyle = "rgba(232, 240, 248, 0.35)";
    ctx.beginPath();
    ctx.moveTo(hover.x, plot.y);
    ctx.lineTo(hover.x, plot.y + plot.h);
    ctx.moveTo(plot.x, hover.y);
    ctx.lineTo(plot.x + plot.w, hover.y);
    ctx.stroke();
    ctx.restore();
  }
}

export type BarKind = "history" | "partial" | "observed" | "demo" | "empty";

export function classifyBar(openTime: number, slot: number, model: Pick<ChartModel, "mode" | "sessionStartedAt">): BarKind {
  if (model.mode === "demo") return "demo";
  if (model.sessionStartedAt === null) return "history";
  if (openTime + slot <= model.sessionStartedAt) return "history";
  if (openTime < model.sessionStartedAt) return "partial";
  return "observed";
}

export interface HoverInfo {
  time: number;
  price: number;
  bar: FootprintBar | null;
  candle: Candle | null;
  kind: BarKind;
  liquidation: Liquidation | null;
  bidQty: number;
  askQty: number;
  delta: number | null;
  cvd: number | null;
  cvdGap: boolean;
}

export function hoverInfo(model: ChartModel, layout: ChartLayout, x: number, y: number): HoverInfo | null {
  const { plot } = layout;
  const inPlot = x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h;
  const flow = layout.flow;
  const inFlow = flow !== null && x >= flow.x && x <= flow.x + flow.w && y >= flow.y && y <= flow.y + flow.h;
  if (!inPlot && !inFlow) return null;
  const time = model.right - model.span + ((x - plot.x) / plot.w) * model.span;
  const price = inPlot
    ? layout.priceMax - ((y - plot.y) / plot.h) * (layout.priceMax - layout.priceMin)
    : (model.lastPrice ?? layout.priceMax);
  const slot = timeframeMs(model.timeframe);
  const openTime = Math.floor(time / slot) * slot;
  const bar = model.bars.find((item) => item.openTime === openTime) ?? null;
  const candle = model.candles.find((item) => item.openTime === openTime) ?? null;
  let liquidation: Liquidation | null = null;
  let best = 18;
  for (const item of model.liquidations) {
    const lx = timeToX(item.time, model.right, model.span, plot);
    const ly = priceToY(item.price, layout.priceMin, layout.priceMax, plot);
    const distance = Math.hypot(lx - x, ly - y);
    if (distance < best) {
      best = distance;
      liquidation = item;
    }
  }
  const tick = priceToTick(price, model.tickSize);
  const column = nearestColumn(model.heat, time);
  const bidQty = column ? sumQty(column.bids, tick - 1, tick + 1) : 0;
  const askQty = column ? sumQty(column.asks, tick - 1, tick + 1) : 0;
  const cvdPoint = model.cvd.points.find((point) => point.openTime === openTime) ?? null;
  const cvdGap = model.cvd.gaps.some((gap) => gap.from < openTime + slot && gap.to > openTime);
  return {
    time,
    price,
    bar,
    candle,
    kind: bar ? classifyBar(openTime, slot, model) : candle ? classifyBar(openTime, slot, model) : "empty",
    liquidation,
    bidQty,
    askQty,
    delta: cvdPoint ? cvdPoint.delta : bar ? bar.buy - bar.sell : null,
    cvd: cvdPoint ? cvdPoint.cvd : null,
    cvdGap,
  };
}

function nearestColumn(columns: HeatColumn[], time: number): HeatColumn | null {
  let best: HeatColumn | null = null;
  let distance = 1_500;
  for (const column of columns) {
    const delta = Math.abs(column.time - time);
    if (delta < distance) {
      distance = delta;
      best = column;
    }
  }
  return best;
}

function splat(
  buffer: Float32Array,
  side: HeatColumn["bids"],
  x0: number,
  columnPx: number,
  width: number,
  height: number,
  priceMin: number,
  priceMax: number,
  tickSize: number,
): void {
  const start = Math.max(0, x0);
  const end = Math.min(width, x0 + columnPx);
  if (end <= start) return;
  for (let i = 0; i < side.ticks.length; i++) {
    const price = tickToPrice(side.ticks[i], tickSize);
    if (price < priceMin || price > priceMax) continue;
    const y = ((priceMax - price) / (priceMax - priceMin || 1)) * height;
    const row = Math.floor(y);
    if (row < 0 || row >= height) continue;
    const qty = side.qty[i];
    const base = row * width;
    for (let x = start; x < end; x++) buffer[base + x] += qty;
  }
}

function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const error = rough / pow;
  const factor = error >= 7.5 ? 10 : error >= 3.5 ? 5 : error >= 1.5 ? 2 : 1;
  return factor * pow;
}

function timeStep(span: number): number {
  const choices = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
  for (const choice of choices) if (span / choice <= 8) return choice;
  return choices[choices.length - 1];
}

function compactQty(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 100) return sign + abs.toFixed(0);
  if (abs >= 10) return sign + abs.toFixed(1);
  if (abs >= 1) return sign + abs.toFixed(2);
  return sign + abs.toFixed(3);
}

function priceRange(model: ChartModel): { min: number; max: number } {
  const slot = timeframeMs(model.timeframe);
  const t0 = model.right - model.span;
  const t1 = model.right;
  let min = Infinity;
  let max = -Infinity;
  const consider = (price: number) => {
    if (price > 0 && Number.isFinite(price)) {
      if (price < min) min = price;
      if (price > max) max = price;
    }
  };
  for (const candle of model.candles) {
    if (candle.openTime + slot < t0 || candle.openTime > t1) continue;
    consider(candle.high);
    consider(candle.low);
  }
  for (const bar of model.bars) {
    if (bar.openTime + slot < t0 || bar.openTime > t1) continue;
    consider(bar.high);
    consider(bar.low);
  }
  if (model.lastPrice !== null) consider(model.lastPrice);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const anchor = model.lastPrice ?? 100;
    min = anchor * 0.998;
    max = anchor * 1.002;
  }
  if (max - min < model.tickSize * 8) {
    const mid = (max + min) / 2;
    min = mid - model.tickSize * 8;
    max = mid + model.tickSize * 8;
  }
  const pad = (max - min) * 0.08;
  const mid = (min + max) / 2 + model.priceShift;
  const half = ((max - min) / 2 + pad) * model.priceZoom;
  return { min: mid - half, max: mid + half };
}
