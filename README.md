# 合約訂單流

Browser-only order-flow viewer for Binance USD-M perpetual futures. The page speaks Traditional Chinese. It draws a footprint (aggressive buy and sell volume at each price), a live depth heatmap, observed liquidation markers, and a volume panel for BTCUSDT and ETHUSDT on 1m, 5m, and 15m.

There is no backend, account, API key, or order placement. The browser talks only to Binance public market data. Nothing here routes traffic through a proxy.

## Run locally

```bash
npm ci
npm test
npm run dev
```

Open the printed local URL. `npm run build` writes a static site to `dist/` with the GitHub Pages base path `/crypto-orderflow/`. `npm run preview` serves that build.

The default view tries the live feed. **示範** switches to a clearly labeled synthetic tape. **即時** or **再試一次** goes back to Binance.

## What the chart is

- **Footprint.** Each cell is aggressive buy and sell volume at that price inside the bar. The left column is aggressive sell (trade into the bid). The right column is aggressive buy (trade into the ask). Binance `aggTrade.m === true` means the buyer is the maker, so the print is an aggressive sell. Delta for a bar is aggressive buy minus aggressive sell.
- **CVD.** The line is the running sum of those deltas from the first trade this page actually received in the current symbol and mode. It is not open interest. Pan, zoom, and 重設畫面 do not move that zero. Changing symbol or switching between live and demo starts a new sum. A disconnect is marked as a gap: missing trades are not filled in and the sum is not reset. Dropped old bars stay inside the sum as a prefix, so the line does not jump back to zero.
- **Candles.** `GET /fapi/v1/klines` is exchange OHLC plus total volume only. Those bars are hollow and gray. They are not footprint history and they are not depth history.
- **Heatmap.** After the local book is synced, the page stores about one snapshot per second for roughly seven minutes, keeping the levels nearest the mid. There is no public historical depth feed, so the heatmap cannot be warmed up from the past.
- **Liquidations.** `@forceOrder` is incomplete. Since 14 April 2026 Binance documents it as the **largest** liquidation in each 1000ms window per symbol, not every liquidation and not merely the latest. Quantity is the base asset (BTC or ETH). Price is USDT. `SELL` liquidates a long; `BUY` liquidates a short.
- **Volume.** Footprint bars are split into aggressive buy and sell. Exchange-only bars stay a single gray total.

Bars follow Unix epoch boundaries, the same alignment Binance uses. Axis labels use the computer's local time zone.

## Endpoints

| Use | URL |
| --- | --- |
| Exchange info, klines, depth snapshot | `https://fapi.binance.com` |
| `aggTrade`, `depth@100ms`, `forceOrder` | `wss://fstream.binance.com/stream` |

Spot hosts (`api.binance.com`, `stream.binance.com`) are not used.

USD-M depth sync follows the futures rules, not the spot rules:

1. Subscribe and buffer first.
2. `GET /fapi/v1/depth?limit=1000`.
3. Drop events with `u < lastUpdateId`.
4. The first applied event must satisfy `U <= lastUpdateId` and `u >= lastUpdateId`, or continue directly when `pu === lastUpdateId`.
5. Every later event must have `pu === previous u`. A later event whose `U` merely overlaps is not enough. Spot's `lastUpdateId + 1` chain is not used, because futures update ids jump while `pu` stays continuous.
6. Quantities are absolute. Zero deletes a level. Deleting a missing level is normal.
7. Events with `u` at or before the applied id are duplicates or stale and are ignored. A reconnect clears the book so old ids cannot be applied to the new socket.

If Binance returns HTTP 451, or a restricted-location body the browser is allowed to read, the page says the network cannot use Binance and stops. On many restricted networks the 451 response has no CORS header, so the browser only reports a failed fetch. The banner explains that case too. The page does not invent a live tape and it does not offer a proxy.

## Tests

```bash
npm test
```

Covers maker-side buy/sell, footprint bins and delta, 1m/5m/15m boundaries, the separation between klines and footprint, and futures depth init, absolute updates, deletion, duplicates, out-of-order events, gaps, buffer replay, and reconnect.

## GitHub Pages

Production assets use base `/crypto-orderflow/`, which matches this repository name. Workflows:

- `.github/workflows/ci.yml` runs tests and the production build on pull requests and on `main`. It only requests `contents: read`.
- `.github/workflows/pages.yml` runs on pushes to `main`, uploads `dist`, and deploys with the GitHub Pages action. Permissions are `contents: read`, `pages: write`, and `id-token: write`.

This branch does not enable Pages by itself and it is not merged. Remaining publication steps are in the pull request.

## Dependencies

Runtime dependencies: none. Dev dependencies are Vite (MIT), TypeScript (Apache-2.0), and Vitest (MIT). No proprietary chart assets are included.

## License

MIT. See `LICENSE`.
