/**
 * Headed Slice 2 check — seller payment visibility + winner recovery after a
 * vanished unpaid mock Checkout Session.
 *
 * Env:
 *   CHECKOUT_RECOVERY_BASE_URL  default http://localhost:5107
 *   CHECKOUT_RECOVERY_HOLD_MS   keep Edge windows open (default 180000)
 *   DATABASE_URL                default auction_part_7
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';

const BASE_URL = process.env.CHECKOUT_RECOVERY_BASE_URL ?? 'http://localhost:5107';
const HOLD_MS = Number(process.env.CHECKOUT_RECOVERY_HOLD_MS ?? '180000');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';
const API_URL = BASE_URL.replace(':5107', ':3107');
const AUCTION_SECONDS = 18;

const SELLER = {
  id: '11111111-1111-4111-a111-111111111107',
  name: 'North Loop Compute',
};
const WINNER = {
  id: '11111111-1111-4111-a111-111111111101',
  name: 'Tensor Tamer',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDatetimeValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function launchWindow(label, index) {
  const width = 860;
  const height = 900;
  const x = index === 0 ? 0 : 860;
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: [`--window-position=${x},40`, `--window-size=${width},${height}`, '--new-window'],
  });
  const context = await browser.newContext({ viewport: { width: 820, height: 780 } });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select[aria-label="Active demo user"]');
  console.log(`[checkout-recovery] window ready (${label})`);
  return { browser, page, label };
}

async function selectUser(page, userId, displayName) {
  await page.waitForSelector('select[aria-label="Active demo user"]:not([disabled])');
  await page.evaluate((id) => {
    window.sessionStorage.setItem('auction-house-active-user', id);
  }, userId);
  await page.locator('select[aria-label="Active demo user"]').selectOption(userId);
  await page.waitForFunction(
    ({ id, name }) => {
      const select = document.querySelector('select[aria-label="Active demo user"]');
      const header = document.querySelector('.header-active-user strong');
      return select?.value === id && header?.textContent?.trim() === name;
    },
    { id: userId, name: displayName }
  );
}

async function createShortAuction(sellerPage) {
  const closingLocal = localDatetimeValue(new Date(Date.now() + 60_000));
  const title = `Checkout Recovery ${Date.now()}`;
  await sellerPage.goto(`${BASE_URL}/auctions/new`, { waitUntil: 'domcontentloaded' });
  await sellerPage.getByLabel('Title').fill(title);
  await sellerPage.getByLabel('Category').selectOption('Networking');
  await sellerPage.getByLabel('Description').fill('Slice 2 recovery lot.');
  await sellerPage.getByLabel('Condition').fill('Used');
  await sellerPage.getByLabel('Location').fill('Lab');
  await sellerPage.getByLabel('Starting price (USD)').fill('100.00');
  await sellerPage.getByLabel('Closing time').fill(closingLocal);
  await Promise.all([
    sellerPage.waitForURL(/\/auctions\/(?!new)/),
    sellerPage.getByRole('button', { name: /Post auction/i }).click(),
  ]);
  const slug = decodeURIComponent(new URL(sellerPage.url()).pathname.replace(/^\/auctions\//, ''));

  const detail = await sellerPage.request.get(`${BASE_URL}/api/auctions/${encodeURIComponent(slug)}`);
  assert.equal(detail.ok(), true);
  const body = await detail.json();
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('UPDATE auctions SET closing_time = $1 WHERE id = $2', [
      new Date(Date.now() + AUCTION_SECONDS * 1000).toISOString(),
      body.auction.id,
    ]);
  } finally {
    await client.end();
  }
  console.log(`[checkout-recovery] auction ${slug} closes in ~${AUCTION_SECONDS}s`);
  return { slug, auctionId: body.auction.id };
}

async function main() {
  console.log(`[checkout-recovery] base=${BASE_URL} hold=${HOLD_MS}ms`);
  const health = await fetch(`${API_URL}/api/health`).catch(() => null);
  assert.ok(health?.ok, `API health failed at ${API_URL}/api/health — run npm start first`);

  const seller = await launchWindow('Seller', 0);
  const winner = await launchWindow('Winner', 1);
  const browsers = [seller.browser, winner.browser];

  try {
    await selectUser(seller.page, SELLER.id, SELLER.name);
    await selectUser(winner.page, WINNER.id, WINNER.name);

    const { slug, auctionId } = await createShortAuction(seller.page);
    await winner.page.goto(`${BASE_URL}/auctions/${slug}`, { waitUntil: 'domcontentloaded' });
    await winner.page.locator('#bid').fill('101.00');
    await winner.page.getByRole('button', { name: /Place a bid/i }).click();
    await winner.page.waitForFunction(() => {
      const text = document.querySelector('.current-price strong')?.textContent ?? '';
      return text.includes('101');
    });

    console.log('[checkout-recovery] waiting for close…');
    await seller.page.goto(`${BASE_URL}/auctions/${slug}`, { waitUntil: 'domcontentloaded' });
    await seller.page.waitForSelector('[data-testid="auction-close-outcome"]', {
      timeout: 90_000,
    });
    await winner.page.waitForSelector('[data-testid="auction-close-outcome"]', {
      timeout: 90_000,
    });

    for (const page of [seller.page, winner.page]) {
      const dismiss = page.getByRole('button', { name: /^Dismiss$/i });
      if (await dismiss.count()) {
        await dismiss.first().click({ timeout: 5_000 }).catch(() => undefined);
      }
    }

    // Simulate an unpaid Purchase whose mock session was wiped (no live mock row).
    const purchaseId = randomUUID();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      await pool.query(
        `INSERT INTO purchases (id, auction_id, winner_id, amount_cents, status, stripe_checkout_session_id)
         VALUES ($1, $2, $3, 10100, 'unpaid', 'cs_test_vanished_session')
         ON CONFLICT (auction_id) DO UPDATE
         SET stripe_checkout_session_id = 'cs_test_vanished_session', status = 'unpaid', paid_at = NULL`,
        [purchaseId, auctionId, WINNER.id]
      );
    } finally {
      await pool.end();
    }

    await seller.page.reload({ waitUntil: 'domcontentloaded' });
    await winner.page.reload({ waitUntil: 'domcontentloaded' });

    await seller.page.waitForSelector('[data-testid="purchase-panel"]');
    await winner.page.waitForSelector('[data-testid="purchase-panel"]');
    const sellerStatus = await seller.page.locator('[data-testid="purchase-status"]').textContent();
    assert.match(sellerStatus ?? '', /Unpaid/i);
    assert.ok(await seller.page.locator('[data-testid="seller-recovery-hint"]').count());
    assert.equal(await seller.page.locator('[data-testid="complete-purchase"]').count(), 0);
    assert.ok(await winner.page.locator('[data-testid="complete-purchase"]').count());
    console.log('[checkout-recovery] seller sees Unpaid + recovery hint; winner sees pay CTA');

    await winner.page.getByTestId('complete-purchase').click();
    await winner.page.waitForURL(/127\.0\.0\.1:7107\/checkout\//, { timeout: 20_000 });
    const recoveredId = winner.page.url().split('/').pop();
    assert.notEqual(recoveredId, 'cs_test_vanished_session');
    console.log(`[checkout-recovery] recovered new session ${recoveredId}`);

    await winner.page.locator('#card').fill('4242 4242 4242 4242');
    await winner.page.locator('#expiry').fill('12 / 30');
    await winner.page.locator('#cvc').fill('123');
    await winner.page.getByRole('button', { name: /^Pay / }).click();
    await winner.page.waitForURL(new RegExp(`/auctions/${slug}`), { timeout: 30_000 });

    await winner.page.waitForFunction(() => {
      return document.querySelector('[data-testid="purchase-status"]')?.textContent?.includes('Paid');
    });
    await seller.page.reload({ waitUntil: 'domcontentloaded' });
    await seller.page.waitForFunction(() => {
      return document.querySelector('[data-testid="purchase-status"]')?.textContent?.includes('Paid');
    });
    assert.ok(await seller.page.locator('[data-testid="seller-paid-hint"]').count());
    console.log('[checkout-recovery] PASS — seller and winner both show Paid');
    console.log(`[checkout-recovery] holding windows open for ${HOLD_MS}ms`);
    await sleep(HOLD_MS);
  } finally {
    for (const browser of browsers) {
      await browser.close().catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error('[checkout-recovery] FAIL', error);
  process.exit(1);
});
