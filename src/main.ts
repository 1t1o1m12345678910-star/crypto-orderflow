import { bindChartGestures } from "./chart/gestures";
import { hoverInfo, ChartRenderer, type ChartLayers, type ChartModel } from "./chart/render";
import { clamp } from "./chart/scales";
import { DemoSession } from "./demo/demoSession";
import { BASE_ASSET, formatClock, formatDelta, formatPrice, formatQty } from "./format";
import { barDelta } from "./market/footprint";
import { liquidationNote } from "./market/liquidations";
import { timeframeMs, type Timeframe } from "./market/time";
import { LiveSession } from "./net/liveSession";
import { MarketStore, type SymbolId } from "./store";

const store = new MarketStore();
const layers: ChartLayers = {
  footprint: true,
  heatmap: true,
  liquidations: true,
  volume: true,
  candles: true,
  cvd: true,
};
const view = {
  span: 32 * 60_000,
  right: Date.now(),
  follow: true,
  priceZoom: 1,
  priceShift: 0,
};
let hover: { x: number; y: number } | null = null;
let dirty = true;
let lastHud = 0;
let lastDraw = 0;

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("找不到 #app");

app.innerHTML = `
  <header class="top">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <h1>合約訂單流</h1>
        <p>幣安 U 本位永續 · 公開行情 · 瀏覽器運算 · 不下單</p>
      </div>
    </div>
    <div class="controls">
      <div class="seg" role="group" aria-label="合約">
        <button type="button" data-symbol="BTCUSDT" aria-pressed="true">BTC</button>
        <button type="button" data-symbol="ETHUSDT" aria-pressed="false">ETH</button>
      </div>
      <div class="seg" role="group" aria-label="週期">
        <button type="button" data-tf="1m" aria-pressed="true">1 分</button>
        <button type="button" data-tf="5m" aria-pressed="false">5 分</button>
        <button type="button" data-tf="15m" aria-pressed="false">15 分</button>
      </div>
      <div class="seg" role="group" aria-label="圖層">
        <button type="button" data-layer="footprint" aria-pressed="true">足跡</button>
        <button type="button" data-layer="heatmap" aria-pressed="true">熱圖</button>
        <button type="button" data-layer="liquidations" aria-pressed="true">清算</button>
        <button type="button" data-layer="volume" aria-pressed="true">量能</button>
        <button type="button" data-layer="cvd" aria-pressed="true">CVD</button>
        <button type="button" data-layer="candles" aria-pressed="true">K 線</button>
      </div>
      <div class="zoom" role="group" aria-label="縮放">
        <button type="button" id="zoom-out" aria-label="縮小">−</button>
        <button type="button" id="zoom-in" aria-label="放大">＋</button>
      </div>
      <button type="button" class="ghost" id="reset">重設畫面</button>
      <button type="button" class="ghost" id="follow" aria-pressed="true">跟隨</button>
      <button type="button" class="ghost" id="live" aria-pressed="true">即時</button>
      <button type="button" class="ghost demo" id="demo" aria-pressed="false">示範</button>
      <button type="button" class="ghost" id="retry">再試一次</button>
    </div>
  </header>
  <section class="status loading" id="status" role="status" aria-live="polite">
    <strong id="status-text">準備連線</strong>
    <p id="status-detail"></p>
  </section>
  <section class="hud" aria-label="目前數值">
    <div><span>最新價 USDT</span><b id="hud-price">—</b></div>
    <div><span>買一 / 賣一</span><b id="hud-bbo">—</b></div>
    <div><span>當根 Delta</span><b id="hud-delta">—</b></div>
    <div><span id="hud-cvd-label">CVD 累計</span><b id="hud-cvd">—</b></div>
    <div><span>已觀察逐筆</span><b id="hud-trades">0</b></div>
    <div><span>清算筆數（不完整）</span><b id="hud-liq">0</b></div>
    <div><span id="hud-unit-label">數量單位</span><b id="hud-unit">BTC</b></div>
  </section>
  <p class="cvd-note" id="cvd-note"></p>
  <div class="chart-wrap" id="chart-wrap">
    <canvas id="chart" aria-label="訂單流圖：足跡、CVD、掛單熱圖、清算與成交量"></canvas>
    <div class="banner" id="banner"></div>
    <div class="tip" id="tip" hidden></div>
  </div>
  <div class="legend" aria-label="圖例">
    <span><i class="swatch sell"></i>足跡左欄：主動賣（打到 Bid）</span>
    <span><i class="swatch buy"></i>足跡右欄：主動買（打到 Ask）</span>
    <span><i class="swatch buy"></i>熱圖藍：可撤買單</span>
    <span><i class="swatch sell"></i>熱圖橙：可撤賣單</span>
    <span><i class="swatch history"></i>空心灰蠟燭：交易所 K 線，無足跡</span>
    <span><i class="tri down"></i>多單強平（SELL）</span>
    <span><i class="tri up"></i>空單強平（BUY）</span>
    <span>灰色量柱是 K 線總量，沒有主動方向</span>
  </div>
  <details class="guide" id="guide">
    <summary>怎麼讀這張圖</summary>
    <article>
      <h2>足跡</h2>
      <p>每一格是該價位已經成交的量。幣安 aggTrade 的 m 為 true 代表買方是掛單者，所以這筆是主動賣出；m 為 false 是主動買進。左欄是主動賣，也就是打到買方掛單（Bid）；右欄是主動買，也就是打到賣方掛單（Ask）。格子太扁時，相鄰價位會合併，數字是該價格帶的合計。</p>
      <h2>Delta 與 CVD</h2>
      <p>Delta 是這一根裡的主動買減主動賣。正值是主動買比較多，負值是主動賣比較多。CVD 是從本頁這一輪第一筆實際收到的成交開始，把 Delta 一路加總，再連成線，用來和同一時間的價格對照。它不是未平倉量（OI），也不能單靠正負確認誰是主力，或價格一定接著漲跌。縮放、平移和「重設」只動畫面，不改這個起點。換合約，或在即時與示範之間切換，才會另起一條從零開始的累計。斷線或背景漏掉的成交不會補進 CVD，也不會把缺口當成 0 或把曲線歸零。歷史 K 線沒有逐筆，不會拿來編 CVD。</p>
      <h2>K 線不是足跡</h2>
      <p>左側空心灰蠟燭來自 REST /fapi/v1/klines，只有開高低收和總成交量。它沒有每個價位的主動買賣，也沒有當時的掛單，不能當成足跡或熱圖歷史。連線之後新收到的逐筆，才會畫進足跡。1 分、5 分、15 分的邊界對齊 Unix 時間，與幣安 K 線相同；座標上的鐘點換算成你的本機時區。</p>
      <h2>掛單熱圖</h2>
      <p>熱圖是訂單簿同步之後大約每秒拍一次、還掛在簿上的量。那些單可以撤掉，不是成交。藍是買單，橙是賣單。公開 API 沒有掛單歷史，剛連上時左側不會有熱圖，也不會用 K 線冒充。為了控制記憶體，只保留約 7 分鐘、靠近中間價的檔位。</p>
      <h2>合約深度，不是現貨</h2>
      <p>連線後先緩衝 depth@100ms，再抓 /fapi/v1/depth 快照。第一筆要蓋到快照的 lastUpdateId（U ≤ lastUpdateId ≤ u），或是 pu 剛好接上。之後每一筆的 pu 必須等於上一筆的 u，否則整本訂單簿作廢並重抓。現貨那套 lastUpdateId+1 在 U 本位合約上會把正常的序號跳動誤判成缺口。</p>
      <h2>清算不完整</h2>
      <p id="liq-note"></p>
      <h2>成交量</h2>
      <p>有足跡的柱子分成主動買與主動賣。只有交易所 K 線的柱子是灰色總量，沒有方向。不要把灰色總量讀成主動單。數量單位是基礎資產：BTCUSDT 為 BTC，ETHUSDT 為 ETH。價格是 USDT。</p>
      <h2>操作</h2>
      <p>拖曳平移，雙指或滾輪縮放，雙擊圖面或按「重設畫面」回到最新並恢復價格範圍。這不會把 CVD 歸零。也可以按＋ − 縮放、左右方向鍵平移、F 切換跟隨。Shift＋滾輪只縮放價格。手機上圖面的手勢不會帶動整頁捲動，說明文字在圖的下方。</p>
    </article>
  </details>
  <footer>
    <p>資料源只使用幣安 U 本位公開介面：<code>https://fapi.binance.com</code> 與 <code>wss://fstream.binance.com</code>。不使用現貨 <code>stream.binance.com</code>，不需要 API 金鑰，也不會送出訂單。</p>
    <p>若所在地無法使用幣安，畫面會停在錯誤說明。這個頁面沒有代理。示範模式必須另外打開，而且全程標示為合成資料。</p>
  </footer>
`;

