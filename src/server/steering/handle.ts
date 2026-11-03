import type { ConversationActor } from '../actor.js';
import type { Generation } from '../orchestrator/generation.js';

/** Bumped by every stop_all; work queued before a stop must not start after it. */
const stopEpochs = new WeakMap<ConversationActor, number>();
const stopEpoch = (a: ConversationActor) => stopEpochs.get(a) ?? 0;

/**
 * Stops every live generation at what the client displayed. Idempotent per
 * clientReqId; with nothing live it appends nothing and returns seq null.
 */
export function handleStop(
  actor: ConversationActor,
  i: { clientReqId: string; rendered: Record<string, number> },
): { seq: number | null } {
  const prior = actor.findStopAll(i.clientReqId);
  if (prior) return { seq: prior.seq };
  const live = [...actor.generations.values()];
  if (live.length === 0) return { seq: null };
  const ev = actor.append({ type: 'stop_all', clientReqId: i.clientReqId });
  stopEpochs.set(actor, stopEpoch(actor) + 1);
  actor.turnAbort?.abort();
  for (const g of live) stopAt(g, i.rendered);
  return { seq: ev.seq };
}

// ---------------------------------------------------------------------------

function stopAt(g: Generation, rendered: Record<string, number>): void {
  try {
    g.stop(shown(rendered, g.messageId, g.textSoFar().length));
  } catch (err) {
    console.warn(`generation ${g.messageId}: stop failed`, err); // stop() still ends it
  }
}

/** Chars the client displayed, or `fallback` when it sent nothing usable. */
function shown(rendered: Record<string, number>, messageId: string, fallback: number): number {
  const n = rendered[messageId];
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), fallback) : fallback;
}
