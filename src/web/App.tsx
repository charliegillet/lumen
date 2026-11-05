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
    const near = () => el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    // Leaving the bottom is the reader's doing (wheel, touch, keys); only they unpin.
    const unpin = () => {
      pinned.current = false;
      setAtBottom(near());
    };
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const n = near();
      if (n) pinned.current = true;
      else if (el.scrollTop < lastTop) pinned.current = false; // dragged up (the layout only ever scrolls down)
      lastTop = el.scrollTop;
      setAtBottom(n);
    };
    let touchY = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) unpin();
    };
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY + 2) unpin();
      touchY = y;
    };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) unpin();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKey);
    // The window or composer changing size (growing field, mobile keyboard) must not hide the latest message.
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
      else setAtBottom(near());
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKey);
      ro.disconnect();
    };
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
  const { messages, displayed, send, retry, stop, canStop, loaded, reconnecting } = useConversation(conversationId);
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
                reason={m.reason}
                anchor={m.pending ? undefined : m.anchorSeq}
                typing={m.typing}
                onRetry={m.failed ? () => retry(m.key) : undefined}
              />
            );
          })}
        </div>
      </main>
      {reconnecting && (
        <div className="reconnecting" role="status">
          Reconnecting…
        </div>
      )}
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