const note = document.querySelector<HTMLElement>("#liq-note");
if (note) note.textContent = liquidationNote();
const guide = document.querySelector<HTMLDetailsElement>("#guide");
if (guide && window.matchMedia("(max-width: 800px)").matches) guide.open = false;

const canvasQuery = document.querySelector<HTMLCanvasElement>("#chart");
const wrapQuery = document.querySelector<HTMLElement>("#chart-wrap");
const tipQuery = document.querySelector<HTMLElement>("#tip");
if (!canvasQuery || !wrapQuery || !tipQuery) throw new Error("圖表節點缺失");
const canvas: HTMLCanvasElement = canvasQuery;
const wrap: HTMLElement = wrapQuery;
const tip: HTMLElement = tipQuery;
const context = canvas.getContext("2d");
if (!context) throw new Error("無法建立 Canvas");
const ctx: CanvasRenderingContext2D = context;

const renderer = new ChartRenderer();
let layout = renderer.draw(ctx, 10, 10, 1, model());

function mark(): void {
  dirty = true;
}

const live = new LiveSession(store, mark);
const demo = new DemoSession(store, mark);

function defaultSpan(): number {
  const bars = window.innerWidth < 800 ? 14 : 32;
  return bars * timeframeMs(store.timeframe);
}

function model(): ChartModel {
  return {
    now: Date.now(),
    timeframe: store.timeframe,
    tickSize: store.tickSize,
    right: view.right,
    span: view.span,
    priceZoom: view.priceZoom,
    priceShift: view.priceShift,
    candles: store.candles,
    bars: store.footprint.bars(store.timeframe),
    cvd: store.footprint.cvdSeries(store.timeframe),
    heat: store.heatmap.columns,
    liquidations: store.liquidations,
    layers,
    lastPrice: store.lastPrice,
    lastAggressor: store.lastAggressor,
    sessionStartedAt: store.sessionStartedAt,
    mode: store.mode,
    hover,
  };
}

