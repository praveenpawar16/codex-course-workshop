/**
 * Manual short-auction watch: create via UI, bid, wait for close + seller/winner modals.
 * Leaves Edge windows open for inspection (CLOSE_WATCH_HOLD_MS, default 60000).
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import pg from 'pg';

const BASE_URL = process.env.CLOSE_WATCH_BASE_URL ?? 'http://localhost:5106';
const HOLD_MS = Number(process.env.CLOSE_WATCH_HOLD_MS ?? '60000');
const AUCTION_SECONDS = Number(process.env.CLOSE_WATCH_SECONDS ?? '15');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_6';

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

async function selectUser(page, userId, displayName) {
  await page.locator('select[aria-label="Active demo user"]').selectOption(userId);
  await page.waitForFunction(
    ({ id, name }) => {
      const select = document.querySelector('select[aria-label="Active demo user"]');
      const header = document.querySelector('.header-active-user strong');
      return select?.value === id && header?.textContent?.includes(name);
    },
    { id: userId, name: displayName },
    { timeout: 5000 }
  );
}

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`);
  assert.equal(health.ok, true, 'Part 6 must be running');

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(
    `UPDATE close_notifications
     SET dismissed_at = now()
     WHERE recipient_user_id = ANY($1::uuid[])
       AND dismissed_at IS NULL`,
    [[SELLER.id, WINNER.id]]
  );

  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const sellerCtx = await browser.newContext({ viewport: { width: 720, height: 900 } });
  const winnerCtx = await browser.newContext({ viewport: { width: 720, height: 900 } });
  const sellerPage = await sellerCtx.newPage();
  const winnerPage = await winnerCtx.newPage();

  const sellerCdp = await sellerCtx.newCDPSession(sellerPage);
  const winnerCdp = await winnerCtx.newCDPSession(winnerPage);
  const sellerWin = await sellerCdp.send('Browser.getWindowForTarget');
  const winnerWin = await winnerCdp.send('Browser.getWindowForTarget');
  await sellerCdp.send('Browser.setWindowBounds', {
    windowId: sellerWin.windowId,
    bounds: { left: 40, top: 60, width: 720, height: 900, windowState: 'normal' },
  });
  await winnerCdp.send('Browser.setWindowBounds', {
    windowId: winnerWin.windowId,
    bounds: { left: 780, top: 60, width: 720, height: 900, windowState: 'normal' },
  });

  // --- Manual create as seller ---
  await sellerPage.goto(`${BASE_URL}/auctions/new`, { waitUntil: 'domcontentloaded' });
  await selectUser(sellerPage, SELLER.id, SELLER.name);

  const title = `Manual Short Close ${Date.now()}`;
  // datetime-local needs a future minute; we shorten via DB right after create.
  const closingLocal = localDatetimeValue(new Date(Date.now() + 5 * 60_000));
  await sellerPage.getByLabel('Title').fill(title);
  await sellerPage.getByLabel('Category').selectOption('Networking');
  await sellerPage.getByLabel('Description').fill('Short manual auction to watch close notifications.');
  await sellerPage.getByLabel('Condition').fill('Used · Demo');
  await sellerPage.getByLabel('Location').fill('Watch Lab');
  await sellerPage.getByLabel('Starting price (USD)').fill('100.00');
  await sellerPage.getByLabel('Closing time').fill(closingLocal);
  await Promise.all([
    sellerPage.waitForURL((url) => {
      const path = url.pathname;
      return path.startsWith('/auctions/') && path !== '/auctions/new';
    }),
    sellerPage.getByRole('button', { name: /Post auction/i }).click(),
  ]);

  const slug = decodeURIComponent(new URL(sellerPage.url()).pathname.replace(/^\/auctions\//, ''));
  assert.ok(slug && slug !== 'new', `expected auction slug, got ${slug}`);
  console.log(`[manual-close] created ${slug}`);

  const detailResponse = await fetch(`${BASE_URL}/api/auctions/${encodeURIComponent(slug)}`);
  assert.equal(detailResponse.ok, true, `auction detail failed for ${slug}`);
  const detail = await detailResponse.json();
  const auctionId = detail.auction.id;
  const targetClose = new Date(Date.now() + AUCTION_SECONDS * 1000).toISOString();
  await client.query('UPDATE auctions SET closing_time = $1 WHERE id = $2', [targetClose, auctionId]);
  await client.end();
  console.log(`[manual-close] shortened closing_time to ~${AUCTION_SECONDS}s`);

  // Refresh seller detail so countdown reflects shortened close; open winner tab.
  await sellerPage.goto(`${BASE_URL}/auctions/${encodeURIComponent(slug)}`, {
    waitUntil: 'domcontentloaded',
  });
  await selectUser(sellerPage, SELLER.id, SELLER.name);

  await winnerPage.goto(`${BASE_URL}/auctions/${encodeURIComponent(slug)}`, {
    waitUntil: 'domcontentloaded',
  });
  await selectUser(winnerPage, WINNER.id, WINNER.name);

  await winnerPage.locator('#bid').fill('101.00');
  await winnerPage.getByRole('button', { name: /Place a bid/i }).click();
  await winnerPage.locator('.current-price strong').filter({ hasText: '101.00' }).waitFor({
    timeout: 10_000,
  });
  console.log('[manual-close] winner bid accepted at $101.00');

  // Wait for durable close + UI outcome.
  const deadline = Date.now() + (AUCTION_SECONDS + 20) * 1000;
  let closed;
  while (Date.now() < deadline) {
    const body = await (await fetch(`${BASE_URL}/api/auctions/${encodeURIComponent(slug)}`)).json();
    if (body.auction.closed && body.auction.outcome === 'sold') {
      closed = body.auction;
      break;
    }
    await sleep(500);
  }
  assert.ok(closed, 'expected durable closed sold outcome');
  assert.equal(closed.winner.id, WINNER.id);
  console.log(
    `[manual-close] outcome recorded: closed=${closed.closed} winner=${closed.winner.displayName} amount=${closed.winningAmountCents}`
  );

  await sellerPage.waitForFunction(
    () => document.querySelector('[data-testid="auction-countdown"]')?.textContent?.trim() === 'CLOSED',
    null,
    { timeout: 20_000 }
  );

  await sellerPage.waitForFunction(
    () => {
      const modal = document.querySelector('[data-testid="close-notification-modal"]');
      return (
        modal?.getAttribute('data-role') === 'seller' &&
        modal?.getAttribute('data-outcome') === 'sold'
      );
    },
    null,
    { timeout: 20_000 }
  );
  const sellerTitle = (
    await sellerPage.locator('[data-testid="close-notification-modal"] h2').textContent()
  )?.trim();
  assert.equal(sellerTitle, 'Your auction closed');
  console.log(`[manual-close] seller modal: "${sellerTitle}"`);

  await winnerPage.waitForFunction(
    () => {
      const modal = document.querySelector('[data-testid="close-notification-modal"]');
      return (
        modal?.getAttribute('data-role') === 'winner' &&
        modal?.getAttribute('data-outcome') === 'sold'
      );
    },
    null,
    { timeout: 20_000 }
  );
  const winnerTitle = (
    await winnerPage.locator('[data-testid="close-notification-modal"] h2').textContent()
  )?.trim();
  assert.equal(winnerTitle, 'You won this auction');
  console.log(`[manual-close] winner modal: "${winnerTitle}"`);

  console.log(`[manual-close] PASS — holding windows open for ${HOLD_MS}ms (inspect popups)`);
  await sleep(HOLD_MS);
  await browser.close();
}

main().catch((error) => {
  console.error('[manual-close] FAIL', error);
  process.exitCode = 1;
});
