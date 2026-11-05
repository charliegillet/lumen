import { describe, expect, it } from 'vitest';
import { dropsTopic, parseAddressing, parseMentions, parseResume, parseTargets } from '../../src/shared/targets.js';

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

describe('wider stops', () => {
  it.each([
    ['please stop', []],
    ['ok stop', []],
    ['stop it', []],
    ['never mind', []],
    ['nevermind', []],
    ['cancel', []],
    ['cancel that', []],
    ['enough', []],
    ["that's enough", []],
    ['ok that is enough', []],
    ['forget it', []],
    ['everyone please stop', []],
    ['tell priya to stop', ['priya']],
    ['tell everyone to stop please', []],
    ['tell maya and theo to stop', ['maya', 'theo']],
    ['Maya and Theo stop', ['maya', 'theo']],
    ['Maya and Theo stop, Priya keep going', ['maya', 'theo']],
    ['Maya, Theo, stop', ['maya', 'theo']],
    ['stop Theo', ['theo']],
    ['Priya please stop', ['priya']],
    ['hey Theo, stop it', ['theo']],
  ])('%s stops %j', (text, targets) => {
    expect(parseTargets(text)).toMatchObject({ targets, stop: true });
  });

  it.each([
    'please stop being so negative',
    'cancel my subscription',
    'never mind Northwind, what is our runway?',
    'tell priya to stop the audit',
    'wait, what about pricing?',
    'enough about churn, talk hiring',
    'do not stop',
  ])('%s is not a bare stop', (text) => {
    expect(parseTargets(text).stop).toBe(false);
  });
});

describe('addressing', () => {
  it.each([
    ['Only Priya answer this: will we keep Northwind?', ['priya'], true],
    ['only Maya: when does SSO ship? Nobody else needs to answer', ['maya'], true],
    ['Priya, just you please: are we okay on cash?', ['priya'], true],
    ['@Priya just you', ['priya'], true],
    ['Maya only', ['maya'], true],
    ['Just Theo, what about the renewal?', ['theo'], true],
    ['Maya and Theo only, what is the plan?', ['maya', 'theo'], true],
    ['Maya, what is the plan?', ['maya'], false],
    ['Maya only cares about scope', ['maya'], false],
    ['Is it just Theo who knows?', [], false],
    ['What is the only plan?', [], false],
  ])('%s', (text, named, only) => {
    expect(parseAddressing(text)).toMatchObject({ named, only });
  });

  it.each([
    ['Maya and Theo, argue it out', ['maya', 'theo']],
    ['Maya, Theo and Priya: thoughts?', ['maya', 'theo', 'priya']],
    ['@Maya and @Theo, what now?', ['maya', 'theo']],
    ['what would you do about Northwind, Priya?', ['priya']],
    ['hey Priya, how much cash?', ['priya']],
    ['Maya, Theo is right', ['maya']],
    ['should we ask Priya?', []],
    ["Maya and Theo's plan is fine", ['maya']],
  ])('%s names %j', (text, targets) => {
    expect(parseTargets(text).targets).toEqual(targets);
  });

  it('agents pull in teammates by @mention or leading address only', () => {
    expect(parseMentions('That is my view, Theo.')).toEqual([]);
    expect(parseMentions('Only Priya knows that.')).toEqual([]);
    expect(parseMentions('@Theo can you check?')).toEqual(['theo']);
    expect(parseMentions('Priya, can you check?')).toEqual(['priya']);
  });

  it('one of you asks for a single answer', () => {
    expect(parseAddressing('Just one of you answer: is it Tuesday?')).toMatchObject({ justOne: true, named: [] });
  });

  it.each([
    ["Everyone: what's your opinion on the office dog policy?", true],
    ['Each of you, give me your top risk', true],
    ['all three of you, what next?', true],
    ['What do you each do for fun?', true],
    ['Will everyone be okay with the plan?', false],
    ['hey everyone', false],
    ['Everyone stay quiet except Maya, Maya what is up', false],
  ])('%s asks everyone: %s', (text, everyone) => {
    expect(parseAddressing(text).everyone).toBe(everyone);
  });

  it('spots debates and joint answers', () => {
    expect(parseAddressing('Maya and Theo, argue it out: ship or hold?').debate).toBe(true);
    expect(parseAddressing('Give me one single joint recommendation').joint).toBe(true);
    expect(parseAddressing('agree on a date').joint).toBe(true);
    expect(parseAddressing('What is the plan?')).toMatchObject({ debate: false, joint: false });
  });

  it.each([
    ['Can we afford two more engineers? Need Maya and Priya combined.', ['maya', 'priya']],
    ["What is Theo and Priya's combined take on Northwind?", ['theo', 'priya']],
    ['Combine what Maya and Theo know: can we ship by March?', ['maya', 'theo']],
    ['Maya and Priya together, can we hire?', ['maya', 'priya']],
    ['Can you put your heads together on hiring?', []],
    ['Pool what you know about Northwind', []],
  ])('%s wants one answer from %j', (text, named) => {
    const a = parseAddressing(text);
    expect(a.joint).toBe(true);
    expect(a.named).toEqual(named);
  });

  it.each([
    'What is our combined revenue?',
    'Put together a plan for SSO-lite',
    'Did Maya and Priya talk?',
    'Priya, how do the two deals look combined?',
  ])('%s is not a request for one answer', (text) => {
    expect(parseAddressing(text).joint).toBe(false);
  });
});

describe('resume and topic drops', () => {
  it.each([
    ['carry on', []],
    ['continue', []],
    ['finish your thought', []],
    ['sorry, carry on Theo', ['theo']],
    ['Maya, keep going', ['maya']],
    ['ok go on please', []],
  ])('%s resumes %j', (text, targets) => {
    expect(parseResume(text)).toEqual({ targets });
  });

  it('other messages are not a resume', () => {
    expect(parseResume('continue with the pricing section')).toBeNull();
    expect(parseResume('what comes next?')).toBeNull();
  });

  it.each([
    ['actually never mind Northwind, what is our runway?', true],
    ['Never mind all that. Favourite colour?', true],
    ['forget Northwind', true],
    ['new topic: hiring', true],
    ['forget what I said about the language', false],
    ['never mind that rule', false],
    ['What is our runway?', false],
  ])('%s drops the topic: %s', (text, drops) => {
    expect(dropsTopic(text)).toBe(drops);
  });
});
