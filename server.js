const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const CONFIG = {
  firstPageUrl: 'https://smartvoice.shawbusiness.ca/auth/login/',
  username: process.env.ROGERS_USERNAME || '',
  password: process.env.ROGERS_PASSWORD || '',
  headless: true,
  userOptionLabel: '1, User (6047698134)'
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function navigateToLegacyLogin(page) {
  console.log('[nav] Blocking common.js...');

  await page.route('**/js/common.js**', (route) => {
    console.log('[nav] Blocked:', route.request().url());
    route.abort();
  });

  console.log('[nav] Navigating to login page...');
  await page.goto(CONFIG.firstPageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  console.log('[nav] Injecting banner removal...');
  await page.evaluate(() => {
    document.getElementById('banner-redirect-notice')?.remove();

    const loginDiv = document.getElementById('login');
    if (loginDiv) {
      loginDiv.classList.remove('banner-countdown-hidden');
      loginDiv.style.cssText += ';display:block!important;visibility:visible!important;opacity:1!important;';
    }

    ['username', 'password'].forEach(name => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (el) {
        el.style.cssText += ';display:block!important;visibility:visible!important;opacity:1!important;';
      }
    });
  });

  console.log('[nav] Done. URL:', page.url());
}

async function waitForLoginForm(page) {
  console.log('[login] Waiting for inputs...');

  const username = page.locator('input[name="username"]');
  const password = page.locator('input[name="password"]');

  try {
    await username.waitFor({ state: 'visible', timeout: 15000 });
    await password.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    console.log('[login] Second reveal pass...');
    await page.evaluate(() => {
      ['username', 'password'].forEach(name => {
        let el = document.querySelector(`input[name="${name}"]`);
        while (el && el !== document.body) {
          el.style.cssText += ';display:block!important;visibility:visible!important;opacity:1!important;';
          el.classList.forEach(c => {
            if (c.includes('hidden') || c.includes('collapse')) el.classList.remove(c);
          });
          el = el.parentElement;
        }
      });
    });
    await username.waitFor({ state: 'visible', timeout: 10000 });
    await password.waitFor({ state: 'visible', timeout: 10000 });
  }

  const zeroSize = await page.evaluate(() => {
    const el = document.querySelector('input[name="username"]');
    if (!el) return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 || r.height === 0;
  });
  if (zeroSize) throw new Error('Username input is zero-size after reveal attempts');

  console.log('[login] Form is ready.');
}

async function selectUserFromDashboard(page) {
  console.log('[dashboard] Waiting for user dropdown...');

  const userSelect = page.getByLabel('User', { exact: true });
  await userSelect.waitFor({ state: 'visible', timeout: 30000 });

  // Wait until the dropdown has options populated and is not disabled
  await page.waitForFunction(() => {
    const sel = [...document.querySelectorAll('select')]
      .find(s => s.labels?.[0]?.textContent?.trim() === 'User');
    return sel && sel.options.length > 1 && !sel.disabled;
  }, { timeout: 15000 });

  console.log('[dashboard] Selecting user:', CONFIG.userOptionLabel);
  await userSelect.selectOption({ label: CONFIG.userOptionLabel });

  console.log('[dashboard] Waiting for user services navigation...');
  await page.waitForURL('**/user/user_services/**', { timeout: 60000 });
  await page.waitForLoadState('domcontentloaded');

  console.log('[dashboard] Reached user services:', page.url());
}

async function selectCallControl(page) {
  const serviceType = page.locator('#serviceTypeSelect');

  if (!await serviceType.count()) {
    console.log('[services] No #serviceTypeSelect found — skipping.');
    return;
  }

  console.log('[services] Selecting Call Control...');
  await serviceType.selectOption('CallControl');

  // Wait for service containers to re-render
  await page.waitForFunction(() => {
    return document.querySelectorAll('.user_service_container').length > 0;
  }, { timeout: 15000 });

  await wait(500);
  console.log('[services] Call Control selected.');
}

app.get('/', (_req, res) => {
  res.send('Rogers Playwright service is running.');
});

app.post('/run', async (req, res) => {
  console.log('\n=== /run called ===');
  console.log('Body:', req.body);

  let browser;

  try {
    const hotelingHours = String(req.body?.hotelingHours ?? '').trim();
    if (!hotelingHours || isNaN(hotelingHours)) {
      throw new Error('Invalid hotelingHours: must be a number');
    }
    if (!CONFIG.username || !CONFIG.password) {
      throw new Error('Missing env vars: ROGERS_USERNAME or ROGERS_PASSWORD');
    }
    console.log('[config] Hours to apply:', hotelingHours);

    browser = await chromium.launch({
      headless: CONFIG.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // ── Login ────────────────────────────────────────────────────────────────
    await navigateToLegacyLogin(page);
    await waitForLoginForm(page);

    console.log('[login] Filling credentials...');
    await page.locator('input[name="username"]').fill(CONFIG.username);
    await page.locator('input[name="password"]').fill(CONFIG.password);

    console.log('[login] Submitting...');
    await page.getByRole('button', { name: 'Login' }).click();

    // ── Dashboard ────────────────────────────────────────────────────────────
    console.log('[dashboard] Waiting for dashboard...');
    await page.waitForURL('**/index/dashboard/**', { timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    console.log('[dashboard] Reached:', page.url());

    // ── Select user → triggers navigation to user services ───────────────────
    await selectUserFromDashboard(page);

    // ── Select Call Control ──────────────────────────────────────────────────
    await selectCallControl(page);

    // ── Open Hoteling Guest editor ───────────────────────────────────────────
    console.log('[hoteling] Locating Hoteling Guest row...');
    const hotelingRow = page
      .locator('.user_service_container')
      .filter({ hasText: 'Hoteling Guest' });

    const rowCount = await hotelingRow.count();
    if (rowCount === 0) {
      throw new Error(
        'Hoteling Guest row not found. ' +
        'Call Control may not have loaded, or the service is not assigned to this user.'
      );
    }

    await hotelingRow.waitFor({ state: 'visible', timeout: 15000 });
    await hotelingRow.getByRole('button', { name: 'Edit' }).click();

    // ── Modal ────────────────────────────────────────────────────────────────
    console.log('[hoteling] Waiting for modal...');
    const modal = page
      .locator('.ui-dialog')
      .filter({ hasText: 'Hoteling Guest' });
    await modal.waitFor({ state: 'visible', timeout: 30000 });

    // ── Set hours ────────────────────────────────────────────────────────────
    console.log('[hoteling] Setting hours to:', hotelingHours);
    const hoursInput = modal.getByRole('textbox', { name: 'Hours' });

    await hoursInput.click({ clickCount: 3 });
    await hoursInput.press('Backspace');
    await hoursInput.fill(hotelingHours);

    const typedValue = await hoursInput.inputValue();
    console.log('[hoteling] Field value confirmed:', typedValue);
    if (typedValue !== hotelingHours) {
      throw new Error(`Hours mismatch. Expected "${hotelingHours}", got "${typedValue}"`);
    }

    // ── Save ─────────────────────────────────────────────────────────────────
    console.log('[hoteling] Saving...');
    await modal.getByRole('button', { name: 'Save' }).click();
    await modal.waitFor({ state: 'hidden', timeout: 15000 });

    console.log('=== SUCCESS ===\n');
    res.json({ ok: true, message: `Updated Hoteling Guest hours to ${hotelingHours}` });

  } catch (error) {
    console.error('=== ERROR ===', error.message, '\n');
    res.status(500).json({ ok: false, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
