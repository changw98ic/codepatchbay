import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { WSMessage } from '@/types/websocket';

interface WebSocketStore {
  connected: boolean;
  ws: WebSocket | null;
  connect: () => void;
  disconnect: () => void;
  send: (msg: unknown) => void;
  subscribe: (type: string, fn: (msg: WSMessage) => void) => () => void;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
}

const MAX_BACKOFF = 30000;
const BASE_DELAY = 1000;

export const useWebSocketStore = create<WebSocketStore>()(
  subscribeWithSelector((set, get) => {
    const listeners = new Map<string, Set<(msg: WSMessage) => void>>();

    function scheduleReconnect() {
      const state = get();
      const delay = Math.min(BASE_DELAY * Math.pow(2, state.attempt), MAX_BACKOFF);
      const timer = setTimeout(() => {
        set({ reconnectTimer: null });
        get().connect();
      }, delay);
      set({ reconnectTimer: timer, attempt: state.attempt + 1 });
    }

    return {
      connected: false,
      ws: null,
      reconnectTimer: null,
      attempt: 0,

      connect: () => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/ws`);

        ws.onopen = () => {
          set({ connected: true, ws, attempt: 0 });
        };

        ws.onclose = () => {
          set({ connected: false, ws: null });
          scheduleReconnect();
        };

        ws.onerror = () => ws.close();

        ws.onmessage = (raw) => {
          try {
            const msg: WSMessage = JSON.parse(raw.data);
            if (msg.type === 'pong') return;
            listeners.get(msg.type)?.forEach((fn) => fn(msg));
            listeners.get('*')?.forEach((fn) => fn(msg));
          } catch {
            // ignore malformed messages
          }
        };

        set({ ws });
      },

      disconnect: () => {
        const { reconnectTimer } = get();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        get().ws?.close();
        set({ ws: null, connected: false, reconnectTimer: null, attempt: 0 });
      },

      send: (msg) => {
        const { ws } = get();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      },

      subscribe: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
        return () => {
          listeners.get(type)?.delete(fn);
        };
      },
    };
  }),
);
