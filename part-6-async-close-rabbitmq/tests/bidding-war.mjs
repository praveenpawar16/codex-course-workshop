/**
 * Headed Bidding War — four isolated Edge windows (1 seller + 3 distinct bidders).
 * Part 6 asserts protected concurrent bidding, durable close outcome, and
 * seller/winner close-notification modals (Socket.IO + workers).
 *
 * Env:
 *   BIDDING_WAR_BASE_URL  default http://localhost:5106
 *   BIDDING_WAR_HOLD_MS   keep Edge windows open after assertions (default 120000)
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BIDDING_WAR_BASE_URL ?? 'http://localhost:5106';
const HOLD_MS = Number(process.env.BIDDING_WAR_HOLD_MS ?? '120000');
const AUCTION_SECONDS = 22;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_6';

const SELLER = {
  id: '11111111-1111-4111-a111-111111111107',
  label: 'North Loop Compute (@north_loop)',
};
const BIDDERS = [
  { id: '11111111-1111-4111-a111-111111111101', label: 'Tensor Tamer (@tensor_tamer)', name: 'Tensor Tamer' },
  { id: '11111111-1111-4111-a111-111111111102', label: 'Thread Ripper (@thread_ripper_47)', name: 'Thread Ripper' },
  { id: '11111111-1111-4111-a111-111111111103', label: 'Segfault Sally (@segfault_sally)', name: 'Segfault Sally' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDatetimeValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function gridBounds(index, screen) {
  const halfW = Math.floor(screen.width / 2);
  const halfH = Math.floor(screen.height / 2);
  const col = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: screen.x + col * halfW,
    y: screen.y + row * halfH,
    width: halfW,
    height: halfH,
  };
}

async function detectWorkArea() {
  if (process.env.BIDDING_WAR_SCREEN_WIDTH && process.env.BIDDING_WAR_SCREEN_HEIGHT) {
    return {
      x: Number(process.env.BIDDING_WAR_SCREEN_X ?? '0'),
      y: Number(process.env.BIDDING_WAR_SCREEN_Y ?? '0'),
      width: Number(process.env.BIDDING_WAR_SCREEN_WIDTH),
      height: Number(process.env.BIDDING_WAR_SCREEN_HEIGHT),
    };
  }
  try {
    const { execFileSync } = await import('node:child_process');
    const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WA { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, ref RECT c, int d); }
"@
$r = New-Object WA+RECT; [void][WA]::SystemParametersInfo(0x30, 0, [ref]$r, 0)
Write-Output "$($r.Left) $($r.Top) $($r.Right-$r.Left) $($r.Bottom-$r.Top)"
`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
    }).trim();
    const [x, y, width, height] = out.split(/\s+/).map(Number);
    if ([x, y, width, height].every((n) => Number.isFinite(n) && n >= 0) && width > 800 && height > 600) {
      return { x, y, width, height };
    }
  } catch {
    // fall through
  }
  return { x: 0, y: 0, width: 1707, height: 1019 };
}

async function launchTiledPage(label, index, screen) {
  const bounds = gridBounds(index, screen);
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: [
      `--window-position=${bounds.x},${bounds.y}`,
      `--window-size=${bounds.width},${Math.max(400, bounds.height - 8)}`,
      '--new-window',
    ],
  });
  const context = await browser.newContext({
    viewport: {
      width: Math.max(640, bounds.width - 24),
      height: Math.max(420, bounds.height - 88),
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);

  try {
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        windowState: 'normal',
      },
    });
  } catch (error) {
    console.log(`[bidding-war] window bounds fallback for ${label}: ${error.message}`);
  }

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('select[aria-label="Active demo user"]');
  console.log(
    `[bidding-war] window ${index + 1}/4 ready (${label}) at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`
  );
  return { browser, context, page, label };
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
      return select?.value === id && (!name || header?.textContent?.trim() === name);
    },
    { id: userId, name: displayName ?? null }
  );
}

async function assertActiveUser(page, userId, displayName) {
  const selected = await page.locator('select[aria-label="Active demo user"]').inputValue();
  assert.equal(selected, userId, `expected active user ${displayName ?? userId}`);
  const header = await page.locator('.header-active-user strong').textContent();
  if (displayName) {
    assert.equal(header?.trim(), displayName, `header should show ${displayName}`);
  }
}

function attachNavigationGuard(page, label) {
  let navigations = 0;
  const onNav = (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  };
  page.on('framenavigated', onNav);
  return {
    reset() {
      navigations = 0;
    },
    assertNone(context) {
      assert.equal(
        navigations,
        0,
        `${label} navigated/reloaded during ${context} (Socket.IO must update without reload)`
      );
    },
    dispose() {
      page.off('framenavigated', onNav);
    },
  };
}

async function createAuction(sellerPage) {
  const closing = new Date(Date.now() + AUCTION_SECONDS * 1000);
  const closingLocal = localDatetimeValue(new Date(Math.max(closing.getTime(), Date.now() + 60_000)));
  const title = `Bidding War Demo ${Date.now()}`;

  await sellerPage.goto(`${BASE_URL}/auctions/new`, { waitUntil: 'domcontentloaded' });
  await selectUser(sellerPage, SELLER.id, 'North Loop Compute');
  await assertActiveUser(sellerPage, SELLER.id, 'North Loop Compute');
  await sellerPage.getByLabel('Title').fill(title);
  await sellerPage.getByLabel('Category').selectOption('Networking');
  await sellerPage.getByLabel('Description').fill(
    'Bidding War lot for reproducing overlapping accepted bids.'
  );
  await sellerPage.getByLabel('Condition').fill('Used · Race demo');
  await sellerPage.getByLabel('Location').fill('Concurrency Lab');
  await sellerPage.getByLabel('Starting price (USD)').fill('100.00');
  await sellerPage.getByLabel('Closing time').fill(closingLocal);
  await Promise.all([
    sellerPage.waitForURL(/\/auctions\/bidding-war/),
    sellerPage.getByRole('button', { name: /Post auction/i }).click(),
  ]);

  const slug = decodeURIComponent(new URL(sellerPage.url()).pathname.replace(/^\/auctions\//, ''));
  assert.ok(slug.startsWith('bidding-war'), `expected bidding-war slug, got ${slug}`);

  const detail = await sellerPage.request.get(`${BASE_URL}/api/auctions/${encodeURIComponent(slug)}`);
  assert.equal(detail.ok(), true);
  const body = await detail.json();
  const auctionId = body.auction.id;
  const targetClose = new Date(Date.now() + AUCTION_SECONDS * 1000).toISOString();

  const { Client } = await import('pg');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('UPDATE auctions SET closing_time = $1 WHERE id = $2', [
      targetClose,
      auctionId,
    ]);
  } finally {
    await client.end();
  }

  // No reload here — watchers navigate fresh below and pick up the shortened closing time.
  console.log(`[bidding-war] auction ${slug} closes in ~${AUCTION_SECONDS}s`);
  return { slug, closingAt: Date.parse(targetClose) };
}

async function waitBidIdle(page) {
  await page.getByRole('button', { name: /Place a bid/i }).waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
}

async function placeBidUi(page, dollars) {
  await waitBidIdle(page);
  const button = page.getByRole('button', { name: /Place a bid/i });
  if (await button.isDisabled()) {
    console.log('[bidding-war] bid control disabled (ended or blocked); skipping UI submit');
    return;
  }
  await page.locator('#bid').fill(dollars);
  await button.click();
  await page.waitForTimeout(400);
}

async function fetchBids(page, slug) {
  const response = await page.request.get(`${BASE_URL}/api/auctions/${encodeURIComponent(slug)}`);
  assert.equal(response.ok(), true);
  const body = await response.json();
  return body.bids;
}

function duplicateAmounts(bids) {
  const counts = new Map();
  for (const bid of bids) {
    counts.set(bid.amountCents, (counts.get(bid.amountCents) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([amount]) => amount);
}

async function simultaneousWave(bidderPages, dollars) {
  const ready = [];
  for (const page of bidderPages) {
    const button = page.getByRole('button', { name: /Place a bid/i });
    if (await button.isDisabled()) continue;
    await page.locator('#bid').fill(dollars);
    ready.push(page);
  }
  if (ready.length === 0) {
    console.log('[bidding-war] no enabled bid forms for simultaneous wave');
    return;
  }
  await Promise.all(
    ready.map(async (page) => page.getByRole('button', { name: /Place a bid/i }).click())
  );
  await sleep(800);
  await Promise.all(ready.map((page) => waitBidIdle(page)));
}

/** Wait for Socket.IO-driven DOM updates — never reload. */
async function waitForLivePrice(pages, dollars) {
  const needle = dollars.startsWith('$') ? dollars : `$${dollars}`;
  await Promise.all(
    pages.map(async (page) => {
      await page.locator('.current-price strong').filter({ hasText: needle }).waitFor({
        timeout: 12_000,
      });
    })
  );
}

