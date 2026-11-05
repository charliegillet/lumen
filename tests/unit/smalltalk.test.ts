import { describe, expect, it } from 'vitest';
import { isSmallTalk, smallTalkKind } from '../../src/server/orchestrator/smalltalk.js';

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
  ])('%j is not small talk', (text) => {
    expect(isSmallTalk(text)).toBe(false);
  });
});
