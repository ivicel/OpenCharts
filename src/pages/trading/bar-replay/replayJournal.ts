import { create } from "zustand";
import type { ReplaySessionRecord } from "../../../services/demo/engine.ts";

/**
 * Practice-session journal.
 *
 * When a Bar Replay session ends its trades are *kept as a record* rather than
 * discarded (and rather than merged into the live account, whose marking would
 * invent P&L out of a historical entry price). Records survive a reload, so a
 * replay run remains reviewable after the tab is closed.
 */

const STORAGE_KEY = "oc_replay_sessions";
const MAX_RECORDS = 50;

function readStored(): ReplaySessionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReplaySessionRecord[]) : [];
  } catch {
    return [];
  }
}

function writeStored(records: ReplaySessionRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Quota or privacy mode — the in-memory list still works for this session.
  }
}

interface ReplayJournalStore {
  records: ReplaySessionRecord[];
  add: (record: ReplaySessionRecord) => void;
  clear: () => void;
}

export const useReplayJournalStore = create<ReplayJournalStore>((set, get) => ({
  records: readStored(),

  add: (record) => {
    const next = [record, ...get().records].slice(0, MAX_RECORDS);
    writeStored(next);
    set({ records: next });
  },

  clear: () => {
    writeStored([]);
    set({ records: [] });
  },
}));
