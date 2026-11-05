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
const BROADCAST_SRC = "everyone|everybody|all of you|both of you|you all|y'all|guys|each of you|all three(?: of you)?";
const BROADCAST_ANY = new RegExp(`(?<![\\w'])(?:${BROADCAST_SRC})(?![\\w'])`, 'i');
const BROADCAST_LEAD = new RegExp(`^(?:${BROADCAST_SRC})(?![\\w'])`, 'i');
const NAME = 'maya|theo|priya';
const NAME_LIST = `@?(?:${NAME})(?:\\s*(?:,\\s*and|,|and|&|\\+)\\s*@?(?:${NAME}))*`;
/** Words people put in front of an address or a stop: "hey Maya", "ok stop". */
const FILLER = /^(?:(?:hey|hi|hello|yo|ok(?:ay)?|alright|so|please|pls|sorry)[\s,]+)+/i;
// A bare stop only ("Theo, stop", "everyone hold on please", "please cancel that").
// A stop word followed by an instruction ("Theo wait, focus on pricing") is a
// steer and goes through the classifier.
const STOP_WORD =
  "stop(?:\\s+(?:it|that|this|writing|talking|typing|there))*|cancel(?:\\s+(?:that|it|this))?|never\\s?mind|nvm|forget it|enough|that'?s\\s+enough|that\\s+is\\s+enough|wait|hold\\s+on|shh+|quiet|be\\s+quiet|shut\\s+up|abort|halt";
const STOP_OPENER = '(?:(?:ok(?:ay)?|please|pls|alright|just|no|hey|yes|sorry|so|thanks)[\\s,]+)*';
const STOP_CLOSER = "(?:\\s+(?:please|pls|everyone|everybody|all|all of you|you all|guys|now|already|thanks|thank you|for now))*";
const STOP_RE = new RegExp(`^${STOP_OPENER}(?:${STOP_WORD})${STOP_CLOSER}(?:[\\s,]+(${NAME_LIST}))?\\W*$`, 'i');
/** "tell priya to stop", "ask everyone to stop please". */
const TELL_STOP_RE = new RegExp(
  `^${STOP_OPENER}(?:tell|ask|get|have|make)\\s+(${NAME_LIST}|everyone|everybody|them|all of them|all of you)\\s+to\\s+(?:please\\s+)?(?:${STOP_WORD})${STOP_CLOSER}\\W*$`,
  'i',
);
/** "..., Priya keep going" after a stop leaves Priya alone. */
const KEEP_GOING_TAIL = new RegExp(`[\\s,;.]+(?:but\\s+)?@?(?:${NAME})\\s+(?:you\\s+)?(?:keep going|continue|carry on|go on)\\W*$`, 'i');
// Ordinary words that sit within edit distance 1 of a name.
const NOT_NAMES = new Set(['then', 'they', 'them', 'thee', 'mayo', 'prima', 'mays', 'thea', 'mama']);

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
  if (t.length < 4 || NOT_NAMES.has(t)) return undefined;
  return IDS.find((id) => id.length >= 4 && osa(t, id) <= 1);
}

/**
 * Leading name (exact or fuzzy) followed by , : ! whitespace or end, or by . or ?
 * that themselves end the word ("Maya. Shorter", "Theo?" but not "Theo.js").
 * Not an apostrophe.
 */
function leadingName(s: string): { id: TargetAgentId; rest: string } | undefined {
  const m = /^([A-Za-z]+)(?=[,:!\s]|[.?]+(?:[\s,:!]|$)|$)/.exec(s);
  if (!m) return undefined;
  const id = matchName(m[1]!);
  return id ? { id, rest: s.slice(m[0].length) } : undefined;
}

const namesIn = (src: string): TargetAgentId[] =>
  [...src.matchAll(new RegExp(`(?<![\\w'])(${NAME})(?![\\w'])`, 'gi'))].map((m) => m[1]!.toLowerCase() as TargetAgentId);

/**
 * More names after a leading one: "Maya and Theo, ...", "Maya, Theo and Priya:".
 * A plain comma only continues the list when the name ends the phrase, so
 * "Maya, Theo is right" stays aimed at Maya.
 */
function leadingList(s: string): { ids: TargetAgentId[]; rest: string } {
  const ids: TargetAgentId[] = [];
  let rest = s;
  const next = new RegExp(`^\\s*(,\\s*and\\s+|,\\s*|\\s+and\\s+|&\\s*|\\+\\s*)@?(${NAME})(?![\\w'])`, 'i');
  for (let m = next.exec(rest); m; m = next.exec(rest)) {
    const after = rest.slice(m[0].length);
    const plainComma = /^,\s*$/.test(m[1]!);
    if (plainComma && !/^\s*(?:$|[,:!?.&+]|and\b|stop\b|wait\b|hold\b)/i.test(after)) break;
    ids.push(m[2]!.toLowerCase() as TargetAgentId);
    rest = after;
  }
  return { ids, rest };
}

