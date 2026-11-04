import { expect, test, type Page } from '@playwright/test';

const BUBBLES = '.bubble-agent';
const MECHANISM = /redirect|steer|interrupt|effort|thinking|instruction saved/i;

async function open(page: Page) {
  await page.goto(`/c/e2e-${Math.random().toString(36).slice(2, 10)}`);
  await expect(page.getByRole('heading', { name: 'Lumen team' })).toBeVisible();
}

async function say(page: Page, text: string) {
  const box = page.getByLabel('Message');
  await box.fill(text);
  await box.press('Enter');
}

const texts = (page: Page) => page.locator(BUBBLES).allInnerTexts();
const stopBtn = (page: Page) => page.getByRole('button', { name: 'Stop' });
const bubbleOf = (page: Page, id: string) => page.locator(`.row-agent[data-agent="${id}"] ${BUBBLES}`);

const LONG = 'what should we do about pricing? give a long answer';

async function allStreaming(page: Page) {
  await expect.poll(async () => (await texts(page)).filter((t) => t.length > 0).length).toBe(3);
}

/** How many agent bubbles grew between two samples. */
async function grewBetween(page: Page, gapMs = 400): Promise<number> {
  const a = await texts(page);
  await page.waitForTimeout(gapMs);
  const b = await texts(page);
  return b.filter((t, i) => t.length > (a[i]?.length ?? 0)).length;
}

/** Whether every listed agent's bubble grew between two samples. */
async function allGrew(page: Page, ids: string[], gapMs = 400): Promise<boolean[]> {
  const len = async () => Promise.all(ids.map(async (id) => (await bubbleOf(page, id).innerText()).length));
  const a = await len();
  await page.waitForTimeout(gapMs);
  const b = await len();
  return b.map((x, i) => x > a[i]!);
}

/** Thread rows top to bottom: an agent id, or the person's text. */
const rowOrder = (page: Page) =>
  page.locator('.thread > .row').evaluateAll((rows) =>
    rows.map((r) => (r as HTMLElement).dataset.agent ?? `you: ${(r as HTMLElement).innerText.trim()}`),
  );

/** Is the thread scrolled to (near) the bottom? */
const pinnedToBottom = (page: Page) =>
  page.locator('.scroller').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 72);

async function expectNoMechanismWords(page: Page) {
  const body = (await page.evaluate(() => document.body.innerText)).replaceAll('STEERED:', '');
  expect(body).not.toMatch(MECHANISM);
}

test('three agents stream concurrently', async ({ page }) => {
  await open(page);
  await say(page, 'what should we do about pricing?');
  await allStreaming(page);
  await expect(stopBtn(page)).toBeVisible();
  expect(await grewBetween(page)).toBeGreaterThanOrEqual(2);
  await expectNoMechanismWords(page);
});

test('steer by name mid-stream', async ({ page }) => {
  await open(page);
  await say(page, LONG);
  await allStreaming(page);
  const before = await rowOrder(page);
  expect(before.indexOf('theo')).toBeLessThan(before.indexOf('priya'));
  await say(page, '@Theo shorter');
  await expect(bubbleOf(page, 'theo').filter({ hasText: 'STEERED:' })).toHaveCount(1);
  // Theo's redirected answer now reads after the steer; the others stay above it.
  const after = await rowOrder(page);
  const steerAt = after.indexOf('you: @Theo shorter');
  expect(steerAt).toBeGreaterThan(-1);
  expect(after.indexOf('maya')).toBeLessThan(steerAt);
  expect(after.indexOf('priya')).toBeLessThan(steerAt);
  expect(after.indexOf('theo')).toBeGreaterThan(steerAt);
  expect(after.filter((r) => r === 'theo')).toHaveLength(1); // same bubble, not a new one
  await expect.poll(() => pinnedToBottom(page)).toBe(true);
  // Maya and Priya are still mid-stream and keep growing while Theo adjusts.
  expect(await allGrew(page, ['maya', 'priya'], 300)).toEqual([true, true]);
  await expect(stopBtn(page)).toBeVisible();
  await expect(bubbleOf(page, 'maya').filter({ hasText: 'STEERED:' })).toHaveCount(0);
  await expect(bubbleOf(page, 'priya').filter({ hasText: 'STEERED:' })).toHaveCount(0);
  await expectNoMechanismWords(page);
  await expect(stopBtn(page)).toBeHidden({ timeout: 30_000 });
  // The order survives a reload: it comes from the log.
  const final = await rowOrder(page);
  await page.reload();
  await expect.poll(() => rowOrder(page)).toEqual(final);
});

