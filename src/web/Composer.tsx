import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentId } from '../shared/events.js';
import { AGENTS, AGENT_ORDER, Avatar } from './Bubble.js';

export interface ComposerHandle {
  focus(): void;
}

interface Props {
  onSend(text: string, typingStartedAt: number | null): void;
  onStop(): void;
  canStop: boolean;
}

const MAX_HEIGHT = 168;

/** The @word being typed right before the caret, if any. */
function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([a-z]*)$/i.exec(value.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() };
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ onSend, onStop, canStop }, ref) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const typingStartedAt = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  // Grow with the text, up to a cap.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    if (value === '') return; // a long placeholder must not grow the field
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const mention = mentionAt(value, caret);
  const options: AgentId[] =
    mention && dismissed !== mention.start ? AGENT_ORDER.filter((id) => id.startsWith(mention.query)) : [];
  const open = options.length > 0 && !(options.length === 1 && options[0] === mention?.query);

  const complete = (id: AgentId) => {
    if (!mention) return;
    const insert = `@${AGENTS[id].name} `;
    const next = value.slice(0, mention.start) + insert + value.slice(caret);
    const pos = mention.start + insert.length;
    setValue(next);
    setCaret(pos);
    setPick(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  };

  const submit = () => {
    const text = value.trim();
    if (text === '') return;
    onSend(text, typingStartedAt.current);
    typingStartedAt.current = null;
    setValue('');
    setCaret(0);
    setDismissed(null);
    area.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setPick((p) => (p + d + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        complete(options[Math.min(pick, options.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(mention!.start);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const hasText = value.trim() !== '';

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {open && (
        <ul className="mentions" role="listbox" aria-label="Mention a teammate">
          {options.map((id, i) => (
            <li key={id} role="option" aria-selected={i === pick}>
              <button
                type="button"
                className={i === pick ? 'active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setPick(i)}
                onClick={() => complete(id)}
              >
                <Avatar agentId={id} size="sm" />
                <span className="mention-name">{AGENTS[id].name}</span>
                <span className="mention-role">{AGENTS[id].role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="field">
        <textarea
          ref={area}
          rows={1}
          value={value}
          aria-label="Message"
          placeholder="Message the team — @Maya, @Theo or @Priya"
          autoFocus
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') typingStartedAt.current = null;
            else if (typingStartedAt.current === null) typingStartedAt.current = Date.now();
            setValue(v);
            setCaret(e.target.selectionStart);
            setPick(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="actions">
          {canStop && (
            <button type="button" className="btn btn-stop" onClick={() => {
                onStop();
                area.current?.focus();
              }}
              aria-label="Stop" title="Stop (Esc)">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
              </svg>
            </button>
          )}
          <button type="submit" className="btn btn-send" disabled={!hasText} aria-label="Send" title="Send (Enter)">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M12 19V5M5.5 11.5 12 5l6.5 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </form>
  );
});
