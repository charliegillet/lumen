import type { AgentId, ConvEvent } from './events.js';

export interface MessageView {
  id: string;
  author: { kind: 'user' } | { kind: 'agent'; agentId: AgentId };
  text: string;
  status: 'streaming' | 'done' | 'stopped';
  startSeq: number;
  segment: number;
  completedAt: number | null;
  hop: number;
}
export interface ConversationView {
  lastSeq: number;
  messages: MessageView[]; // ordered by startSeq
  instructions: { id: string; scope: AgentId | 'all'; text: string }[];
}

export const emptyView: ConversationView = { lastSeq: 0, messages: [], instructions: [] };

export class GapError extends Error {
  constructor(
    public readonly expected: number,
    public readonly got: number,
  ) {
    super(`Event seq gap: expected ${expected}, got ${got}`);
    this.name = 'GapError';
  }
}

function updateMessage(
  view: ConversationView,
  id: string,
  f: (m: MessageView) => MessageView,
): MessageView[] | null {
  const i = view.messages.findIndex((m) => m.id === id);
  if (i < 0) return null;
  const next = view.messages.slice();
  next[i] = f(view.messages[i] as MessageView);
  return next;
}

export function applyEvent(view: ConversationView, e: ConvEvent): ConversationView {
  if (e.seq <= view.lastSeq) return view;
  if (e.seq > view.lastSeq + 1) throw new GapError(view.lastSeq + 1, e.seq);
  const base = { ...view, lastSeq: e.seq };
  const withMessages = (messages: MessageView[] | null): ConversationView =>
    messages ? { ...base, messages } : base;

  switch (e.type) {
    case 'user_message':
      return {
        ...base,
        messages: [
          ...view.messages,
          {
            id: e.messageId,
            author: { kind: 'user' },
            text: e.text,
            status: 'done',
            startSeq: e.seq,
            segment: 0,
            completedAt: e.at,
            hop: 0,
          },
        ],
      };
    case 'message_started':
      return {
        ...base,
        messages: [
          ...view.messages,
          {
            id: e.messageId,
            author: { kind: 'agent', agentId: e.agentId },
            text: '',
            status: 'streaming',
            startSeq: e.seq,
            segment: 0,
            completedAt: null,
            hop: e.hop,
          },
        ],
      };
    case 'token_delta':
      return withMessages(
        updateMessage(view, e.messageId, (m) =>
          m.status === 'streaming' && e.segment === m.segment ? { ...m, text: m.text + e.text } : m,
        ),
      );
    case 'message_segment_started':
      return withMessages(
        updateMessage(view, e.messageId, (m) => ({
          ...m,
          text: m.text.slice(0, e.truncateTo),
          segment: e.segment,
          status: 'streaming',
          completedAt: null,
        })),
      );
    case 'message_completed':
      return withMessages(
        updateMessage(view, e.messageId, (m) => ({ ...m, status: 'done', completedAt: e.at })),
      );
    case 'message_aborted':
      return withMessages(
        updateMessage(view, e.messageId, (m) => ({
          ...m,
          text: m.text.slice(0, e.truncateTo),
          status: 'stopped',
          completedAt: null,
        })),
      );
    case 'instruction_set':
      return {
        ...base,
        instructions: [
          ...view.instructions.filter((i) => i.id !== e.instructionId),
          { id: e.instructionId, scope: e.scope, text: e.text },
        ],
      };
    case 'instruction_revoked':
      return { ...base, instructions: view.instructions.filter((i) => i.id !== e.instructionId) };
    case 'steer_resolved':
    case 'stop_all':
      return base;
  }
}

export function fold(events: readonly ConvEvent[]): ConversationView {
  return events.reduce(applyEvent, emptyView);
}

export function visibleMessages(view: ConversationView): MessageView[] {
  return view.messages.filter(
    (m) => !(m.author.kind === 'agent' && m.text === '' && m.status !== 'streaming'),
  );
}
