import type { StatusKind } from "../store";

/**
 * How long a silent channel stays "fresh" before the banner says it stalled.
 * These are connection checks for BTCUSDT and ETHUSDT, not entry or exit rules.
 */
export const TRADE_FRESH_MS = 8_000;
export const DEPTH_FRESH_MS = 3_000;

export type ChannelFreshness = "connecting" | "waiting" | "live" | "stale" | "closed";

export function channelFreshness(
  open: boolean,
  lastAt: number | null,
  now: number,
  freshMs: number,
  openedAt: number | null = null,
): ChannelFreshness {
  if (!open && lastAt === null) return "connecting";
  if (!open) return "closed";
  const mark = lastAt ?? openedAt;
  if (mark === null) return "waiting";
  if (now - mark > freshMs) return "stale";
  return lastAt === null ? "waiting" : "live";
}

export interface FeedSnapshot {
  now: number;
  marketOpen: boolean;
  publicOpen: boolean;
  marketOpenedAt?: number | null;
  publicOpenedAt?: number | null;
  bookSynced: boolean;
  lastTradeAt: number | null;
  lastDepthAt: number | null;
  tradeCount: number;
  liquidationCount: number;
}

export interface FeedStatus {
  kind: StatusKind;
  title: string;
  detail: string;
  trades: ChannelFreshness;
  depth: ChannelFreshness;
}

export function describeFeed(snapshot: FeedSnapshot): FeedStatus {
  const trades = channelFreshness(
    snapshot.marketOpen,
    snapshot.lastTradeAt,
    snapshot.now,
    TRADE_FRESH_MS,
    snapshot.marketOpenedAt ?? null,
  );
  const depth = channelFreshness(
    snapshot.publicOpen,
    snapshot.lastDepthAt,
    snapshot.now,
    DEPTH_FRESH_MS,
    snapshot.publicOpenedAt ?? null,
  );
  const liquidationNote =
    snapshot.liquidationCount === 0
      ? "強平 0 筆不代表斷線，這條流常常沒有訊息。"
      : `已收到 ${snapshot.liquidationCount} 筆不完整的強平快照。`;

  if (trades === "live" && depth === "live") {
    return {
      kind: "ok",
      title: "即時",
      detail: `逐筆與深度增量都在 ${TRADE_FRESH_MS / 1000} 秒內有更新。最新價來自 aggTrade。買一賣一來自訂單簿，不是成交價。${liquidationNote}`,
      trades,
      depth,
    };
  }

  if (trades === "live" && depth !== "live") {
    const depthText =
      snapshot.bookSynced && snapshot.lastDepthAt === null
        ? "買一賣一仍是快照，深度增量還沒到。"
        : "深度增量目前不新鮮。";
    return {
      kind: "warn",
      title: "部分可用",
      detail: `逐筆有在更新，所以最新價、Delta、CVD 可用。${depthText}${liquidationNote}`,
      trades,
      depth,
    };
  }

  if (trades !== "live" && (depth === "live" || snapshot.bookSynced)) {
    const bookText = depth === "live" ? "深度增量有在更新。" : "目前的買一賣一只是訂單簿快照，還不能當成持續的深度。";
    const tradeText =
      trades === "waiting" || trades === "connecting"
        ? "aggTrade 還沒有成交進來，所以最新價、Delta、CVD 仍是空的。"
        : `已經超過 ${TRADE_FRESH_MS / 1000} 秒沒有新的 aggTrade，成交通道視為不新鮮。`;
    return {
      kind: "warn",
      title: "部分可用",
      detail: `${bookText}${tradeText}掛單不能填成逐筆。${liquidationNote}`,
      trades,
      depth,
    };
  }

  if (!snapshot.marketOpen && !snapshot.publicOpen) {
    return {
      kind: "warn",
      title: "連線中斷",
      detail: "逐筆與深度的 WebSocket 都沒有開著。不會用模擬成交補上。",
      trades,
      depth,
    };
  }

  return {
    kind: "loading",
    title: "等待行情",
    detail: "通道已開始連線。在逐筆與深度增量都到齊之前，不會顯示完整的即時。",
    trades,
    depth,
  };
}

/** Reconnect only a socket that is still open but has gone stale. Waiting is not a failure yet. */
export function shouldReconnectSilentSocket(open: boolean, freshness: ChannelFreshness): boolean {
  return open && freshness === "stale";
}