/** "what would you do about Northwind, Priya?" A closing name needs its comma: "should we ask Priya?" is not aimed at her. */
const TRAILING_VOCATIVE = new RegExp(`,\\s*@?(${NAME})\\s*[?.!]*\\s*$`, 'i');
const ONLY_LEAD = new RegExp(`(?:^|[.!?:;,-]\\s*)(?:only|just)\\s+(${NAME_LIST})(?![\\w'])`, 'i');
const ONLY_VERB = new RegExp(`\\bonly\\s+(${NAME_LIST})\\s+(?:should|can|may|needs?|to|answers?|repl(?:y|ies)|responds?)\\b`, 'i');
const ONLY_TAIL = new RegExp(`^(${NAME_LIST})[,:]?\\s+only\\s*(?:[,:.!?-]|$)`, 'i');
const JUST_YOU = /\b(?:just|only)\s+you\b/i;
const NOBODY_ELSE =
  /\b(?:no\s?one|nobody)\s+else\b|\b(?:everyone|everybody)\s+else\b[^.?!]*\b(?:quiet|out|silent|hold)\b|\b(?:the\s+)?(?:rest|others?)\b[^.?!]*\b(?:stay|be|keep)\s+(?:quiet|out|silent)\b/i;
const ONE_OF_YOU = /\bone\s+of\s+you\b/i;
const EVERYONE_ASK =
  /\b(?:each\s+of\s+you|all\s+three|you\s+each|all\s+of\s+you|what\s+(?:does|do)\s+(?:everyone|everybody|you\s+all))\b/i;
