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

async function forceClickLegacy(page) {
  console.log('Force clicking CLICK HERE aggressively...');

  const start = Date.now();
  const maxTime = 15000;

  while (Date.now() - start < maxTime) {
    try {
      await Promise.race([
        page.locator('text=CLICK HERE').first().click({ timeout: 500 }),
        page.getByRole('link', { name: /CLICK HERE/i }).click({ timeout: 500 }),
        page.locator('a:has-text("CLICK HERE")').first().click({ timeout: 500 })
      ]).catch(() => {});

      const url = page.url();

      if (url.includes('/auth/login') || url.includes('/login')) {
        console.log('Navigation detected after CLICK HERE');
        return true;
      }
    } catch (e) {
      // keep trying
    }

    await page.waitForTimeout(200);
  }

  console.log('Failed to click CLICK HERE in time');
  return false;
}

app.get('/', (req, res) => {
  res.send('Rogers Playwright service is running.');
});

app.post('/run', async (req, res) => {
  console.log('RUN endpoint HIT');
  console.log('Body:', req.body);

  let browser;

  try {
    const hotelingHours = String(req.body?.hotelingHours || '').trim();

    if (!hotelingHours || isNaN(hotelingHours)) {
      throw new Error('Invalid hotelingHours');
    }

    if (!CONFIG.username || !CONFIG.password) {
      throw new Error('Missing Cloud Run environment variables: ROGERS_USERNAME or ROGERS_PASSWORD');
    }

    console.log('Hours to apply:', hotelingHours);

    browser = await chromium.launch({
      headless: CONFIG.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    console.log('Opening entry page...');
    await page.goto(CONFIG.firstPageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('Initial URL:', page.url());

    await forceClickLegacy(page);

    console.log('Waiting for login page...');
    await page.waitForURL('**/auth/login/**', { timeout: 60000 });

    console.log('Login page URL:', page.url());

    console.log('Filling login...');
    await page.locator('input[name="username"]').fill(CONFIG.username);
    await page.locator('input[name="password"]').fill(CONFIG.password);

    console.log('Submitting login...');
    await page.getByRole('button', { name: 'Login' }).click();

    console.log('Waiting for dashboard...');
    await page.waitForURL('**/index/dashboard/**', { timeout: 60000 });

    console.log('Selecting user...');
    await page.getByLabel('User', { exact: true }).selectOption({
      label: CONFIG.userOptionLabel
    });

    console.log('Waiting for user services page...');
    await page.waitForURL('**/user/user_services/**', { timeout: 60000 });

    const serviceType = page.locator('#serviceTypeSelect');

    if (await serviceType.count()) {
      console.log('Selecting Call Control...');
      await serviceType.selectOption('CallControl');
      await wait(1500);
    }

    console.log('Opening Hoteling Guest editor...');
    const hotelingRow = page
      .locator('.user_service_container')
      .filter({ hasText: 'Hoteling Guest' });

    await hotelingRow.getByRole('button', { name: 'Edit' }).click();

    console.log('Waiting for Hoteling Guest modal...');
    const modal = page
      .locator('.ui-dialog')
      .filter({ hasText: 'Hoteling Guest' });

    await modal.waitFor({ state: 'visible', timeout: 60000 });

    console.log('Setting hours...');
    const hoursInput = modal.getByRole('textbox', { name: 'Hours' });

    await hoursInput.fill('');
    await hoursInput.fill(hotelingHours);

    const typedValue = await hoursInput.inputValue();
    console.log('Typed value:', typedValue);

    if (typedValue !== hotelingHours) {
      throw new Error(`Hours mismatch. Expected ${hotelingHours}, got ${typedValue}`);
    }

    console.log('Saving...');
    await modal.getByRole('button', { name: 'Save' }).click();

    await wait(2000);

    console.log('SUCCESS');

    res.json({
      ok: true,
      message: `Updated Hoteling Guest hours to ${hotelingHours}`
    });
  } catch (error) {
    console.error('ERROR:', error.message);

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
