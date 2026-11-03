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
  await say(page, 'what should we do about pricing?');
  await allStreaming(page);
  await say(page, '@Theo shorter');
  await expect(bubbleOf(page, 'theo').filter({ hasText: 'STEERED:' })).toHaveCount(1);
  // The others keep going while Theo adjusts.
  expect(await grewBetween(page, 300)).toBeGreaterThanOrEqual(1);
  await expect(bubbleOf(page, 'maya').filter({ hasText: 'STEERED:' })).toHaveCount(0);
  await expect(bubbleOf(page, 'priya').filter({ hasText: 'STEERED:' })).toHaveCount(0);
  await expectNoMechanismWords(page);
  await expect(stopBtn(page)).toBeHidden();
  await expectNoMechanismWords(page);
});

test('stop everything', async ({ page }) => {
  await open(page);
  await say(page, 'what should we do about pricing?');
  await allStreaming(page);
  await stopBtn(page).click();
  await expect(stopBtn(page)).toBeHidden();
  const frozen = await texts(page);
  await page.waitForTimeout(1000);
  expect(await texts(page)).toEqual(frozen);
  expect(frozen.every((t) => t.length > 0)).toBe(true);
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
