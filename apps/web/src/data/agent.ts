import type { PatchOp } from '@geoglobe/scene-schema';
import { API_URL } from './api';
import { getAuthToken } from './auth';

/** Agent socket URL; resolves a relative API_URL (e.g. `/api`) against the page. */
function agentSocketUrl(): string {
  const url = new URL(`${API_URL}/ws/agent`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // Browsers can't set headers on a WebSocket handshake, so the token rides as a param.
  const token = getAuthToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export interface AgentEvent {
  type: 'text' | 'tool_use' | 'patch' | 'tool_result' | 'usage' | 'done' | 'error';
  data: {
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    ops?: PatchOp[];
    result?: string;
    message?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
    trace_id?: string;
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
      ws = new WebSocket(agentSocketUrl());
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
