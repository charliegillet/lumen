import type { FakeReply, FakeRequest } from './fake.js';

/**
 * Named fake scripts, selected at boot via FAKE_SCRIPT (default: "default").
 * Structured kinds return `{object}` placeholders; later tasks refine them to
 * match their schemas (gate bid, dedup, classifier, judge).
 */
const def = (r: FakeRequest): FakeReply => {
  switch (r.kind) {
    case 'reply':
    case 'continue':
    case 'replace': {
      const name = r.agentId ?? 'agent';
      const words = `Hi, this is ${name} with a short answer.`.split(' ');
      return { chunks: words.map((w, i) => (i ? ' ' + w : w)), delayMs: 20 };
    }
    case 'gate':
      return {
        object: { should_respond: true, novelty: 1, gist: 'a short reply', addresses: [], effort: 'low' },
      };
    case 'dedup':
      return { object: { duplicate: false } };
    case 'classify':
      return { object: {} };
    case 'judge':
      return { object: {} };
  }
};

export const fakeScripts: Record<string, (r: FakeRequest) => FakeReply> = {
  default: def,
  e2e: def, // Task 13 extends this
};
