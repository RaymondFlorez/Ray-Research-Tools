import type { PatchOp } from '@geoglobe/scene-schema';
import { API_URL } from './api';

const WS_URL = `${API_URL.replace(/^http/, 'ws')}/ws/agent`;

export interface AgentEvent {
  type: 'text' | 'tool_use' | 'patch' | 'tool_result' | 'done' | 'error';
  data: {
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    ops?: PatchOp[];
    result?: string;
    message?: string;
  };
}

/**
 * Open a WebSocket to the agent, send one query, and stream events to `onEvent` until
 * the agent finishes (`done`), errors, or the socket closes. Resolves when complete.
 */
export function runAgentQuery(query: string, onEvent: (e: AgentEvent) => void): Promise<void> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      onEvent({ type: 'error', data: { message: 'could not open agent connection' } });
      resolve();
      return;
    }

    const finish = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    };

    ws.onopen = () => ws.send(JSON.stringify({ query }));
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data as string) as AgentEvent;
      onEvent(event);
      if (event.type === 'done' || event.type === 'error') finish();
    };
    ws.onerror = () => {
      onEvent({
        type: 'error',
        data: { message: 'agent connection failed (is the backend running?)' },
      });
      finish();
    };
    ws.onclose = () => resolve();
  });
}