test('stop everything', async ({ page }) => {
  await open(page);
  await say(page, LONG);
  await allStreaming(page);
  await stopBtn(page).click();
  await expect(stopBtn(page)).toBeHidden();
  const frozen = await texts(page);
  await page.waitForTimeout(1000);
  expect(await texts(page)).toEqual(frozen);
  // Cut short: nobody reached the end of a 120-chunk stream.
  expect(frozen.every((t) => t.length > 0)).toBe(true);
  for (const t of frozen) expect(t.split(' ').length).toBeLessThan(100);
  expect(frozen.join(' ')).not.toMatch(/(maya|theo|priya)119/);
});

test('reload mid-stream', async ({ page }) => {
  await open(page);
  await say(page, 'what should we do about pricing?');
  await allStreaming(page);
  const before = await texts(page);
  await page.reload();
  await expect.poll(async () => (await texts(page)).length).toBe(before.length);
  const after = await texts(page);
  // Same order, and what was on screen is a prefix of what is shown now.
  after.forEach((t, i) => expect(t.startsWith(before[i]!)).toBe(true));
  await expect(stopBtn(page)).toBeVisible();
  await expect.poll(async () => (await texts(page)).join('').length).toBeGreaterThan(after.join('').length);
  await expect(stopBtn(page)).toBeHidden();
  const done = await texts(page);
  expect(done.every((t) => t.split(' ').length > 30)).toBe(true);
});

test('reload after completion', async ({ page }) => {
  await open(page);
  await say(page, 'what should we do about pricing?');
  await allStreaming(page);
  await expect(stopBtn(page)).toBeHidden({ timeout: 30_000 });
  const thread = page.getByRole('log');
  const before = await thread.textContent();
  await page.reload();
  await expect(thread.locator(BUBBLES)).toHaveCount(3);
  await expect.poll(() => thread.textContent()).toBe(before);
});

test('standing instruction survives reload', async ({ page }) => {
  await open(page);
  await say(page, 'from now on everyone end with ✅');
  await expect(page.locator(BUBBLES)).toHaveCount(3);
  await expect(stopBtn(page)).toBeHidden({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Lumen team' })).toBeVisible();
  const seen = 3;
  await say(page, 'what should we do about pricing?');
  await expect(page.locator(BUBBLES)).toHaveCount(seen + 3);
  await expect(stopBtn(page)).toBeHidden({ timeout: 30_000 });
  const all = await texts(page);
  const fresh = all.slice(seen);
  expect(fresh).toHaveLength(3);
  for (const t of fresh) expect(t.trim().endsWith('✅')).toBe(true);
});

test('no mechanism words anywhere in a full scenario', async ({ page }) => {
  await open(page);
  await expectNoMechanismWords(page);
  await say(page, 'what should we do about pricing?');
  await allStreaming(page);
  await expectNoMechanismWords(page);
  await say(page, '@Maya answer in French');
  await expect(bubbleOf(page, 'maya').filter({ hasText: 'STEERED:' })).toHaveCount(1);
  await expectNoMechanismWords(page);
  await stopBtn(page).click();
  await expect(stopBtn(page)).toBeHidden();
  await expectNoMechanismWords(page);
  await page.reload();
  await expect(page.locator(BUBBLES).first()).toBeVisible();
  await expectNoMechanismWords(page);
});