async function waitForLiveHistoryMin(pages, minCount) {
  await Promise.all(
    pages.map(async (page) => {
      await page.waitForFunction(
        (min) => document.querySelectorAll('[data-testid="bid-history-list"] li').length >= min,
        minCount,
        { timeout: 12_000 }
      );
    })
  );
}

async function waitForEndedLive(pages) {
  await Promise.all(
    pages.map(async (page) => {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="auction-countdown"]');
          const text = el?.textContent?.trim();
          return text === 'ENDED' || text === 'CLOSED';
        },
        null,
        { timeout: 45_000 }
      );
    })
  );
}

async function waitForClosedOutcome(page, slug) {
  const deadline = Date.now() + 30_000;
  let body;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${BASE_URL}/api/auctions/${encodeURIComponent(slug)}`);
    assert.equal(response.ok(), true);
    body = await response.json();
    if (body.auction?.closed && body.auction?.outcome === 'sold' && body.auction?.winner?.id) {
      return body.auction;
    }
    await sleep(400);
  }
  assert.fail(
    `timed out waiting for closed sold outcome; last=${JSON.stringify({
      closed: body?.auction?.closed,
      outcome: body?.auction?.outcome,
      winner: body?.auction?.winner,
    })}`
  );
}

async function waitForCloseModal(page, expected) {
  await page.waitForFunction(
    ({ role, outcome }) => {
      const modal = document.querySelector('[data-testid="close-notification-modal"]');
      if (!modal) return false;
      return (
        modal.getAttribute('data-role') === role &&
        modal.getAttribute('data-outcome') === outcome
      );
    },
    expected,
    { timeout: 30_000 }
  );
  const modal = page.getByTestId('close-notification-modal');
  const title = (await modal.locator('h2').textContent())?.trim();
  return { modal, title };
}

async function main() {
  console.log(`[bidding-war] base=${BASE_URL} hold=${HOLD_MS}ms`);

  const health = await fetch(`${BASE_URL}/api/health`);
  assert.equal(health.ok, true, 'Part 6 must be running (npm start)');
  const healthBody = await health.json();
  assert.equal(healthBody.redis, 'ok', 'Redis must be healthy for Socket.IO fan-out');

  // Avoid stale undismissed popups from earlier demos interfering with this run.
  const { Client } = await import('pg');
  const cleanup = new Client({ connectionString: DATABASE_URL });
  await cleanup.connect();
  try {
    await cleanup.query(
      `UPDATE close_notifications
       SET dismissed_at = now()
       WHERE recipient_user_id = ANY($1::uuid[])
         AND dismissed_at IS NULL`,
      [[SELLER.id, ...BIDDERS.map((bidder) => bidder.id)]]
    );
  } finally {
    await cleanup.end();
  }

  const screen = await detectWorkArea();
  console.log(
    `[bidding-war] work area ${screen.width}x${screen.height} at ${screen.x},${screen.y}`
  );
  const windows = [];
  const guards = [];

  try {
    windows.push(await launchTiledPage('Seller', 0, screen));
    for (let i = 0; i < BIDDERS.length; i++) {
      windows.push(await launchTiledPage(BIDDERS[i].name, i + 1, screen));
    }

    const [seller, ...bidderWindows] = windows;
    await selectUser(seller.page, SELLER.id, 'North Loop Compute');
    const { slug, closingAt } = await createAuction(seller.page);

    for (let i = 0; i < bidderWindows.length; i++) {
      await bidderWindows[i].page.goto(`${BASE_URL}/auctions/${encodeURIComponent(slug)}`, {
        waitUntil: 'domcontentloaded',
      });
      await selectUser(bidderWindows[i].page, BIDDERS[i].id, BIDDERS[i].name);
      await assertActiveUser(bidderWindows[i].page, BIDDERS[i].id, BIDDERS[i].name);
      await bidderWindows[i].page.waitForSelector('#bid');
      console.log(`[bidding-war] window ${BIDDERS[i].name} signed in as ${BIDDERS[i].name}`);
    }
    await seller.page.goto(`${BASE_URL}/auctions/${encodeURIComponent(slug)}`, {
      waitUntil: 'domcontentloaded',
    });
    await selectUser(seller.page, SELLER.id, 'North Loop Compute');
    await assertActiveUser(seller.page, SELLER.id, 'North Loop Compute');

    const detailPages = windows.map((w) => w.page);
    for (const win of windows) {
      guards.push(attachNavigationGuard(win.page, win.label));
    }
    for (const guard of guards) guard.reset();

    const signedIn = await Promise.all(
      bidderWindows.map(async (win) =>
        (await win.page.locator('.header-active-user strong').textContent())?.trim()
      )
    );
    assert.equal(new Set(signedIn).size, BIDDERS.length, `bidders must be distinct, got ${signedIn.join(', ')}`);
    console.log(`[bidding-war] distinct bidders: ${signedIn.join(' | ')}`);

    // Wave 1: simultaneous same amount — protection allows at most one acceptance.
    console.log('[bidding-war] simultaneous wave @ $101.00 (expect one accept)');
    await simultaneousWave(
      bidderWindows.map((w) => w.page),
      '101.00'
    );
    await waitForLivePrice(detailPages, '101.00');
    await waitForLiveHistoryMin(detailPages, 1);
    for (const guard of guards) guard.assertNone('post wave-1 live sync');
    console.log('[bidding-war] all windows show $101.00 via Socket.IO (no reload)');

    // Wave 2: staggered climbs so learners see sequential activity too.
    console.log('[bidding-war] staggered bids');
    await placeBidUi(bidderWindows[0].page, '110.00');
    await waitForLivePrice(detailPages, '110.00');
    await sleep(200);
    await placeBidUi(bidderWindows[1].page, '120.00');
    await waitForLivePrice(detailPages, '120.00');
    await sleep(200);
    await placeBidUi(bidderWindows[2].page, '130.00');
    await waitForLivePrice(detailPages, '130.00');
    await waitForLiveHistoryMin(detailPages, 2);
    for (const guard of guards) guard.assertNone('post staggered live sync');
    console.log('[bidding-war] staggered climbs visible live across windows');

    // Wave 3: another simultaneous burst at the same amount.
    console.log('[bidding-war] second simultaneous wave @ $140.00 (expect one accept)');
    await simultaneousWave(
      bidderWindows.map((w) => w.page),
      '140.00'
    );
    await waitForLivePrice(detailPages, '140.00');
    for (const guard of guards) guard.assertNone('post wave-3 live sync');

    // Near-deadline attempts.
    const waitForNearEnd = Math.max(0, closingAt - Date.now() - 2500);
    console.log(`[bidding-war] waiting ${waitForNearEnd}ms for near-deadline bids`);
    await sleep(waitForNearEnd);
    console.log('[bidding-war] near-deadline simultaneous wave @ $150.00 (expect one accept)');
    await simultaneousWave(
      bidderWindows.map((w) => w.page),
      '150.00'
    );

    // Wait until closed via live countdown — no reload helpers.
    const waitForEnd = Math.max(0, closingAt - Date.now() + 800);
    await sleep(waitForEnd);
    console.log('[bidding-war] waiting for live ENDED (no reload)');
    await waitForEndedLive(detailPages);
    for (const guard of guards) guard.assertNone('ended via live countdown');
    console.log('[bidding-war] countdown shows ENDED in all windows without reload');

    const bids = await fetchBids(seller.page, slug);
    const dupes = duplicateAmounts(bids);
    const amounts = bids.map((b) => b.amountCents).sort((a, b) => a - b);
    console.log(
      `[bidding-war] ${bids.length} accepted bids; amounts=${amounts.join(', ') || '(none)'}; duplicates=${dupes.join(', ') || '(none)'}`
    );
    assert.equal(
      dupes.length,
      0,
      `protected bidding must not accept duplicate amounts; bids=${JSON.stringify(
        bids.map((b) => ({ amountCents: b.amountCents, bidder: b.bidder.displayName }))
      )}`
    );
    assert.ok(bids.length >= 1, 'expected at least one accepted bid');
    const bidderNames = [...new Set(bids.map((b) => b.bidder.displayName))];
    assert.ok(
      bidderNames.length >= 2,
      `expected multiple distinct bidders in history, got ${bidderNames.join(', ')}`
    );
    console.log(`[bidding-war] accepted bid bidders: ${bidderNames.join(' | ')}`);

    // Late bid after close must be rejected.
    const late = await seller.page.request.post(
      `${BASE_URL}/api/auctions/${encodeURIComponent(slug)}/bids`,
      {
        data: { bidderId: BIDDERS[0].id, amountCents: (amounts.at(-1) ?? 10000) + 100 },
      }
    );
    const lateBody = await late.json();
    assert.equal(late.status(), 400, 'late bid must be rejected');
    assert.match(String(lateBody.error ?? ''), /ended/i);
    console.log(`[bidding-war] late bid rejected: ${lateBody.error}`);

    for (const win of bidderWindows) {
      const disabled = await win.page.getByRole('button', { name: /Place a bid/i }).isDisabled();
      assert.equal(disabled, true, `${win.label} bid button should be disabled when Ended/Closed`);
      const countdown = await win.page.locator('[data-testid="auction-countdown"]').textContent();
      assert.ok(
        countdown?.trim() === 'ENDED' || countdown?.trim() === 'CLOSED',
        `${win.label} countdown should be ENDED or CLOSED, got ${countdown}`
      );
    }
    console.log('[bidding-war] all bidder windows show ENDED/CLOSED with bidding disabled');

    console.log('[bidding-war] waiting for durable Closed outcome (winner recorded)');
    const closedAuction = await waitForClosedOutcome(seller.page, slug);
    const winnerId = closedAuction.winner.id;
    const winnerWindow = bidderWindows.find((win, index) => BIDDERS[index].id === winnerId);
    assert.ok(winnerWindow, `winner window not found for ${winnerId}`);
    const winnerName = BIDDERS.find((bidder) => bidder.id === winnerId)?.name ?? closedAuction.winner.displayName;
    console.log(
      `[bidding-war] closed outcome recorded: winner=${winnerName} amount=${closedAuction.winningAmountCents}`
    );

    await Promise.all(
      detailPages.map(async (page) => {
        await page.waitForFunction(
          () => {
            const countdown = document.querySelector('[data-testid="auction-countdown"]');
            const outcome = document.querySelector('[data-testid="auction-close-outcome"]');
            return countdown?.textContent?.trim() === 'CLOSED' && Boolean(outcome);
          },
          null,
          { timeout: 20_000 }
        );
      })
    );
    console.log('[bidding-war] all windows show CLOSED + close outcome panel');

    console.log('[bidding-war] waiting for seller auction-closed modal');
    const sellerPopup = await waitForCloseModal(seller.page, { role: 'seller', outcome: 'sold' });
    assert.equal(sellerPopup.title, 'Your auction closed');
    console.log(`[bidding-war] seller modal: "${sellerPopup.title}"`);

    console.log('[bidding-war] waiting for winner congratulations modal');
    const winnerPopup = await waitForCloseModal(winnerWindow.page, {
      role: 'winner',
      outcome: 'sold',
    });
    assert.equal(winnerPopup.title, 'You won this auction');
    console.log(`[bidding-war] winner modal (${winnerName}): "${winnerPopup.title}"`);

    console.log(`[bidding-war] PASS — holding windows open for ${HOLD_MS}ms`);
    await sleep(HOLD_MS);
  } finally {
    for (const guard of guards) guard.dispose();
    await Promise.allSettled(windows.map(async (win) => win.browser.close()));
  }
}

main().catch((error) => {
  console.error('[bidding-war] FAIL', error);
  process.exitCode = 1;
});
