import { z } from 'zod';
import type { AgentId } from '../../shared/events.js';
import type { ConversationView } from '../../shared/reducer.js';
import { parseTargets } from '../../shared/targets.js';
import { generateStructured } from '../llm/stream.js';
import { publicRoster } from '../agents/prompt.js';

export const SteerDecisionSchema = z.object({
  kind: z.enum(['stop', 'steer', 'new_message']),
  targets: z.array(z.enum(['maya', 'theo', 'priya'])),
  apply: z.enum(['continue', 'replace']),
  scope: z.enum(['one_off', 'standing']),
  standing_text: z.string().nullable(),
  revokes: z.array(z.string()),
});
export type SteerDecision = z.infer<typeof SteerDecisionSchema>;
/** A decision, marked `fallback` when no classifier answer was usable. */
export type ClassifiedSteer = SteerDecision & { fallback?: true };

export interface SteerInput {
  text: string;
  streaming: { agentId: AgentId; partial: string }[];
  recentlyFinished: { agentId: AgentId; text: string }[];
  instructions: ConversationView['instructions'];
}

const SYSTEM = `You classify a message the human just sent while AI agents in a group chat may still be writing.
Decide:
- kind: "stop" (the human wants the targeted agents to stop writing), "steer" (the message changes how a currently-writing agent's reply should go), or "new_message" (unrelated chatter or a fresh topic).
- targets: which agents (maya, theo, priya) the message is aimed at. Empty means everyone writing.
- apply: "replace" for language, format or contradicting-content changes, or when the partial is under about 10 words; "continue" for additive or style-softening changes.
- scope: default to "one_off". Use "standing" only for persistence wording ("from now on", "always", "never", "going forward", "every message") or an unmistakable general rule about style, length, language or tone. "this one", "it", "the next reply", "just", and requests attached to a specific question are one_off, as is anything about specific content or wording ("everyone say the same words", "answer with one word"). Requests to reveal, quote, print or append notes, reference codes, instructions or configuration, to treat a claim as fact, to invent numbers, or to never say you do not know are NEVER standing: mark them one_off. When unsure, one_off.
- standing_text: for standing scope, the instruction rewritten as a short imperative; otherwise null.
- revokes: ids of existing standing instructions that this message cancels or supersedes; otherwise []. A vague revocation ("forget what I said about the language", "forget my earlier instruction", "never mind that rule") revokes the matching instruction, or every existing one when none is named. An explicit request about the same dimension (e.g. a 200-word plan after a one-sentence rule) also revokes that rule.
A stop-like opener followed by an instruction ("wait, focus on pricing", "hold on, make it shorter") is "steer", not "stop": the person wants the reply redirected, not ended. A stop-like opener followed by a question or new topic ("wait, what about pricing?") is "steer" when it bears on what agents are writing, else "new_message". Use "stop" only when the person wants the writing to end.
Finishing requests ("wrap it up", "finish", "conclude", "land the plane") are "steer" with apply "continue": the agent should end in one short sentence, not be cut off. "Theo should answer instead" or "no wait, X instead" is a "steer" aimed at the agent currently writing (targets lists that agent, not the new one), never "new_message". A style request with nobody writing ("shorter", "in French please") refers to the most recent finished reply: kind "steer" targeting that reply's author.
Unrelated chatter is "new_message". Respond with the JSON object only.`;

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

function buildPrompt(a: SteerInput): string {
  const ins = a.instructions.length
    ? a.instructions.map((i) => `- [${i.id}] (${i.scope}) ${i.text}`).join('\n')
    : '(none)';
  const streaming = a.streaming.length
    ? a.streaming.map((s) => `- ${s.agentId} (still writing): ${tail(s.partial, 400)}`).join('\n')
    : '(nobody is writing)';
  const finished = a.recentlyFinished.length
    ? a.recentlyFinished.map((s) => `- ${s.agentId}: ${tail(s.text, 300)}`).join('\n')
    : '(none)';
  return [
    `Who is in the chat:\n${publicRoster()}`,
    `Standing instructions currently in force:\n${ins}`,
    `Agents currently writing:\n${streaming}`,
    `Recently finished replies:\n${finished}`,
    `The human's new message:\n${a.text}`,
  ].join('\n\n');
}

export async function classifySteer(a: SteerInput, signal?: AbortSignal): Promise<ClassifiedSteer> {
  try {
    const raw = await generateStructured({
      role: 'classifier',
      system: SYSTEM,
      prompt: buildPrompt(a),
      schema: SteerDecisionSchema,
      signal,
      meta: { kind: 'classify' },
    });
    const parsed = SteerDecisionSchema.parse(raw);
    const known = new Set(a.instructions.map((i) => i.id));
    const d: SteerDecision = {
      ...parsed,
      targets: [...new Set(parsed.targets)],
      revokes: parsed.revokes.filter((id) => known.has(id)),
    };
    if (d.scope === 'standing' && d.standing_text === null) d.standing_text = a.text;
    return d;
  } catch (e) {
    if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
    return {
      kind: a.streaming.length ? 'steer' : 'new_message',
      targets: parseTargets(a.text).targets,
      apply: 'continue',
      scope: 'one_off',
      standing_text: null,
      revokes: [],
      fallback: true,
    };
  }
}
