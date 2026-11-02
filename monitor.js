const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ================== CONFIG ==================
const USERNAME = process.env.TM_USER || 'thevidu@gssintl.biz';
const PASSWORD = process.env.TM_PASS || '202561208202690Ts@@@@';

const DASHBOARD_URL = 'https://smart-prod.trax-cloud.com/leader-dashboard/dashboard';
const SCRIPT_PATH = path.join(__dirname, 'team-monitor.user.js');

const REDISPATCH_AFTER_MIN = 340; // next run eka queue karanawa
const EXIT_AFTER_MIN = 348;       // meka iwara wenawa (job timeout 355)
const CHECK_EVERY_MS = 60 * 1000;
const HEARTBEAT_EVERY = 5;        // minutes
// ============================================

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function screenshot(page, name) {
  try {
    fs.mkdirSync('debug', { recursive: true });
    await page.screenshot({ path: `debug/${name}-${Date.now()}.png`, fullPage: true });
  } catch (e) {}
}

async function needsLogin(page) {
  if (!page.url().includes('leader-dashboard')) return true;
  const n = await page.locator('input[type="password"]').count().catch(() => 0);
  return n > 0;
}

async function clickSubmit(page) {
  const candidates = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      return;
    }
  }
  await page.keyboard.press('Enter');
}

async function login(page) {
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  if (!(await needsLogin(page))) {
    log('Already logged in');
    return;
  }

  log('Logging in...');
  const userSel = [
    'input[type="email"]',
    'input[name="username"]',
    'input[name="email"]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[type="text"]',
  ].join(', ');

  const user = page.locator(userSel).first();
  await user.waitFor({ state: 'visible', timeout: 30000 });
  await user.fill(USERNAME);

  const pass = page.locator('input[type="password"]').first();
  if (!(await pass.isVisible().catch(() => false))) {
    // two-step login (username -> next -> password)
    await clickSubmit(page);
    await pass.waitFor({ state: 'visible', timeout: 30000 });
  }
  await pass.fill(PASSWORD);
  await clickSubmit(page);

  await page.waitForURL(/leader-dashboard/, { timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  log('Login OK:', page.url());
}

async function inject(page) {
  await page.evaluate(() => {
    const old = document.getElementById('tm-shadow-host');
    if (old) old.remove();
  });
  await page.addScriptTag({ url: 'https://code.jquery.com/jquery-3.7.1.min.js' });
  await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js' });
  await page.addScriptTag({ content: fs.readFileSync(SCRIPT_PATH, 'utf8') });
  log('Userscript injected');
}

async function setup(page) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      await login(page);
      await inject(page);
      return;
    } catch (e) {
      lastErr = e;
      log(`Setup attempt ${i} failed:`, e.message);
      await screenshot(page, `setup-fail-${i}`);
      await sleep(5000);
    }
  }
  throw lastErr;
}

async function getInfo(page) {
  return page.evaluate(() => {
    const host = document.getElementById('tm-shadow-host');
    const r = host && host.shadowRoot;
    if (!r) return null;
    const g = s => (r.querySelector(s) || {}).textContent || '';
    return { ts: g('.tm-ts'), fb: g('#tm-fbstat'), proj: g('.tm-projstat') };
  });
}

function dispatchNextRun() {
  try {
    const ref = process.env.GITHUB_REF_NAME || 'main';
    execSync(`gh workflow run monitor.yml --ref ${ref}`, { stdio: 'inherit' });
    log('Next run queued');
  } catch (e) {
    log('Could not queue next run:', e.message);
  }
}

(async () => {
  const start = Date.now();
  let dispatched = false;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1500, height: 900 },
    permissions: ['notifications'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => log('pageerror:', e.message));

  await setup(page);

  let tick = 0;
  while (true) {
    const elapsedMin = (Date.now() - start) / 60000;
    if (elapsedMin >= EXIT_AFTER_MIN) break;

    if (!dispatched && elapsedMin >= REDISPATCH_AFTER_MIN) {
      dispatchNextRun();
      dispatched = true;
    }

    await sleep(CHECK_EVERY_MS);
    tick++;

    try {
      const info = await getInfo(page);
      const sessionBad = await needsLogin(page);
      const apiDead = info && /^\s*0\//.test(info.proj);

      if (!info || sessionBad || apiDead) {
        log('Problem detected (session/UI/API). Re-setup...', { info, sessionBad });
        await setup(page);
        continue;
      }
      if (tick % HEARTBEAT_EVERY === 0) {
        log(`Heartbeat | last refresh: ${info.ts} | firebase: ${info.fb} | projects: ${info.proj}`);
      }
    } catch (e) {
      log('Loop error:', e.message);
      await screenshot(page, 'loop-error');
      try { await setup(page); } catch (e2) { log('Recovery failed:', e2.message); }
    }
  }

  log('Time limit reached, closing.');
  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