function resize(): void {
  const rect = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function draw(): void {
  resize();
  const rect = wrap.getBoundingClientRect();
  layout = renderer.draw(ctx, rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2), model());
}

function zoomTime(scale: number): void {
  const slot = timeframeMs(store.timeframe);
  const center = view.right - view.span / 2;
  view.span = clamp(view.span / scale, slot * 6, slot * 160);
  if (!view.follow) view.right = center + view.span / 2;
  mark();
}

function zoomPrice(scale: number): void {
  view.priceZoom = clamp(view.priceZoom / scale, 0.4, 8);
  mark();
}

function resetView(): void {
  view.span = defaultSpan();
  view.priceZoom = 1;
  view.priceShift = 0;
  view.follow = true;
  syncFollow();
  mark();
}

function syncFollow(): void {
  const button = document.querySelector<HTMLButtonElement>("#follow");
  if (button) button.setAttribute("aria-pressed", String(view.follow));
}

function syncMode(): void {
  document.querySelector<HTMLButtonElement>("#live")?.setAttribute("aria-pressed", String(store.mode === "live"));
  document.querySelector<HTMLButtonElement>("#demo")?.setAttribute("aria-pressed", String(store.mode === "demo"));
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-symbol]")) {
    button.setAttribute("aria-pressed", String(button.dataset.symbol === store.symbol));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tf]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tf === store.timeframe));
  }
}

function bannerText(): string {
  const warning = store.continuityWarning ? ` ${store.continuityWarning}` : "";
  if (store.mode === "demo") return `示範資料：合成成交、掛單與清算，不是幣安即時行情。${warning}`;
  if (store.sessionStartedAt === null) {
    return `尚未開始累積逐筆。若出現空心蠟燭，那只是交易所 K 線，沒有足跡與熱圖。${warning}`;
  }
  return `直的淡金線是這次連線的起點。CVD 從本頁第一筆成交累計，重設畫面不會歸零。左側空心蠟燭沒有逐筆。${warning}`;
}

