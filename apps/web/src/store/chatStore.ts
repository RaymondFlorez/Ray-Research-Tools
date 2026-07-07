import { create } from 'zustand';
import { runAgentQuery } from '../data/agent';
import { resolveAgentOps } from '../data/agentPatch';
import { useSceneStore } from './sceneStore';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface ChatStore {
  messages: ChatMessage[];
  busy: boolean;
  send: (query: string) => Promise<void>;
}

/**
 * Chat with the map agent. Streams the agent's text into the transcript and applies its
 * scene patches to the Scene State store through the same validated `applyPatch` path
 * the UI uses — so an NL query and a manual panel edit are indistinguishable downstream.
 */
export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  busy: false,

  send: async (query: string) => {
    if (get().busy || !query.trim()) return;
    set((s) => ({ messages: [...s.messages, { role: 'user', text: query }], busy: true }));

    // A single assistant message we append streamed text to.
    let assistant: ChatMessage = { role: 'assistant', text: '' };
    set((s) => ({ messages: [...s.messages, assistant] }));
    const updateAssistant = (text: string) => {
      assistant = { ...assistant, text };
      set((s) => {
        const next = s.messages.slice();
        next[next.length - 1] = assistant;
        return { messages: next };
      });
    };

    await runAgentQuery(query, (event) => {
      if (event.type === 'text' && event.data.text) {
        updateAssistant(assistant.text + event.data.text);
      } else if (event.type === 'tool_use' && event.data.name) {
        updateAssistant(`${assistant.text}\n· ${event.data.name}`.trimStart());
      } else if (event.type === 'patch' && event.data.ops) {
        try {
          const scene = useSceneStore.getState().scene;
          useSceneStore.getState().applyPatch(resolveAgentOps(scene, event.data.ops));
        } catch (err) {
          console.error('agent patch rejected', err);
        }
      } else if (event.type === 'error' && event.data.message) {
        set((s) => ({ messages: [...s.messages, { role: 'system', text: event.data.message! }] }));
      }
    });

    set({ busy: false });
  },
}));
