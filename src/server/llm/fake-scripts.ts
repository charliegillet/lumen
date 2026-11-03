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

export const fakeScripts: Record<string, (r: FakeRequest) => FakeReply> = {
  default: def,
  e2e: def, // Task 13 extends this
};