function paintChrome(now: number): void {
  if (now - lastHud < 250 && !dirty) return;
  lastHud = now;
  const status = document.querySelector<HTMLElement>("#status");
  const statusText = document.querySelector<HTMLElement>("#status-text");
  const statusDetail = document.querySelector<HTMLElement>("#status-detail");
  const banner = document.querySelector<HTMLElement>("#banner");
  if (status) status.className = `status ${store.statusKind}`;
  if (statusText) statusText.textContent = store.statusText;
  if (statusDetail) statusDetail.textContent = store.detail;
  if (banner) banner.textContent = bannerText();
  const price = document.querySelector<HTMLElement>("#hud-price");
  const bbo = document.querySelector<HTMLElement>("#hud-bbo");
  const delta = document.querySelector<HTMLElement>("#hud-delta");
  const trades = document.querySelector<HTMLElement>("#hud-trades");
  const liq = document.querySelector<HTMLElement>("#hud-liq");
  const unit = document.querySelector<HTMLElement>("#hud-unit");
  if (price) {
    price.textContent = store.lastPrice === null ? "—" : formatPrice(store.lastPrice, store.tickSize);
    price.className = store.lastAggressor === "sell" ? "sell" : store.lastAggressor === "buy" ? "buy" : "";
  }
  if (bbo) {
    const bid = store.bestBid === null ? "—" : formatPrice(store.bestBid, store.tickSize);
    const ask = store.bestAsk === null ? "—" : formatPrice(store.bestAsk, store.tickSize);
    bbo.textContent = `${bid} / ${ask}`;
  }
  const current = store.footprint.bar(
    Math.floor(Date.now() / timeframeMs(store.timeframe)) * timeframeMs(store.timeframe),
    store.timeframe,
  );
  if (delta) {
    delta.textContent = current ? formatDelta(barDelta(current)) : "—";
    delta.className = !current ? "" : barDelta(current) >= 0 ? "buy" : "sell";
  }
  const cvdSeries = store.footprint.cvdSeries(store.timeframe);
  const cvdValue = document.querySelector<HTMLElement>("#hud-cvd");
  const cvdLabel = document.querySelector<HTMLElement>("#hud-cvd-label");
  const cvdNote = document.querySelector<HTMLElement>("#cvd-note");
  if (cvdValue) {
    cvdValue.textContent = cvdSeries.firstTradeTime === null ? "—" : formatDelta(cvdSeries.total);
    cvdValue.className = cvdSeries.total > 0 ? "buy" : cvdSeries.total < 0 ? "sell" : "";
  }
  if (cvdLabel) cvdLabel.textContent = `CVD（${BASE_ASSET[store.symbol]}）`;
  if (cvdNote) {
    const start = cvdSeries.firstTradeTime === null ? "還沒有成交" : formatClock(cvdSeries.firstTradeTime, true);
    const mode = store.mode === "demo" ? "示範" : "即時";
    const hole = cvdSeries.gaps.length
      ? `已標 ${cvdSeries.gaps.length} 段缺口：漏掉的成交沒有補上，累計也沒有歸零。`
      : "縮放、平移、重設畫面都不改起點。";
    cvdNote.textContent = `${mode} ${store.symbol} 的 CVD 從 ${start} 這筆收到的成交起算，單位是 ${BASE_ASSET[store.symbol]}。換幣或切換示範／即時才重新從零累計。${hole}`;
  }
  if (trades) trades.textContent = store.tradesSeen.toLocaleString("zh-Hant");
  if (liq) liq.textContent = String(store.liquidations.length);
  if (unit) unit.textContent = BASE_ASSET[store.symbol];
  syncMode();
}