const EVERYONE_LEAD = /^(?:everyone|everybody|all\s+of\s+you|y'all|you\s+all|guys)\s*[,:!-]/i;
const DEBATE =
  /\b(?:argue|debate|hash\s+(?:it|this)\s+out|fight\s+(?:it|this)\s+out|duke\s+it\s+out|have\s+it\s+out|go\s+back\s+and\s+forth|push\s+back\s+on\s+each\s+other|disagree\s+with\s+each\s+other|talk\s+it\s+out)\b/i;
const NAME_PAIR = `@?(?:${NAME})(?:\\s*(?:,\\s*and|,|and|&|\\+)\\s*@?(?:${NAME}))+`;
/** "Maya and Priya combined", "combine what Maya and Theo know": these two, answering as one. */
const COMBINED_NAMES = new RegExp(
  `(?<![\\w'])(${NAME_PAIR})(?:'s)?\\s+(?:combined|together|joint)(?![\\w'])|\\bcombin(?:e|ing)\\s+(?:what\\s+)?(${NAME_PAIR})(?![\\w'])`,
  'i',
);
const JOINT =
  /\b(?:(?:one|single|joint|shared|unified|combined)\s+(?:(?:single|joint|shared|unified|combined)\s+)*(?:answer|recommendation|plan|position|decision|verdict|view|take|call)|agree\s+on|consensus|align\s+on|(?:figure|work)\s+(?:it|this)\s+out\s+together|combin(?:e|ing)\s+(?:what|your)\b|(?:you\s+two|you\s+both|both\s+of\s+you|the\s+(?:two|three)\s+of\s+you)\s+(?:combined|together)|heads\s+together|pool\s+(?:what|your))\b/i;

export interface Addressing {
  /** Agents the message is aimed at. */
  named: TargetAgentId[];
  /** Nobody but `named` may answer, for the whole turn ("only Priya", "just you", "nobody else"). */
  only: boolean;
  /** "one of you": exactly one agent answers, and nothing follows. */
  justOne: boolean;
  /** Each agent is asked to answer ("Everyone: ...", "each of you", "all three"). */
  everyone: boolean;
  /** The agents are asked to go at it: they react to each other before the turn ends. */
  debate: boolean;
  /** The person wants one answer from the group, so someone has to land it. */
  joint: boolean;
}

/** What the person said about who answers. Turn logic reads this; parseTargets carries the names. */
export function parseAddressing(text: string): Addressing {
  const trimmed = text.trim();
  const { targets } = parseTargets(trimmed);
  const bare = trimmed.replace(FILLER, '');
  const hasOnlyForm = ONLY_LEAD.test(trimmed) || ONLY_VERB.test(trimmed) || ONLY_TAIL.test(bare);
  const only = targets.length > 0 && (hasOnlyForm || JUST_YOU.test(trimmed) || NOBODY_ELSE.test(trimmed));
  const justOne = !only && targets.length === 0 && ONE_OF_YOU.test(trimmed);
  return {
    named: targets,
    only,
    justOne,
    everyone: !only && !justOne && targets.length === 0 && (EVERYONE_ASK.test(trimmed) || EVERYONE_LEAD.test(bare)),
    debate: !only && !justOne && DEBATE.test(trimmed),
    joint: !only && !justOne && (JOINT.test(trimmed) || COMBINED_NAMES.test(trimmed)),
  };
}

/** Who an agent's own message pulls in: @mentions and a leading address. No wording that only a person's request carries. */
export const parseMentions = (text: string): TargetAgentId[] => scan(text, false).targets;

export function parseTargets(text: string): RegexTargets {
  return scan(text, true);
}

function scan(text: string, human: boolean): RegexTargets {
  const targets: TargetAgentId[] = [];
  const add = (id: TargetAgentId) => {
    if (!targets.includes(id)) targets.push(id);
  };

  for (const m of text.matchAll(/@(maya|theo|priya)(?![\w'])/gi)) add(m[1]!.toLowerCase() as TargetAgentId);

  const trimmed = text.trim();
  let rest = trimmed.replace(FILLER, '');
  // Strip leading @mentions, then a leading name / broadcast word, plus punctuation.
  rest = rest.replace(/^(?:@(?:maya|theo|priya)(?![\w'])[\s,:!&+]*(?:and\s+)?)+/i, '');
  const lead = leadingName(rest);
  if (lead) {
    add(lead.id);
    const list = leadingList(lead.rest);
    list.ids.forEach(add);
    rest = list.rest;
  } else {
    const b = BROADCAST_LEAD.exec(rest);
    if (b) rest = rest.slice(b[0].length);
  }
  rest = rest.replace(/^[\s,:!.?]+/, '');
  if (!human) return { targets, broadcast: false, stop: false };

  for (const re of [ONLY_LEAD, ONLY_VERB, ONLY_TAIL]) {
    const m = re.exec(re === ONLY_TAIL ? trimmed.replace(FILLER, '') : trimmed);
    if (m) namesIn(m[1]!).forEach(add);
  }
  const combined = COMBINED_NAMES.exec(trimmed);
  if (combined) namesIn(combined[1] ?? combined[2]!).forEach(add);
  const closing = TRAILING_VOCATIVE.exec(trimmed);
  if (closing) add(closing[1]!.toLowerCase() as TargetAgentId);

  const told = TELL_STOP_RE.exec(trimmed);
  if (told) namesIn(told[1]!).forEach(add);
  const stopRest = rest.replace(KEEP_GOING_TAIL, '');
  const bareStop = STOP_RE.exec(stopRest);
  if (bareStop?.[1]) namesIn(bareStop[1]).forEach(add);
  const stop = bareStop !== null || told !== null || /^stop everything$/i.test(trimmed);
  return { targets, broadcast: BROADCAST_ANY.test(text) || /\b(?:them|all of them)\s+to\s+stop\b/i.test(trimmed), stop };
}

const RESUME_RE = new RegExp(
  `^${STOP_OPENER}(?:@?(${NAME_LIST})[\\s,:]+)?(?:please\\s+)?(?:you\\s+can\\s+)?(?:carry\\s+on|continue|keep\\s+going|go\\s+on|go\\s+ahead|resume|finish(?:\\s+(?:your|the)\\s+(?:thought|answer|sentence|point|message))?)(?:[\\s,]+@?(${NAME_LIST}))?(?:\\s+please)?\\W*$`,
  'i',
);

/** "carry on", "sorry, carry on Theo", "finish your thought": the person wants a cut answer picked back up. */
export function parseResume(text: string): { targets: TargetAgentId[] } | null {
  const m = RESUME_RE.exec(text.trim());
  if (!m) return null;
  return { targets: [...new Set(namesIn(`${m[1] ?? ''} ${m[2] ?? ''}`))] };
}

const TOPIC_DROP =
  /^(?:(?:actually|ok(?:ay)?|so|wait|hmm+|no|sorry|please|alright|hey|well)[\s,]+)*(?:(?:never\s?mind|nvm)(?!\s+(?:that|the|my)\s+(?:rule|instruction))|forget(?:\s+about)?(?!\s+(?:what|my|your|earlier|i\s+said|the\s+(?:rule|instruction)))|scratch\s+that|change\s+of\s+(?:topic|plan)|new\s+(?:topic|question)|different\s+(?:topic|question|subject)|moving\s+on|on\s+second\s+thought)(?![\w'])/i;

/** "actually never mind Northwind, what is our runway?": the earlier ask is off and something else may be on. */
export const dropsTopic = (text: string): boolean => TOPIC_DROP.test(text.trim());
