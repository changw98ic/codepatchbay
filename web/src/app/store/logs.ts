import { create } from 'zustand';
import type { LogAppendMessage } from '@/types/websocket';

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  timestamp: string;
}

interface LogsStore {
  entries: LogEntry[];
  levelFilter: 'all' | 'info' | 'warn' | 'error';
  autoScroll: boolean;
  maxEntries: number;
  append: (entry: LogAppendMessage) => void;
  clear: () => void;
  setLevelFilter: (level: LogsStore['levelFilter']) => void;
  setAutoScroll: (auto: boolean) => void;
  filtered: () => LogEntry[];
}

export const useLogsStore = create<LogsStore>((set, get) => ({
  entries: [],
  levelFilter: 'all',
  autoScroll: true,
  maxEntries: 500,

  append: (msg) => {
    set((state) => {
      const entries = [
        ...state.entries,
        {
          level: msg.level,
          message: msg.message,
          source: msg.source,
          timestamp: msg.timestamp,
        },
      ].slice(-state.maxEntries);
      return { entries };
    });
  },

  clear: () => set({ entries: [] }),
  setLevelFilter: (levelFilter) => set({ levelFilter }),
  setAutoScroll: (autoScroll) => set({ autoScroll }),

  filtered: () => {
    const { entries, levelFilter } = get();
    if (levelFilter === 'all') return entries;
    return entries.filter((e) => e.level === levelFilter);
  },
}));