function placeTip(): void {
  if (!hover) {
    tip.hidden = true;
    return;
  }
  const info = hoverInfo(model(), layout, hover.x, hover.y);
  if (!info) {
    tip.hidden = true;
    return;
  }
  const lines = [
    formatClock(info.time, true),
    `價格 <b>${formatPrice(info.price, store.tickSize)}</b> USDT`,
  ];
  if (info.bar) {
    lines.push(`主動買 <b class="buy">${formatQty(info.bar.buy)}</b> · 主動賣 <b class="sell">${formatQty(info.bar.sell)}</b>`);
    lines.push(`本根 Delta <b>${formatDelta(info.delta ?? barDelta(info.bar))}</b> ${BASE_ASSET[store.symbol]}`);
    if (info.cvd !== null) {
      lines.push(`CVD <b>${formatDelta(info.cvd)}</b> ${BASE_ASSET[store.symbol]}（自本輪第一筆，不是畫面左緣）`);
    }
    if (info.cvdGap) lines.push("這段有連線缺口，中間沒收到的成交沒有計入。");
    if (info.kind === "partial") lines.push("這根 K 在連線前就已開始，足跡只含連線後的逐筆。");
  } else if (info.candle && (info.kind === "history" || info.kind === "partial")) {
    lines.push(`交易所總量 <b>${formatQty(info.candle.volume)}</b> ${BASE_ASSET[store.symbol]}，沒有主動方向`);
  } else if (store.mode === "live") {
    lines.push("這個時間還沒有收到逐筆。");
  }
  if (info.bidQty > 0 || info.askQty > 0) {
    lines.push(`附近掛單 買 <b class="buy">${formatQty(info.bidQty)}</b> · 賣 <b class="sell">${formatQty(info.askQty)}</b>`);
  }
  if (info.liquidation) {
    const name = info.liquidation.side === "SELL" ? "多單強平" : "空單強平";
    lines.push(`${name} <b>${formatQty(info.liquidation.qty)}</b> ${BASE_ASSET[store.symbol]} @ ${formatPrice(info.liquidation.price, store.tickSize)}`);
    lines.push("只是該秒窗內被推送的最大一筆，不是全部強平。");
  }
  tip.innerHTML = lines.join("<br>");
  tip.hidden = false;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = hover.x + 16 + width > layout.width ? hover.x - width - 12 : hover.x + 16;
  const top = hover.y + 16 + height > layout.height ? Math.max(8, hover.y - height - 12) : hover.y + 16;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function frame(now: number): void {
  if (view.follow) {
    const next = Date.now() + view.span * 0.04;
    if (Math.abs(next - view.right) > 20) {
      view.right = next;
      dirty = true;
    }
  }
  paintChrome(now);
  if (dirty && now - lastDraw >= 32) {
    draw();
    if (hover) placeTip();
    dirty = false;
    lastDraw = now;
  }
  requestAnimationFrame(frame);
}

app.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const symbol = target.dataset.symbol as SymbolId | undefined;
  if (symbol) {
    store.symbol = symbol;
    resetView();
    if (store.mode === "demo") demo.start();
    else live.start(symbol);
    return;
  }
  const timeframe = target.dataset.tf as Timeframe | undefined;
  if (timeframe) {
    const previous = timeframeMs(store.timeframe);
    const next = timeframeMs(timeframe);
    view.span = clamp((view.span / previous) * next, next * 6, next * 160);
    if (store.mode === "live") live.setTimeframe(timeframe);
    else {
      store.timeframe = timeframe;
      mark();
    }
    syncMode();
    return;
  }
  const layer = target.dataset.layer as keyof ChartLayers | undefined;
  if (layer) {
    layers[layer] = !layers[layer];
    target.setAttribute("aria-pressed", String(layers[layer]));
    mark();
  }
});

document.querySelector("#zoom-in")?.addEventListener("click", () => zoomTime(1.2));
document.querySelector("#zoom-out")?.addEventListener("click", () => zoomTime(1 / 1.2));
document.querySelector("#reset")?.addEventListener("click", resetView);
document.querySelector("#follow")?.addEventListener("click", () => {
  view.follow = !view.follow;
  if (view.follow) view.right = Date.now() + view.span * 0.04;
  syncFollow();
  mark();
});
document.querySelector("#demo")?.addEventListener("click", () => {
  live.stop();
  demo.start();
  resetView();
  syncMode();
});
document.querySelector("#live")?.addEventListener("click", () => {
  demo.stop();
  resetView();
  live.start(store.symbol);
  syncMode();
});
document.querySelector("#retry")?.addEventListener("click", () => {
  demo.stop();
  resetView();
  live.start(store.symbol);
});

bindChartGestures(wrap, {
  onPan: (dx, dy) => {
    view.follow = false;
    syncFollow();
    view.right -= dx * (view.span / Math.max(layout.plot.w, 1));
    const pricePerPx = (layout.priceMax - layout.priceMin) / Math.max(layout.plot.h, 1);
    view.priceShift += dy * pricePerPx;
    hover = null;
    tip.hidden = true;
    mark();
  },
  onPinch: (scale) => {
    zoomTime(scale);
    zoomPrice(scale);
  },
  onWheel: (deltaY, shift) => {
    const scale = deltaY > 0 ? 0.9 : 1.12;
    if (shift) zoomPrice(scale);
    else zoomTime(scale);
  },
  onReset: resetView,
  onHover: (x, y) => {
    hover = { x, y };
    placeTip();
    mark();
  },
  onLeave: () => {
    hover = null;
    tip.hidden = true;
    mark();
  },
});

window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("input, textarea, summary")) return;
  if (event.key === "+" || event.key === "=") {
    if (event.shiftKey) zoomPrice(1.15);
    else zoomTime(1.15);
  } else if (event.key === "-" || event.key === "_") {
    if (event.shiftKey) zoomPrice(1 / 1.15);
    else zoomTime(1 / 1.15);
  }
  else if (event.key === "0") resetView();
  else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    view.follow = false;
    syncFollow();
    view.right += (event.key === "ArrowLeft" ? -2 : 2) * timeframeMs(store.timeframe);
    mark();
  } else if (event.key === "f" || event.key === "F") {
    view.follow = !view.follow;
    syncFollow();
    mark();
  } else return;
  event.preventDefault();
});

window.addEventListener("resize", mark);
view.span = defaultSpan();
live.start(store.symbol);
requestAnimationFrame(frame);
