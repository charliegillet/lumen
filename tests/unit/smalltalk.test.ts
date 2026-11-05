import { describe, expect, it } from 'vitest';
import { asksForDepth, isSmallTalk, smallTalkKind } from '../../src/server/orchestrator/smalltalk.js';

describe('isSmallTalk', () => {
  it.each([
    ['Hi all!', 'greeting'],
    ['hello', 'greeting'],
    ['Hey team 👋', 'greeting'],
    ['yo', 'greeting'],
    ['Good morning everyone', 'greeting'],
    ['hi @Maya', 'greeting'],
    ['Morning!', 'greeting'],
    ['Thanks!', 'thanks'],
    ['thank you all', 'thanks'],
    ['thx', 'thanks'],
    ['Cheers, Theo.', 'thanks'],
    ['thanks so much team!', 'thanks'],
    ['appreciate it', 'thanks'],
    ['ok', 'ack'],
    ['Okay!', 'ack'],
    ['got it', 'ack'],
    ['sounds good', 'ack'],
    ['lol', 'ack'],
    ['haha', 'ack'],
    ['👍', 'ack'],
    ['nice 🎉', 'ack'],
    ['hey all of you', 'greeting'],
    ['thanks both of you', 'thanks'],
    ['Thanks, that helps.', 'thanks'],
    ['Thanks Maya, that really helps!', 'thanks'],
    ['thank you, very helpful', 'thanks'],
    ['That helps, thanks all', 'thanks'],
    ['Got it, thanks.', 'thanks'],
    ['Perfect, thank you so much, that makes sense', 'thanks'],
    ['ok thanks', 'thanks'],
    ['Thanks, good to know.', 'thanks'],
    ['Thanks team, that’s great', 'thanks'],
    ['Got it, that makes sense.', 'ack'],
    ['Cool, that works', 'ack'],
    ['That helps.', 'ack'],
  ])('%j is small talk (%s)', (text, kind) => {
    expect(isSmallTalk(text)).toBe(true);
    expect(smallTalkKind(text)).toBe(kind);
  });

  it.each([
    'hi all, will we keep Northwind?',
    'Thanks, can you also draft the plan?',
    'What should we build?',
    'ok so what about pricing',
    'Theo, shorter',
    'hello? anyone there to help with the launch',
    'great idea, let us ship it on Friday',
    '',
    '   ',
    'thanks for the detailed breakdown of the Q3 numbers and the roadmap',
    'Thanks, that helps. What is our runway?',
    'Thanks, that helps. Now walk me through the downside',
    'Thanks, that helps?',
    'Thanks, what about Northwind?',
    'thanks, but why did SSO slip',
    'Thanks, that helps with Northwind',
    'That helps, can you draft it',
    'Got it, thanks. Who owns the renewal?',
  ])('%j is not small talk', (text) => {
    expect(isSmallTalk(text)).toBe(false);
  });
});

describe('asksForDepth', () => {
  it.each([
    "Give me the full runway picture: walk me through scenarios, assumptions and what we'd cut first",
    '@Priya walk me through our runway situation in detail',
    'Maya, go deep on the SSO timeline',
    'go deeper',
    'Give me a thorough read on Northwind',
    'Draft a plan for the renewal',
    "What's the plan for Northwind?",
    'Step by step, how do we hit Feb 28?',
    'an in-depth view of the pipeline please',
  ])('%j asks for depth', (text) => {
    expect(asksForDepth(text)).toBe(true);
  });

  it.each([
    'when does full SSO ship?',
    'Will we keep Northwind?',
    'How much runway do we have?',
    'Do we plan to ship Friday?',
    'walk me through it briefly',
    'one sentence: what is the full picture?',
    'a quick plan is fine, give me one',
    'Thanks, that helps.',
  ])('%j does not', (text) => {
    expect(asksForDepth(text)).toBe(false);
  });
});
