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
 * Plain text with line breaks kept (via CSS), **bold** and @mentions.
 * An unclosed ** while words are still arriving is rendered bold already,
 * so the asterisks never flash on screen.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split('**');
  return (
    <>
      {parts.map((part, i) => {
        const nodes = withMentions(part, String(i));
        return i % 2 === 1 ? <strong key={i}>{nodes}</strong> : <span key={i}>{nodes}</span>;
      })}
    </>
  );
}

interface BubbleProps {
  agentId: AgentId | null; // null = the person
  text: string;
  first: boolean; // first of a run by the same author
  last: boolean;
  failed: boolean;
  onRetry?: () => void;
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

export const Bubble = memo(function Bubble({ agentId, text, first, last, failed, onRetry, anchor }: BubbleProps) {
  const ref = useArrival(anchor);
  if (agentId === null) {
    return (
      <div className={`row row-user${first ? ' first' : ''}${last ? ' last' : ''}`}>
        <div className={`bubble bubble-user${failed ? ' failed' : ''}`}>
          <RichText text={text} />
        </div>
        {failed && (
          <button type="button" className="retry" onClick={onRetry}>
            Not delivered. <span>Tap to retry</span>
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
        <div className="bubble bubble-agent">
          <RichText text={text} />
        </div>
      </div>
    </div>
  );
});
