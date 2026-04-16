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
  console.log('[nav] Setting up common.js route interception...');

  await page.route('**/js/common.js**', (route) => {
    console.log('[nav] Blocked common.js ->', route.request().url());
    route.abort();
  });

  console.log('[nav] Navigating to login page...');
  await page.goto(CONFIG.firstPageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  console.log('[nav] DOM loaded. Injecting banner removal...');

  await page.evaluate(() => {
    const banner = document.getElementById('banner-redirect-notice');
    if (banner) {
      banner.remove();
    }

    const loginDiv = document.getElementById('login');
    if (loginDiv) {
      loginDiv.classList.remove('banner-countdown-hidden');
      loginDiv.style.display = '';
      loginDiv.style.visibility = 'visible';
      loginDiv.style.opacity = '1';
    }

    ['username', 'password'].forEach((name) => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (el) {
        el.style.display = '';
        el.style.visibility = 'visible';
        el.style.opacity = '1';
      }
    });
  });

  console.log('[nav] JS injection complete.');
}

async function waitForLoginForm(page) {
  console.log('[login] Waiting for login form inputs to be interactable...');

  const usernameLocator = page.locator('input[name="username"]');
  const passwordLocator = page.locator('input[name="password"]');

  try {
    await usernameLocator.waitFor({ state: 'visible', timeout: 15000 });
    await passwordLocator.waitFor({ state: 'visible', timeout: 15000 });
  } catch (e) {
    console.log('[login] Inputs not visible yet. Running second reveal pass...');

    await page.evaluate(() => {
      const loginDiv = document.getElementById('login');
      if (loginDiv) {
        loginDiv.classList.remove('banner-countdown-hidden');
        loginDiv.style.display = 'block';
        loginDiv.style.visibility = 'visible';
        loginDiv.style.opacity = '1';
      }

      let el = document.querySelector('input[name="username"]');
      while (el && el !== document.body) {
        el.style.visibility = 'visible';
        el.style.opacity = '1';
        if (el.tagName === 'INPUT') {
          el.style.display = 'block';
        }
        el = el.parentElement;
      }

      let el2 = document.querySelector('input[name="password"]');
      while (el2 && el2 !== document.body) {
        el2.style.visibility = 'visible';
        el2.style.opacity = '1';
        if (el2.tagName === 'INPUT') {
          el2.style.display = 'block';
        }
        el2 = el2.parentElement;
      }
    });

    await usernameLocator.waitFor({ state: 'visible', timeout: 10000 });
    await passwordLocator.waitFor({ state: 'visible', timeout: 10000 });
  }

  const stillHidden = await page.evaluate(() => {
    const u = document.querySelector('input[name="username"]');
    if (!u) return true;
    const rect = u.getBoundingClientRect();
    return rect.width === 0 || rect.height === 0;
  });

  if (stillHidden) {
    throw new Error('Username input is still hidden after reveal attempts');
  }

  console.log('[login] Login form is ready.');
}

app.get('/', (req, res) => {
  res.send('Rogers Playwright service is running.');
});

app.post('/run', async (req, res) => {
  console.log('\n=== /run called ===');
  console.log('Body:', req.body);

  let browser;

  try {
    const hotelingHours = String(req.body?.hotelingHours || '').trim();

    if (!hotelingHours || isNaN(hotelingHours)) {
      throw new Error('Invalid hotelingHours: must be a number');
    }

    if (!CONFIG.username || !CONFIG.password) {
      throw new Error('Missing env vars: ROGERS_USERNAME or ROGERS_PASSWORD');
    }

    console.log('[config] Hours to apply:', hotelingHours);

    browser = await chromium.launch({
      headless: CONFIG.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
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

    await navigateToLegacyLogin(page);
    console.log('[nav] Current URL after navigation:', page.url());

    await waitForLoginForm(page);

    console.log('[login] Filling credentials...');
    await page.locator('input[name="username"]').fill(CONFIG.username);
    await page.locator('input[name="password"]').fill(CONFIG.password);

    console.log('[login] Submitting...');
    await page.getByRole('button', { name: 'Login' }).click();

    console.log('[dashboard] Waiting for dashboard URL...');
    await page.waitForURL('**/index/dashboard/**', { timeout: 60000 });
    console.log('[dashboard] Reached dashboard:', page.url());

    console.log('[user] Selecting user:', CONFIG.userOptionLabel);
    await page.getByLabel('User', { exact: true }).selectOption({
      label: CONFIG.userOptionLabel
    });

    console.log('[services] Waiting for user services page...');
    await page.waitForURL('**/user/user_services/**', { timeout: 60000 });

    const serviceType = page.locator('#serviceTypeSelect');
    if (await serviceType.count()) {
      console.log('[services] Selecting Call Control...');
      await serviceType.selectOption('CallControl');
      await wait(1500);
    }

    console.log('[hoteling] Locating Hoteling Guest row...');
    const hotelingRow = page
      .locator('.user_service_container')
      .filter({ hasText: 'Hoteling Guest' });

    await hotelingRow.waitFor({ state: 'visible', timeout: 30000 });
    await hotelingRow.getByRole('button', { name: 'Edit' }).click();

    console.log('[hoteling] Waiting for modal...');
    const modal = page
      .locator('.ui-dialog')
      .filter({ hasText: 'Hoteling Guest' });

    await modal.waitFor({ state: 'visible', timeout: 30000 });

    console.log('[hoteling] Setting hours to:', hotelingHours);
    const hoursInput = modal.getByRole('textbox', { name: 'Hours' });

    await hoursInput.click({ clickCount: 3 });
    await hoursInput.press('Backspace');
    await hoursInput.fill(hotelingHours);

    const typedValue = await hoursInput.inputValue();
    console.log('[hoteling] Confirmed value in field:', typedValue);

    if (typedValue !== hotelingHours) {
      throw new Error(
        `Hours field mismatch. Expected "${hotelingHours}", got "${typedValue}"`
      );
    }

    console.log('[hoteling] Saving...');
    await modal.getByRole('button', { name: 'Save' }).click();

    await modal.waitFor({ state: 'hidden', timeout: 15000 });

    console.log('=== SUCCESS ===\n');
    res.json({
      ok: true,
      message: `Updated Hoteling Guest hours to ${hotelingHours}`
    });
  } catch (error) {
    console.error('=== ERROR ===', error.message, '\n');
    res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
