import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { AgentId } from '../shared/events.js';

export const AGENTS: Record<AgentId, { name: string; role: string; initial: string }> = {
  maya: { name: 'Maya', role: 'Engineering', initial: 'M' },
  theo: { name: 'Theo', role: 'Sales', initial: 'T' },
  priya: { name: 'Priya', role: 'Finance', initial: 'P' },
};
export const AGENT_ORDER: AgentId[] = ['maya', 'theo', 'priya'];

export function Avatar({ agentId, size = 'md' }: { agentId: AgentId; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`avatar avatar-${size}`} data-agent={agentId} aria-hidden="true">
      {AGENTS[agentId].initial}
    </span>
  );
}

const MENTION = /@(maya|theo|priya)(?![\w'])/gi;

function withMentions(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const i = m.index;
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <span key={`${keyBase}-${i}`} className="mention" data-agent={m[1]!.toLowerCase()}>
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Plain text with line breaks kept (via CSS) and @mentions. Agent text also gets
 * **bold** for closed pairs with no space inside; one still open at the very end
 * (words arriving) is bold already, so the asterisks never flash. The person's
 * own text is never reinterpreted.
 */
const BOLD = /\*\*(?=\S)([^\n]*?\S)\*\*|\*\*(?=\S)([^\n*]*)$/g;

export function RichText({ text, bold = false }: { text: string; bold?: boolean }) {
  if (!bold) return <>{withMentions(text, 'p')}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    const i = m.index;
    if (i > last) out.push(<span key={`t${i}`}>{withMentions(text.slice(last, i), `t${i}`)}</span>);
    out.push(<strong key={`b${i}`}>{withMentions(m[1] ?? m[2] ?? '', `b${i}`)}</strong>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(<span key="end">{withMentions(text.slice(last), 'end')}</span>);
  return <>{out}</>;
}

interface BubbleProps {
  agentId: AgentId | null; // null = the person
  text: string;
  first: boolean; // first of a run by the same author
  last: boolean;
  failed: boolean;
  reason?: string;
  onRetry?: () => void;
  /** Started but no words on screen yet: show typing dots instead of text. */
  typing?: boolean;
  /** Display position (anchorSeq). When it changes after mount the bubble eases in at its new place. */
  anchor?: number;
}

/** Replays a short arrival animation on the row whenever `anchor` changes after the first render. */
function useArrival(anchor: number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef(anchor);
  useLayoutEffect(() => {
    const el = ref.current;
    if (seen.current === anchor || !el) return;
    seen.current = anchor;
    el.classList.remove('arrive');
    void el.offsetWidth; // restart the animation if it is still running
    el.classList.add('arrive');
  }, [anchor]);
  return ref;
}

export const Bubble = memo(function Bubble({ agentId, text, first, last, failed, reason, onRetry, anchor, typing }: BubbleProps) {
  const ref = useArrival(anchor);
  if (agentId === null) {
    return (
      <div className={`row row-user${first ? ' first' : ''}${last ? ' last' : ''}`}>
        <div className={`bubble bubble-user${failed ? ' failed' : ''}`}>
          <RichText text={text} />
        </div>
        {failed && (
          <button type="button" className="retry" onClick={onRetry}>
            {reason ?? 'Not delivered'}. <span>Tap to retry</span>
          </button>
        )}
      </div>
    );
  }
  const a = AGENTS[agentId];
  return (
    <div
      ref={ref}
      className={`row row-agent${first ? ' first' : ''}${last ? ' last' : ''}`}
      data-agent={agentId}
      onAnimationEnd={(e) => e.currentTarget.classList.remove('arrive')}
    >
      <div className="gutter">{first ? <Avatar agentId={agentId} /> : null}</div>
      <div className="stack">
        {first && (
          <div className="byline">
            <span className="name">{a.name}</span>
            <span className="role">{a.role}</span>
          </div>
        )}
        {typing ? (
          <div className="bubble bubble-agent bubble-typing" role="img" aria-label={`${a.name} is typing`}>
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        ) : (
          <div className="bubble bubble-agent">
            <RichText text={text} bold />
          </div>
        )}
      </div>
    </div>
  );
});
