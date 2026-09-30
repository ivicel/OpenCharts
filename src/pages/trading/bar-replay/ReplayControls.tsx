import { useState } from "react";
import { Pause, Play, RotateCcw, SkipBack, SkipForward, X, Magnet, History } from "lucide-react";
import { cn } from "../../../lib/utils.ts";
import { useTradingStore } from "../../../services/store.tsx";
import { useReplayJournalStore } from "./replayJournal.ts";
import { REPLAY_SPEEDS, formatReplaySpeed, useBarReplayStore } from "./replayStore.ts";

/**
 * Transport bar for a Bar Replay session — the TradingView-style strip that
 * appears under the chart: step back/forward, play/pause, speed, re-pick the
 * starting bar, follow toggle and exit. Plus the practice-account badge and the
 * archive of finished sessions.
 */

function formatCursorTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatMoney(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Archive of finished practice sessions ("kept as a paper record"). */
function ReplayRecordsDialog({ onClose }: { onClose: () => void }) {
  const records = useReplayJournalStore((s) => s.records);
  const clear = useReplayJournalStore((s) => s.clear);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg max-h-[70vh] overflow-auto rounded-lg border border-border bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">Saved replay sessions</span>
          <div className="flex items-center gap-2">
            {records.length > 0 && (
              <button
                onClick={clear}
                className="text-[10px] text-muted-foreground hover:text-destructive"
              >
                Clear
              </button>
            )}
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {records.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-muted-foreground">
            No sessions yet. Trades placed during a bar replay are kept here when you exit.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {records.map((record) => (
              <li key={record.id} className="flex items-center justify-between px-3 py-2 text-[11px]">
                <div>
                  <div className="text-foreground">
                    {new Date(record.startedAt).toLocaleString("en-GB", { hour12: false })}
                  </div>
                  <div className="text-muted-foreground">
                    {record.tradeCount} trade{record.tradeCount === 1 ? "" : "s"} · ended{" "}
                    {formatMoney(record.endingBalance)}
                  </div>
                </div>
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    record.realizedPnl >= 0 ? "text-success" : "text-destructive",
                  )}
                >
                  {record.realizedPnl >= 0 ? "+" : ""}
                  {formatMoney(record.realizedPnl)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ReplayControls() {
  const status = useBarReplayStore((s) => s.status);
  const bars = useBarReplayStore((s) => s.bars);
  const cursorIndex = useBarReplayStore((s) => s.cursorIndex);
  const speed = useBarReplayStore((s) => s.speed);
  const follow = useBarReplayStore((s) => s.follow);
  const error = useBarReplayStore((s) => s.error);
  const recordCount = useReplayJournalStore((s) => s.records.length);
  const account = useTradingStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const [showRecords, setShowRecords] = useState(false);

  if (status === "off") return null;

  const cursor = cursorIndex >= 0 ? bars[cursorIndex] : undefined;
  const atStart = cursorIndex <= 0;
  const atEnd = bars.length > 0 && cursorIndex >= bars.length - 1;
  const picking = status === "picking";
  const playing = status === "playing";

  return (
    <div className="h-9 px-2 flex items-center gap-2 bg-card border-t border-border shrink-0 select-none overflow-x-auto">
      <span className="text-orange-500 text-[10px] font-bold tracking-wider uppercase shrink-0">
        Replay
      </span>

      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={() => {
            useBarReplayStore.getState().pause();
            useBarReplayStore.getState().stepBy(-1);
          }}
          disabled={picking || atStart}
          title="Step back one bar (Shift+←)"
          className="p-1 rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30 disabled:cursor-default"
        >
          <SkipBack className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => {
            const store = useBarReplayStore.getState();
            if (store.status === "playing") store.pause();
            else store.play();
          }}
          disabled={picking || bars.length === 0}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          className="p-1 rounded text-orange-500 hover:bg-orange-500/20 disabled:opacity-30 disabled:cursor-default"
        >
          {playing ? (
            <Pause className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
        </button>
        <button
          onClick={() => {
            useBarReplayStore.getState().pause();
            useBarReplayStore.getState().stepBy(1);
          }}
          disabled={picking || atEnd}
          title="Step forward one bar (Shift+→)"
          className="p-1 rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30 disabled:cursor-default"
        >
          <SkipForward className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        {REPLAY_SPEEDS.map((option) => (
          <button
            key={formatReplaySpeed(option)}
            onClick={() => useBarReplayStore.getState().setSpeed(option)}
            disabled={picking}
            className={cn(
              "px-1.5 py-0.5 rounded text-[10px] font-medium transition-all",
              speed === option
                ? "bg-orange-500 text-white"
                : "text-muted-foreground hover:bg-orange-500/20 hover:text-orange-500 disabled:opacity-40 disabled:cursor-default",
            )}
          >
            {formatReplaySpeed(option)}
          </button>
        ))}
      </div>

      <div className="h-4 border-l border-border shrink-0" />

      <button
        onClick={() => useBarReplayStore.getState().resetStart()}
        title="Pick a different starting bar"
        className={cn(
          "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0",
          picking
            ? "bg-orange-500/20 text-orange-500"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        )}
      >
        <RotateCcw className="h-3 w-3" />
        Start point
      </button>

      <button
        onClick={() => useBarReplayStore.getState().setFollow(!follow)}
        title={follow ? "Following the cursor — click to keep the view fixed" : "Follow the cursor"}
        className={cn(
          "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0",
          follow
            ? "bg-orange-500/15 text-orange-500"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        )}
      >
        <Magnet className="h-3 w-3" />
        Follow
      </button>

      <span className="text-[11px] text-muted-foreground truncate">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : picking ? (
          bars.length === 0 ? (
            "Loading history…"
          ) : (
            "Click a bar on the chart to set the starting point"
          )
        ) : cursor ? (
          <>
            <span
              data-testid="replay-cursor-time"
              className="font-mono tabular-nums text-foreground"
            >
              {formatCursorTime(cursor.time)}
            </span>
            <span data-testid="replay-progress" className="ml-2 tabular-nums">
              {`${cursorIndex + 1} / ${bars.length}`}
            </span>
          </>
        ) : null}
      </span>

      <div className="flex-1" />

      {/* Practice-account badge: orders placed now fill, mark and stop out at
          replay prices, in a session that cannot touch the live account. */}
      <span
        className="hidden md:flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-500 text-[10px] font-medium shrink-0"
        title="Trades placed during replay run in a practice account and are saved when you exit"
      >
        Practice
        {account && (
          <span className="font-mono tabular-nums text-foreground">
            {formatMoney(account.equity ?? account.balance)}
          </span>
        )}
      </span>

      <button
        onClick={() => setShowRecords(true)}
        title="Saved replay sessions"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground shrink-0"
      >
        <History className="h-3 w-3" />
        Records{recordCount > 0 ? ` (${recordCount})` : ""}
      </button>

      <button
        onClick={() => useBarReplayStore.getState().exit()}
        title="Exit replay"
        className="p-1 rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      {showRecords && <ReplayRecordsDialog onClose={() => setShowRecords(false)} />}
    </div>
  );
}
