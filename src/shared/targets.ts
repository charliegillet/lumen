// Dependency-free: bundled by Vite for the browser and used by the server.
export type TargetAgentId = 'maya' | 'theo' | 'priya';

export const AGENT_NAMES: Record<TargetAgentId, string> = {
  maya: 'Maya',
  theo: 'Theo',
  priya: 'Priya',
};

export interface RegexTargets {
  targets: TargetAgentId[];
  broadcast: boolean;
  stop: boolean;
}

const IDS = Object.keys(AGENT_NAMES) as TargetAgentId[];
const BROADCAST_SRC = "everyone|everybody|all of you|both of you|you all|y'all|guys";
const BROADCAST_ANY = new RegExp(`(?<![\\w'])(?:${BROADCAST_SRC})(?![\\w'])`, 'i');
const BROADCAST_LEAD = new RegExp(`^(?:${BROADCAST_SRC})(?![\\w'])`, 'i');
const STOP_RE = /^(stop|wait|hold on|enough|shh|quiet)\b/i;
// Ordinary words that sit within edit distance 1 of a name.
const NOT_NAMES = new Set(['many', 'then', 'they', 'them', 'thee', 'mayo', 'maybe', 'the']);

/** Optimal string alignment distance (insert/delete/substitute/adjacent swap). */
function osa(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

function matchName(token: string): TargetAgentId | undefined {
  const t = token.toLowerCase();
  const exact = IDS.find((id) => id === t);
  if (exact) return exact;
  if (NOT_NAMES.has(t)) return undefined;
  return IDS.find((id) => id.length >= 4 && osa(t, id) <= 1);
}

/** Leading name (exact or fuzzy) followed by , : ! whitespace or end. Not an apostrophe. */
function leadingName(s: string): { id: TargetAgentId; rest: string } | undefined {
  const m = /^([A-Za-z]+)(?=[,:!\s]|$)/.exec(s);
  if (!m) return undefined;
  const id = matchName(m[1]!);
  return id ? { id, rest: s.slice(m[0].length) } : undefined;
}

export function parseTargets(text: string): RegexTargets {
  const targets: TargetAgentId[] = [];
  const add = (id: TargetAgentId) => {
    if (!targets.includes(id)) targets.push(id);
  };

  for (const m of text.matchAll(/@(maya|theo|priya)(?![\w'])/gi)) add(m[1]!.toLowerCase() as TargetAgentId);

  let rest = text.trim();
  // Strip leading @mentions, then a leading name / broadcast word, plus punctuation.
  rest = rest.replace(/^(?:@(?:maya|theo|priya)(?![\w'])[\s,:!]*)+/i, '');
  const lead = leadingName(rest);
  if (lead) {
    add(lead.id);
    rest = lead.rest;
  } else {
    const b = BROADCAST_LEAD.exec(rest);
    if (b) rest = rest.slice(b[0].length);
  }
  rest = rest.replace(/^[\s,:!]+/, '');

  const trimmed = text.trim();
  const stop = STOP_RE.test(rest) || /^stop everything$/i.test(trimmed);
  return { targets, broadcast: BROADCAST_ANY.test(text), stop };
}
