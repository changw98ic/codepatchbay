export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface PipelineUpdateMessage extends WSMessage {
  type: 'pipeline:update';
  project: string;
  state: {
    status: string;
    phase?: string;
    error?: string;
    jobId?: string;
  };
}

export interface LogAppendMessage extends WSMessage {
  type: 'log:append';
  level: 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  timestamp: string;
}

export interface FileCreatedMessage extends WSMessage {
  type: 'file:created';
  project: string;
  path: string;
  section: 'inbox' | 'outputs';
}

export interface FileDeletedMessage extends WSMessage {
  type: 'file:deleted';
  project: string;
  path: string;
  section: 'inbox' | 'outputs';
}

export interface FileModifiedMessage extends WSMessage {
  type: 'file:modified';
  project: string;
  path: string;
}

export interface JobUpdateMessage extends WSMessage {
  type: 'job:update';
  jobId: string;
  project: string;
  status: string;
  phase?: string;
  error?: string;
}

export interface ReviewUpdateMessage extends WSMessage {
  type: 'review:update';
  sessionId: string;
  status: string;
}

export type WSMessageMap = {
  'pipeline:update': PipelineUpdateMessage;
  'log:append': LogAppendMessage;
  'file:created': FileCreatedMessage;
  'file:deleted': FileDeletedMessage;
  'file:modified': FileModifiedMessage;
  'job:update': JobUpdateMessage;
  'review:update': ReviewUpdateMessage;
};
