export type SmallTalk = 'greeting' | 'thanks' | 'ack';

const GREETING = /^(?:hi|hey|hello|hiya|howdy|yo|sup|morning|good (?:morning|afternoon|evening)|gm)$/;
const THANKS = /^(?:thanks?(?: (?:a lot|so much|again|very much))?|thank you(?: (?:so|very) much)?|thx|ty|tysm|cheers|much appreciated|i appreciate it|appreciate it)$/;
const ACK =
  /^(?:ok(?:ay)?|k|cool|nice|great|awesome|perfect|got it|sounds good|makes sense|lol|haha(?:ha)*|hehe|sure)$/;
/** Words that may follow the phrase: a group address or a name. */
const ADDRESS = /^(?:all|team|everyone|everybody|guys|folks|there|maya|theo|priya|@\w+)$/;
const MAX_LENGTH = 40;

/** Classifies short phatic messages; null for anything with real content. */
export function smallTalkKind(text: string): SmallTalk | null {
  const t = text.trim();
  if (!t || t.length > MAX_LENGTH) return null;
  // Emoji-only reactions such as a thumbs up.
  if (/^[\p{Extended_Pictographic}\s\p{P}]+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t)) return 'ack';

  const words = t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Peel trailing address words, then match what is left as one phrase.
  while (words.length > 1 && ADDRESS.test(words[words.length - 1]!)) words.pop();
  const group = /\s(?:all of you|both of you|each of you|you all|y'all|all three of you|all three)$/.exec(words.join(' '));
  if (group) words.length -= group[0].trim().split(' ').length;
  const phrase = words.join(' ');
  if (THANKS.test(phrase)) return 'thanks';
  if (ACK.test(phrase)) return 'ack';
  if (GREETING.test(phrase)) return 'greeting';
  return null;
}

export const isSmallTalk = (text: string): boolean => smallTalkKind(text) !== null;
