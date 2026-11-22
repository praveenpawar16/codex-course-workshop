/**
 * Headed live-update check — two Edge windows on the same auction detail.
 * Bidder places a bid; watcher must update price + history without refresh.
 *
 * Env:
 *   LIVE_UPDATES_BASE_URL  default http://localhost:5108
 *   LIVE_UPDATES_HOLD_MS   keep windows open after assertions (default 20000)
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE_URL = process.env.LIVE_UPDATES_BASE_URL ?? 'http://localhost:5108';
const HOLD_MS = Number(process.env.LIVE_UPDATES_HOLD_MS ?? '20000');

const SELLER_ID = '11111111-1111-4111-a111-111111111107';
const BIDDER = {
  id: '11111111-1111-4111-a111-111111111101',
  name: 'Tensor Tamer',
};
const WATCHER = {
  id: '11111111-1111-4111-a111-111111111102',
  name: 'Thread Ripper',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function detectWorkArea() {
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

async function launchWindow(label, index, screen) {
  const halfW = Math.floor(screen.width / 2);
  const bounds = {
    x: screen.x + index * halfW,
    y: screen.y,
    width: halfW,
    height: screen.height,
  };
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
    console.log(`[live-updates] window bounds fallback for ${label}: ${error.message}`);
  }
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
    { id: userId, name: displayName }
  );
}

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`);
  assert.equal(health.ok, true, 'Part 6 must be running with Redis healthy');
  const healthBody = await health.json();
  assert.equal(healthBody.redis, 'ok', 'Redis must be ok');

  const create = await fetch(`${BASE_URL}/api/auctions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sellerId: SELLER_ID,
      title: `Live Updates Lot ${Date.now()}`,
      category: 'Networking',
      description: 'Realtime detail fan-out verification.',
      condition: 'Used',
      location: 'Lab',
      startingPriceCents: 10000,
      closingTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  assert.equal(create.status, 201);
  const { auction } = await create.json();
  const detailUrl = `${BASE_URL}/auctions/${auction.slug}`;
  const amount = ((auction.minimumBidCents ?? 10100) / 100).toFixed(2);

  const screen = await detectWorkArea();
  const bidder = await launchWindow('bidder', 0, screen);
  const watcher = await launchWindow('watcher', 1, screen);

  try {
    await bidder.page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    await watcher.page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    await selectUser(bidder.page, BIDDER.id, BIDDER.name);
    await selectUser(watcher.page, WATCHER.id, WATCHER.name);

    await watcher.page.getByText('$100.00').first().waitFor();

    await bidder.page.locator('#bid').fill(amount);
    await bidder.page.getByRole('button', { name: /place a bid/i }).click();
    await bidder.page.locator('.current-price strong').getByText(`$${amount}`).waitFor();

    await watcher.page.locator('.current-price strong').getByText(`$${amount}`).waitFor({
      timeout: 10_000,
    });
    await watcher.page.locator('[data-testid="bid-history-list"] li').first().waitFor({
      timeout: 10_000,
    });
    const historyCount = await watcher.page.locator('[data-testid="bid-history-list"] li').count();
    assert.ok(historyCount >= 1, 'watcher bid history should update without refresh');

    console.log('Live updates assertion passed.');
    await sleep(HOLD_MS);
  } finally {
    await bidder.browser.close();
    await watcher.browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
