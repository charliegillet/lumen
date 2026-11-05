export type SmallTalk = 'greeting' | 'thanks' | 'ack';

const GREETING = /^(?:hi|hey|hello|hiya|howdy|yo|sup|morning|good (?:morning|afternoon|evening)|gm)$/;
const THANKS = /^(?:thanks?(?: (?:a lot|so much|again|very much))?|thank you(?: (?:so|very) much)?|thx|ty|tysm|cheers|much appreciated|i appreciate it|appreciate it)$/;
const ACK =
  /^(?:ok(?:ay)?|k|cool|nice|great|awesome|perfect|got it|sounds good|makes sense|lol|haha(?:ha)*|hehe|sure)$/;
/** What people add after a thanks or a nod. Closed on purpose: anything else may carry real content. */
const PLEASANTRY =
  /^(?:(?:that|this|it|that's|this is|it's|that is)(?: (?:really|very|super|so))? (?:helps?|helped|helpful|useful|works?|clear|great|perfect|good|awesome|fair)(?: a lot)?|(?:really |very |super )?(?:helpful|useful)|(?:that |it )?makes sense|good to know|will do|nice work|good work|great work|well done|you're the best|you rock|you guys rock|all good|all clear|understood|noted|have a good one)$/;
/** Words that may follow the phrase: a group address or a name. */
const ADDRESS = /^(?:all|team|everyone|everybody|guys|folks|there|maya|theo|priya|@\w+)$/;
const MAX_LENGTH = 40;
/** A thanks with its pleasantry runs longer, and the closed phrase list keeps it safe. */
const MAX_COMPOUND_LENGTH = 80;
const MAX_PHRASE_WORDS = 7;

/** Classifies short phatic messages; null for anything with real content. */
export function smallTalkKind(text: string): SmallTalk | null {
  const t = text.trim();
  if (!t || t.length > MAX_COMPOUND_LENGTH) return null;
  // Emoji-only reactions such as a thumbs up.
  if (/^[\p{Extended_Pictographic}\s\p{P}]+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t)) return 'ack';

  const words = t
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}@'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // A question after the thanks is a question, however short.
  const compound = t.includes('?') ? null : thanksWithPleasantry(words);
  if (t.length > MAX_LENGTH) return compound;
  // Peel trailing address words, then match what is left as one phrase.
  while (words.length > 1 && ADDRESS.test(words[words.length - 1]!)) words.pop();
  const group = /\s(?:all of you|both of you|each of you|you all|y'all|all three of you|all three)$/.exec(words.join(' '));
  if (group) words.length -= group[0].trim().split(' ').length;
  const phrase = words.join(' ');
  if (THANKS.test(phrase)) return 'thanks';
  if (ACK.test(phrase)) return 'ack';
  if (GREETING.test(phrase)) return 'greeting';
  return compound;
}

/** "Thanks, that helps", "got it, thanks Maya": every word belongs to a known phrase, and at least one is a thanks or a nod. */
function thanksWithPleasantry(words: string[]): SmallTalk | null {
  let thanks = false;
  let nod = false;
  let spoken = false;
  let i = 0;
  while (i < words.length) {
    let matched = 0;
    // Longest phrase first, so "that really helps" is not cut short.
    for (let n = Math.min(MAX_PHRASE_WORDS, words.length - i); n > 0 && matched === 0; n--) {
      const phrase = words.slice(i, i + n).join(' ');
      if (THANKS.test(phrase)) thanks = true;
      else if (ACK.test(phrase)) nod = true;
      else if (PLEASANTRY.test(phrase)) spoken = true;
      else if (!(spoken || thanks || nod) || !ADDRESS.test(phrase)) continue;
      matched = n;
    }
    if (matched === 0) return null;
    i += matched;
  }
  if (thanks) return 'thanks';
  return nod || spoken ? 'ack' : null;
}

export const isSmallTalk = (text: string): boolean => smallTalkKind(text) !== null;

/** An explicit ask to be brief beats any depth wording around it. */
const BRIEF =
  /\b(?:brief(?:ly)?|quick(?:ly)?|short(?:ly)?|tl;?dr|summar(?:y|ize|ise)|one[- ](?:sentence|line|word)|(?:a|two|few) (?:sentences?|lines?|words?))\b/i;
// "full" alone is not a request: "full SSO" is a product here.
const DEPTH =
  /\b(?:walk (?:me|us) through|in (?:\w+ )?detail|detailed|thorough(?:ly)?|step[- ]by[- ]step|go (?:\w+ )?deep(?:er)?|deep[- ]dive|in[- ]depth|comprehensive(?:ly)?|exhaustive(?:ly)?|full (?:\w+ )?(?:picture|plan|breakdown|rundown|story|analysis|walkthrough|answer|details?|explanation|overview|assessment|account|review|scenarios?)|(?:give|lay|draft|write|make|build|put together|need|want|outline|map)\b[^.?!]*\bplan\b|what(?:'s| is) (?:the|our|your) plan\b)/i;

/** The person explicitly asked for a long answer, so it gets high effort whatever a gate bid. */
export const asksForDepth = (text: string): boolean => DEPTH.test(text) && !BRIEF.test(text);
