/**
 * Headed close-notification check — seller + winner Edge windows side by side.
 *
 * Env:
 *   CLOSE_NOTIFY_BASE_URL  default http://localhost:5108
 *   CLOSE_NOTIFY_HOLD_MS   keep windows open after assertions (default 12000)
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import pg from 'pg';

const BASE_URL = process.env.CLOSE_NOTIFY_BASE_URL ?? 'http://localhost:5108';
const HOLD_MS = Number(process.env.CLOSE_NOTIFY_HOLD_MS ?? '12000');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_8';

async function main() {
  const health = await fetch(`${BASE_URL.replace(':5108', ':3108')}/api/health`).catch(() => null);
  // Prefer API via Vite proxy health
  const proxied = await fetch(`${BASE_URL}/api/health`);
  assert.equal(proxied.ok, true, 'Part 6 must be running (npm start)');
  void health;

  const users = await (await fetch(`${BASE_URL}/api/users`)).json();
  const seller = users.users[0];
  const winner = users.users[1];
  assert.ok(seller && winner);

  // Clear leftover undismissed popups from earlier demos/tests for these users.
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(
    `UPDATE close_notifications
     SET dismissed_at = now()
     WHERE recipient_user_id = ANY($1::uuid[])
       AND dismissed_at IS NULL`,
    [[seller.id, winner.id]]
  );

  const created = await (
    await fetch(`${BASE_URL}/api/auctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sellerId: seller.id,
        title: `Close Notify Demo ${Date.now()}`,
        category: 'Networking',
        description: 'Popup verification lot.',
        condition: 'Used',
        location: 'Lab',
        startingPriceCents: 10000,
        closingTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    })
  ).json();
  const slug = created.auction.slug;

  await fetch(`${BASE_URL}/api/auctions/${slug}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bidderId: winner.id, amountCents: 10100 }),
  });

  await client.query(`UPDATE auctions SET closing_time = now() - interval '2 seconds' WHERE slug = $1`, [
    slug,
  ]);
  await client.end();

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
  });

  const sellerContext = await browser.newContext({ viewport: { width: 720, height: 900 } });
  const winnerContext = await browser.newContext({ viewport: { width: 720, height: 900 } });
  const sellerPage = await sellerContext.newPage();
  const winnerPage = await winnerContext.newPage();

  // Approximate side-by-side placement.
  const sellerSession = await sellerContext.newCDPSession(sellerPage);
  const winnerSession = await winnerContext.newCDPSession(winnerPage);
  const sellerTarget = await sellerSession.send('Browser.getWindowForTarget');
  const winnerTarget = await winnerSession.send('Browser.getWindowForTarget');
  await sellerSession.send('Browser.setWindowBounds', {
    windowId: sellerTarget.windowId,
    bounds: { left: 40, top: 60, width: 720, height: 900, windowState: 'normal' },
  });
  await winnerSession.send('Browser.setWindowBounds', {
    windowId: winnerTarget.windowId,
    bounds: { left: 780, top: 60, width: 720, height: 900, windowState: 'normal' },
  });

  async function openAs(page, userId) {
    await page.addInitScript((id) => {
      sessionStorage.setItem('auction-house-active-user', id);
    }, userId);
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  }

  await openAs(sellerPage, seller.id);
  await openAs(winnerPage, winner.id);

  const sellerModal = sellerPage.getByTestId('close-notification-modal');
  const winnerModal = winnerPage.getByTestId('close-notification-modal');

  await sellerPage.waitForFunction(
    () => {
      const modal = document.querySelector('[data-testid="close-notification-modal"]');
      return modal?.getAttribute('data-outcome') === 'sold' && modal?.getAttribute('data-role') === 'seller';
    },
    undefined,
    { timeout: 20000 }
  );
  await winnerPage.waitForFunction(
    () => {
      const modal = document.querySelector('[data-testid="close-notification-modal"]');
      return modal?.getAttribute('data-outcome') === 'sold' && modal?.getAttribute('data-role') === 'winner';
    },
    undefined,
    { timeout: 20000 }
  );

  assert.equal(await sellerModal.getAttribute('data-role'), 'seller');
  assert.equal(await winnerModal.getAttribute('data-role'), 'winner');
  assert.equal(await sellerModal.getAttribute('data-outcome'), 'sold');
  assert.equal(await winnerModal.getAttribute('data-outcome'), 'sold');

  const sellerNotificationId = await sellerModal.getAttribute('data-notification-id');
  const winnerNotificationId = await winnerModal.getAttribute('data-notification-id');
  assert.ok(sellerNotificationId);
  assert.ok(winnerNotificationId);
  assert.notEqual(sellerNotificationId, winnerNotificationId);

  await sellerPage.getByTestId('close-notification-dismiss').click();
  await sellerPage.waitForFunction(
    (id) => {
      const modal = document.querySelector('[data-testid="close-notification-modal"]');
      return !modal || modal.getAttribute('data-notification-id') !== id;
    },
    sellerNotificationId,
    { timeout: 5000 }
  );
  // Explicit dismiss only closes the seller modal; winner remains until dismissed.
  assert.equal(await winnerModal.isVisible(), true);
  assert.equal(await winnerModal.getAttribute('data-notification-id'), winnerNotificationId);

  await winnerPage.getByTestId('close-notification-dismiss').click();
  await winnerPage.waitForFunction(
    (id) => {
      const modal = document.querySelector('[data-testid="close-notification-modal"]');
      return !modal || modal.getAttribute('data-notification-id') !== id;
    },
    winnerNotificationId,
    { timeout: 5000 }
  );

  if (HOLD_MS > 0) {
    await sellerPage.waitForTimeout(HOLD_MS);
  }

  await browser.close();
  console.log('close-notifications headed check passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
