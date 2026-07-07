import { useState } from 'react';
import { useChatStore } from '../store/chatStore';

/**
 * Natural-language chat with the map agent. Sending a query streams the agent's reply
 * and applies its scene mutations to the globe (ARCHITECTURE §6). Requires the backend
 * agent WebSocket (an Anthropic API key on the server); offline, it shows a notice.
 */
export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const busy = useChatStore((s) => s.busy);
  const send = useChatStore((s) => s.send);
  const [input, setInput] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input;
    setInput('');
    void send(q);
  };

  return (
    <section className="panel chat" data-testid="chat">
      <h2>Ask the globe</h2>
      <div className="chat-log">
        {messages.length === 0 && (
          <p className="chat-hint">
            e.g. “show me earthquakes over magnitude 5 in the Pacific and fly there”
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'Thinking…' : 'Ask about the data…'}
          disabled={busy}
          data-testid="chat-input"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
