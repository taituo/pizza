import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, store } from '../api';
import { ProposalCard } from '../components/ProposalCard';
import type { ChatMessage, Conversation, Menu, Proposal } from '../types';

const local = store('local');
const GREETING: ChatMessage = {
  role: 'agent',
  content: 'Hi! Tell me what you would like, for example “two large pepperoni without onion, delivery”.',
};

type Session = { id: string; token: string };

function saved(): Session | null {
  try {
    return JSON.parse(local.get('conversation') ?? 'null') as Session | null;
  } catch {
    return null;
  }
}

/** Ordering by conversation. The same order API and workflow as the shop; only the front door differs. */
export function Chat() {
  const [session, setSession] = useState<Session | null>(saved);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [orders, setOrders] = useState<Conversation['orders']>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Menu>('/api/menu').then(setMenu).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!session) return;
    api<Conversation>(`/api/conversations/${session.id}`, { conversationToken: session.token })
      .then((c) => {
        setMessages(c.messages);
        setProposal(c.proposal);
        setOrders(c.orders);
      })
      .catch((e: ApiError) => {
        // A conversation the server no longer knows: start a fresh one on the next message.
        if (e.status === 404) reset();
        else setError(e.message);
      });
    // Loaded once per conversation; later turns update the state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, waiting, proposal]);

  const reset = useCallback(() => {
    local.set('conversation', null);
    setSession(null);
    setMessages([]);
    setProposal(null);
    setOrders([]);
    setError(null);
  }, []);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content || waiting) return;
    setText('');
    setError(null);
    setWaiting(true);
    setMessages((m) => [...m, { role: 'user', content }]);
    try {
      let s = session;
      if (!s) {
        const created = await api<{ id: string; accessToken: string }>('/api/conversations', { body: {} });
        s = { id: created.id, token: created.accessToken };
        local.set('conversation', JSON.stringify(s));
        setSession(s);
      }
      const turn = await api<{ reply: string; proposal: Proposal | null }>(`/api/conversations/${s.id}/messages`, {
        conversationToken: s.token,
        body: { text: content },
      });
      setMessages((m) => [...m, { role: 'agent', content: turn.reply }]);
      setProposal(turn.proposal);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWaiting(false);
    }
  };

  const shown = messages.length ? messages : [GREETING];

  return (
    <main className="page narrow chat">
      <header className="chat-head">
        <div>
          <h1>Order by chat</h1>
          <p className="muted">
            Say what you want; you confirm and pay on a card, like any other order. Prefer to browse? <Link to="/">See the menu</Link>.
          </p>
        </div>
        {messages.length > 0 && (
          <button type="button" className="link" onClick={reset}>
            Start over
          </button>
        )}
      </header>

      <ol className="messages" aria-live="polite" aria-label="Conversation">
        {shown.map((m, i) => (
          <li key={i} className={`bubble ${m.role}`}>
            <span className="visually-hidden">{m.role === 'user' ? 'You: ' : 'Assistant: '}</span>
            {m.content}
          </li>
        ))}
        {waiting && (
          <li className="bubble agent typing" aria-label="The assistant is writing">
            <span />
            <span />
            <span />
          </li>
        )}
      </ol>

      {proposal && proposal.status === 'open' && menu && (
        <ProposalCard key={proposal.id} proposal={proposal} restaurant={menu.restaurant} deliveryRadiusKm={menu.deliveryRadiusKm} />
      )}
      {orders.length > 0 && (
        <p className="small">
          <Link to={`/order/${orders[0]!.id}?token=${encodeURIComponent(orders[0]!.accessToken)}`}>Track your order from this chat →</Link>
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div ref={end} />

      <form className="composer" onSubmit={send}>
        <label className="visually-hidden" htmlFor="chat-input">
          Your message
        </label>
        <input
          id="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. a margherita and a cola for pickup"
          maxLength={2000}
          autoComplete="off"
          autoFocus
        />
        <button className="btn primary" disabled={waiting || text.trim() === ''}>
          Send
        </button>
      </form>
    </main>
  );
}
