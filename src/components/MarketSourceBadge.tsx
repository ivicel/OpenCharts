import { useSyncExternalStore } from "react";
import { Database, WifiOff } from "lucide-react";
import {
  getMarketFeedMode,
  subscribeMarketFeedMode,
} from "@/services/market-source/feed-status";
import { getMarketSourceStatus, subscribeMarketSource } from "@/services/market-source";

/**
 * Warns when the terminal is not on live exchange data.
 *
 * Rendered only in the two abnormal cases — offline start-up (bundled history
 * plus a replayed tick stream) and a mid-session feed outage where the last
 * known prices are held — so the normal path costs nothing visually.
 */
export function MarketSourceBadge() {
  const source = useSyncExternalStore(subscribeMarketSource, getMarketSourceStatus);
  const mode = useSyncExternalStore(subscribeMarketFeedMode, getMarketFeedMode);

  const offline = mode === "bundled" || source.degraded;
  const stale = mode === "stale";
  if (!offline && !stale) return null;

  const Icon = offline ? Database : WifiOff;
  const message = offline
    ? "Offline data — the exchange is unreachable. Charts and prices are served from the bundled dataset."
    : "Live feed interrupted — holding the last known prices while the exchange is retried.";

  return (
    <div
      role="status"
      aria-live="polite"
      title={source.lastError ?? undefined}
      className="flex items-center justify-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-medium"
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
