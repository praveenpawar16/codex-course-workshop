/**
 * Headed check: auction flips to ENDED and disables bidding.
 * Hold open briefly for inspection.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE_URL = process.env.BIDDING_WAR_BASE_URL ?? 'http://localhost:5108';
const HOLD_MS = Number(process.env.CLOSING_UI_HOLD_MS ?? '20000');
const SELLER_ID = '11111111-1111-4111-a111-111111111107';
const BIDDER_ID = '11111111-1111-4111-a111-111111111101';

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`);
  assert.equal(health.ok, true, 'Part 6 must be running');

  const closing = new Date(Date.now() + 12_000).toISOString();
  const create = await fetch(`${BASE_URL}/api/auctions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sellerId: SELLER_ID,
      title: `Closing UI Check ${Date.now()}`,
      category: 'Networking',
      description: 'Short auction to verify Ended UI.',
      condition: 'Used',
      location: 'Lab',
      startingPriceCents: 10000,
      closingTime: closing,
    }),
  });
  assert.equal(create.status, 201);
  const { auction } = await create.json();

  // Force exact ~10s close via DB (datetime-local path not used here).
  const client = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_8',
  });
  await client.connect();
  try {
    await client.query('UPDATE auctions SET closing_time = $1 WHERE id = $2', [
      new Date(Date.now() + 10_000).toISOString(),
      auction.id,
    ]);
  } finally {
    await client.end();
  }

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: ['--window-position=40,40', '--window-size=1100,800'],
  });
  const context = await browser.newContext({ viewport: { width: 1080, height: 720 } });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('select[aria-label="Active demo user"]').selectOption(BIDDER_ID);
  await page.goto(`${BASE_URL}/auctions/${encodeURIComponent(auction.slug)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#bid');
  assert.equal(await page.getByRole('button', { name: /Place a bid/i }).isDisabled(), false);

  // Simulate background → foreground refresh path.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  const activity = await page.locator('[data-testid="bid-activity"]').textContent();
  assert.match(activity ?? '', /Tab active/i);

  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="auction-countdown"]');
    return el && el.textContent?.trim() === 'ENDED';
  }, null, { timeout: 20_000 });

  assert.equal(await page.getByRole('button', { name: /Place a bid/i }).isDisabled(), true);
  const note = await page.locator('.bid-form small').textContent();
  assert.match(note ?? '', /ended/i);

  console.log(`[closing-ui] PASS — ENDED + bidding disabled for ${auction.slug}`);
  console.log(`[closing-ui] holding ${HOLD_MS}ms`);
  await page.waitForTimeout(HOLD_MS);
  await browser.close();
}

main().catch((error) => {
  console.error('[closing-ui] FAIL', error);
  process.exitCode = 1;
});
