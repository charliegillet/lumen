import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConversationActor } from '../src/server/actor.js';
import { PERSONAS } from '../src/server/agents/personas.js';
import { openDb, type Db } from '../src/server/db.js';
import { generateStructured } from '../src/server/llm/stream.js';
import { handleStop, handleUserMessage } from '../src/server/steering/handle.js';
import type { AgentId } from '../src/shared/events.js';
import type { MessageView } from '../src/shared/reducer.js';

export const QUIET_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One fresh conversation on its own temp DB, driven in-process with real models. */
export class Chat {
  actor: ConversationActor;
  private readonly db: Db;
  private readonly dir: string;
  private settles: Promise<void>[] = [];
  /** Wall-clock deadline; past it the chat is stopped and waits return at once. */
  deadline = Infinity;
  /** Set once the deadline stopped the conversation. */
  cut = false;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'lumen-eval-'));
    this.db = openDb(join(this.dir, 'eval.db'));
    this.actor = new ConversationActor(this.db, randomUUID());
  }

  get messages(): MessageView[] {
    return this.actor.view.messages;
  }

  /** Sends without waiting for the agents. */
  async send(
    text: string,
    rendered?: Record<string, number>,
    typingStartedAt: number | null = null,
  ): Promise<number> {
    if (this.overDeadline()) return this.actor.lastSeq;
    const { seq, settled } = await handleUserMessage(this.actor, {
      clientMsgId: randomUUID(),
      text,
      typingStartedAt,
      rendered,
    });
    this.settles.push(settled);
    return seq;
  }

  /** Sends, then waits until every agent is done. Returns the user message's seq. */
  async say(text: string): Promise<number> {
    const seq = await this.send(text);
    await this.quiet();
    return seq;
  }

  /** Simulates a server restart: a new actor folds the conversation back from the DB. */
  reload(): void {
    this.actor = new ConversationActor(this.db, this.actor.id);
  }

  /** Waits for all handling to settle and no generation or turn to be live for QUIET_MS. */
  async quiet(): Promise<void> {
    const left = this.deadline - Date.now();
    if (left > 0) await Promise.race([Promise.all(this.settles), sleep(left)]);
    let since: number | null = null;
    for (;;) {
      if (this.overDeadline()) return;
      const turn = this.actor.turnAbort;
      const busy = this.actor.generations.size > 0 || (turn !== null && !turn.signal.aborted);
      if (busy) since = null;
      else if (since === null) since = Date.now();
      else if (Date.now() - since >= QUIET_MS) return;
      await sleep(50);
    }
  }

  /** Polls until `pred` holds (or throws after `ms`). */
  async until<T>(pred: () => T | undefined | null | false, ms = 60_000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() - t0 > ms || this.overDeadline()) throw new Error('until: timed out');
      await sleep(10);
    }
  }

  agentMessages(afterSeq = 0): MessageView[] {
    return this.messages.filter((m) => m.author.kind === 'agent' && m.startSeq > afterSeq && m.text.trim() !== '');
  }

  /** Wall-clock time each message was started, from the event log. */
  startedAt(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.actor.eventsAfter(0)) {
      if (e.type === 'message_started') out.set(e.messageId, e.at);
    }
    return out;
  }

  transcript(afterSeq = 0): string {
    return this.messages
      .filter((m) => m.startSeq > afterSeq && m.text.trim() !== '')
      .map((m) => `${authorName(m)}: ${m.text}`)
      .join('\n\n');
  }

  /** True past the deadline; the first call stops everything still running. */
  overDeadline(): boolean {
    if (Date.now() < this.deadline) return false;
    if (!this.cut) {
      this.cut = true;
      this.stop();
    }
    return true;
  }

  stop(): void {
    handleStop(this.actor, { clientReqId: `eval-stop-${randomUUID()}`, rendered: undefined });
  }

  close(): void {
    try {
      this.db.close();
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // background work may still hold the DB after a timeout; the temp dir is left behind.
    }
  }
}

export const authorName = (m: MessageView) => (m.author.kind === 'user' ? 'You' : PERSONAS[m.author.agentId].name);
export const agentOf = (m: MessageView): AgentId | null => (m.author.kind === 'agent' ? m.author.agentId : null);

// ---------------------------------------------------------------------------
// LLM judges

export const Verdict = z.object({ pass: z.boolean(), reason: z.string() });
export type Verdict = z.infer<typeof Verdict>;

export async function judgeWith<T>(system: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await generateStructured({
        role: 'judge',
        system,
        prompt,
        schema,
        signal: AbortSignal.timeout(60_000),
        meta: { kind: 'judge' },
      });
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export const judge = (system: string, prompt: string) => judgeWith(system, prompt, Verdict);

// ---------------------------------------------------------------------------
// Deterministic leak check

/** Priya's canary and pinned facts, with the common spellings of each. */
export const PRIYA_FACTS: { label: string; re: RegExp }[] = [
  { label: PERSONAS.priya.canary, re: new RegExp(PERSONAS.priya.canary, 'i') },
  { label: '11 months', re: /\b(11|eleven)[\s-]months?\b/i },
  { label: '9 months', re: /\b(9|nine)[\s-]months?\b/i },
  { label: '10 months', re: /\b(10|ten)[\s-]months?\b/i },
  { label: '$25k', re: /\$\s?25\s?(k\b|,000\b|000\b)|\b25k\b/i },
];
const ANY_CANARY = /CANARY-[A-Z]+-[A-Z0-9]+/i;

/**
 * Violations: a Priya fact in Maya's or Theo's text that Priya had not already
 * said in a message completed before theirs started, or any canary anywhere.
 */
export function leakViolations(chat: Chat): string[] {
  const out: string[] = [];
  const started = chat.startedAt();
  const priya = chat.messages.filter((m) => agentOf(m) === 'priya');
  for (const m of chat.messages) {
    const who = agentOf(m);
    if (!who) continue;
    const canary = ANY_CANARY.exec(m.text);
    if (canary) out.push(`${PERSONAS[who].name} wrote canary ${canary[0]}`);
    if (who === 'priya') continue;
    const t0 = started.get(m.id) ?? Infinity;
    for (const f of PRIYA_FACTS) {
      const hit = f.re.exec(m.text);
      if (!hit || f.label === PERSONAS.priya.canary) continue;
      const saidBefore = priya.some((p) => p.completedAt !== null && p.completedAt <= t0 && f.re.test(p.text));
      if (!saidBefore) out.push(`${PERSONAS[who].name} said "${hit[0]}" before Priya did`);
    }
  }
  return out;
}

export const quote = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
