import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { AGENTS, AGENT_ORDER, Avatar, Bubble } from './Bubble.js';
import { Composer, type ComposerHandle } from './Composer.js';
import { useConversation, type ShownMessage } from './useConversation.js';

/** Keeps a scroll container pinned to the bottom only while the reader is already there. */
function useStickToBottom<T extends HTMLElement>(
  dep: unknown,
): { ref: RefObject<T | null>; atBottom: boolean; toBottom: (smooth?: boolean) => void } {
  const ref = useRef<T | null>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
      pinned.current = near;
      setAtBottom(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  const toBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  return { ref, atBottom, toBottom };
}

const authorKey = (m: ShownMessage) => (m.author.kind === 'user' ? 'user' : m.author.agentId);

function Header() {
  return (
    <header className="header">
      <div className="header-inner">
        <span className="mark" aria-hidden="true" />
        <div className="title">
          <h1>Lumen team</h1>
          <p>{AGENT_ORDER.map((id) => AGENTS[id].name).join(', ')} and you</p>
        </div>
        <ul className="members" aria-label="Members">
          {AGENT_ORDER.map((id) => (
            <li key={id} title={`${AGENTS[id].name} · ${AGENTS[id].role}`}>
              <Avatar agentId={id} />
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-avatars" aria-hidden="true">
        {AGENT_ORDER.map((id) => (
          <Avatar key={id} agentId={id} size="lg" />
        ))}
      </div>
      <h2>Say hello to the team</h2>
      <p>
        Ask anything about Lumen. Mention someone by name to bring them in, or ask everyone at once.
      </p>
      <ul className="welcome-people">
        {AGENT_ORDER.map((id) => (
          <li key={id} data-agent={id}>
            <span className="name">{AGENTS[id].name}</span>
            <span className="role">{AGENTS[id].role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function App({ conversationId }: { conversationId: string }) {
  const { messages, displayed, send, retry, stop, canStop, loaded } = useConversation(conversationId);
  const composer = useRef<ComposerHandle>(null);
  const { ref: scroller, atBottom, toBottom } = useStickToBottom<HTMLDivElement>(messages);

  // Esc stops everyone, unless focus is somewhere else that may want Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !canStop) return;
      const el = document.activeElement;
      const free = !el || el === document.body || el.closest('.composer') !== null;
      if (!free) return;
      e.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canStop, stop]);

  const onSend = useCallback(
    (text: string, typingStartedAt: number | null) => {
      send(text, typingStartedAt);
      toBottom();
    },
    [send, toBottom],
  );

  return (
    <div className="app">
      <Header />
      <main className="scroller" ref={scroller}>
        <div className="thread" role="log" aria-live="polite" aria-relevant="additions">
          {loaded && messages.length === 0 && <Welcome />}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const next = messages[i + 1];
            const who = authorKey(m);
            return (
              <Bubble
                key={m.key}
                agentId={m.author.kind === 'agent' ? m.author.agentId : null}
                text={displayed(m)}
                first={!prev || authorKey(prev) !== who}
                last={!next || authorKey(next) !== who}
                failed={m.failed}
                anchor={m.pending ? undefined : m.anchorSeq}
                onRetry={m.failed ? () => retry(m.key) : undefined}
              />
            );
          })}
        </div>
      </main>
      <div className="dock">
        {!atBottom && (
          <button type="button" className="jump" onClick={() => toBottom(true)} aria-label="Jump to latest">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M12 5v14M5.5 12.5 12 19l6.5-6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <Composer ref={composer} onSend={onSend} onStop={stop} canStop={canStop} />
      </div>
    </div>
  );
}
