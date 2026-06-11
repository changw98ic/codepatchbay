export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface LogAppendMessage extends WSMessage {
  type: 'log:append';
  level: 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  timestamp: string;
}
