import { describe, expect, it } from 'vitest';
import { parseTargets } from '../../src/shared/targets.js';

describe('parseTargets', () => {
  it.each([
    ['@Theo shorter', ['theo'], false, false],
    ['Priya, numbers only', ['priya'], false, false],
    ['Pryia: wait', ['priya'], false, true],
    ['everyone stop', [], true, true],
    ['I agree with Theo', [], false, false],
    ["Theo's right", [], false, false],
    ['stop everything', [], false, true],
    ['waiting on maya?', [], false, false],
    ['@Maya @Theo be brief', ['maya', 'theo'], false, false],
    ['Many people disagree', [], false, false],
    ['hey y\'all', [], true, false],
    ['May I ask a question?', [], false, false],
    ["Prima facie it's fine", [], false, false],
    ['Theo? you there', ['theo'], false, false],
    ['Maya. Shorter.', ['maya'], false, false],
    ['@Maya hold on', ['maya'], false, true],
    ['Theo wait, focus on pricing', ['theo'], false, false],
    ['wait, what about pricing?', [], false, false],
    ['@Priya hold on', ['priya'], false, true],
    ['stop please', [], false, true],
    ['Theo, stop now!', ['theo'], false, true],
    ['stop being so negative', [], false, false],
    ['enough about churn, talk hiring', [], false, false],
    ['Theo.js is nice', [], false, false],
    ['Maya.ai', [], false, false],
    ['Priya.io? stop', [], false, false],
    ['Theo?', ['theo'], false, false],
    ['Maya.', ['maya'], false, false],
    ['Theo... stop', ['theo'], false, true],
    ['Maya?! hold on', ['maya'], false, true],
    ['Theo.\tShorter', ['theo'], false, false],
    ['many thanks', [], false, false],
    ['the plan is fine', [], false, false],
  ])('%s', (text, targets, broadcast, stop) => {
    expect(parseTargets(text)).toEqual({ targets, broadcast, stop });
  });
});
