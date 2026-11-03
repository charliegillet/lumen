import type { FakeReply, FakeRequest } from './fake.js';

/**
 * Named fake scripts, selected at boot via FAKE_SCRIPT (default: "default").
 * Structured kinds return `{object}` placeholders; later tasks refine them to
 * match their schemas (gate bid, dedup, classifier, judge).
 */
const def = (r: FakeRequest): FakeReply => {
  switch (r.kind) {
    case 'reply': {
      const name = r.agentId ?? 'agent';
      const words = `Hi, this is ${name} with a short answer.`.split(' ');
      return { chunks: words.map((w, i) => (i ? ' ' + w : w)), delayMs: 20 };
    }
    case 'continue':
    case 'replace': {
      // Steered segments carry a visible marker that tests and e2e assert on.
      const name = r.agentId ?? 'agent';
      const words = `${name} adjusted the answer.`.split(' ');
      return { chunks: ['STEERED: ', ...words.map((w, i) => (i ? ' ' + w : w))], delayMs: 20 };
    }
    case 'gate': {
      const name = r.agentId ?? 'agent';
      return {
        object: { should_respond: true, novelty: 1, gist: `${name} point`, addresses: ['user'], effort: 'low' },
      };
    }
    case 'dedup': {
      // Each agent in its own cluster: parse the `agentId: gist` lines.
      const ids = [...(r.prompt ?? '').matchAll(/^(maya|theo|priya): /gm)].map((m) => [m[1]!]);
      return { object: { clusters: ids } };
    }
    case 'classify':
      return {
        object: { kind: 'new_message', targets: [], apply: 'continue', scope: 'one_off', standing_text: null, revokes: [] },
      };
    case 'judge':
      return { object: { complies: true } };
  }
};

const NAMES: Record<string, string> = { maya: 'Maya', theo: 'Theo', priya: 'Priya' };

/** Slow 40-chunk streams for browser tests; obeys a standing "end with ✅" and classifies by simple text rules. */
function e2e(r: FakeRequest): FakeReply {
  const id = r.agentId ?? 'maya';
  const name = NAMES[id] ?? 'Maya';
  const stream = (head: string): FakeReply => {
    // A "long" message in the chat gets 120 chunks so tests can act well before natural completion.
    const n = r.messages.some((m) => /\blong\b/.test(String(m.content))) ? 119 : 39;
    const chunks = [head, ...Array.from({ length: n }, (_, i) => ` ${name.toLowerCase()}${i + 1}`)];
    if (r.system.includes('end with ✅')) chunks[chunks.length - 1] += ' ✅';
    return { chunks, delayMs: 40 };
  };
  switch (r.kind) {
    case 'reply':
      return stream(`${name} here`);
    case 'continue':
    case 'replace':
      return stream('STEERED: ');
    case 'gate': {
      const first = /You are 0 replies deep/.test(r.messages.map((m) => String(m.content)).join('\n'));
      return {
        object: { should_respond: first, novelty: 1, gist: `${name} has a point of its own`, addresses: ['user'], effort: 'low' },
      };
    }
    case 'dedup': {
      const ids = [...(r.prompt ?? '').matchAll(/^(maya|theo|priya): /gm)].map((m) => [m[1]!]);
      return { object: { clusters: ids } };
    }
    case 'judge':
      return { object: { complies: true } };
    case 'classify': {
      const prompt = r.prompt ?? '';
      const text = (prompt.split("The human's new message:\n")[1] ?? prompt).trim();
      const writing = [...(prompt.split('Agents currently writing:\n')[1]?.split('\n\n')[0] ?? '').matchAll(/^- (maya|theo|priya) /gm)].map(
        (m) => m[1]!,
      );
      const base = { targets: [] as string[], apply: 'continue', scope: 'one_off', standing_text: null, revokes: [] as string[] };
      if (/from now on/i.test(text)) {
        return { object: { ...base, kind: writing.length ? 'steer' : 'new_message', scope: 'standing', standing_text: text } };
      }
      const named = [...text.matchAll(/(?:^|@)(maya|theo|priya)\b/gi)].map((m) => m[1]!.toLowerCase());
      const targets = named.filter((n) => writing.includes(n));
      if (targets.length > 0) {
        const apply = /in french|replace/i.test(text) ? 'replace' : 'continue';
        return { object: { ...base, kind: 'steer', targets, apply } };
      }
      return { object: { ...base, kind: 'new_message' } };
    }
  }
}

export const fakeScripts: Record<string, (r: FakeRequest) => FakeReply> = {
  default: def,
  e2e,
};
