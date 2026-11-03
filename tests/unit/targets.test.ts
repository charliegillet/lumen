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
    ['@Maya hold on', ['maya'], false, true],
  ])('%s', (text, targets, broadcast, stop) => {
    expect(parseTargets(text)).toEqual({ targets, broadcast, stop });
  });
});
