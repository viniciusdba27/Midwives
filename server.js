const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const CONFIG = {
  firstPageUrl: 'https://voiceportal.shawbusiness.ca/assistant/login',
  username: process.env.ROGERS_USERNAME || '',
  password: process.env.ROGERS_PASSWORD || '',
  userOptionLabel: '1, User (6047698134)',
  sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/1xvK-sf6WGiCkD0vhi9CVjNTRtM2Hff7VjYTDxJ1IDzw/export?format=csv&gid=1144063531'
};

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getHoursFromSheet() {
  const res = await fetch(CONFIG.sheetCsvUrl);

  if (!res.ok) {
    throw new Error(`Failed to fetch sheet CSV. Status: ${res.status}`);
  }

  const text = await res.text();
  const lines = text.trim().split('\n');

  if (lines.length < 2) {
    throw new Error('Automation sheet CSV does not have enough rows.');
  }

  const row = lines[1].split(',');
  const value = String(row[1] || '').trim();

  if (!value || isNaN(value)) {
    throw new Error('Invalid HotelingHours value from sheet.');
  }

  return value;
}

app.get('/', (req, res) => {
  res.status(200).send('Rogers Playwright service is running.');
});

app.post('/run', async (req, res) => {
  let browser;

  try {
    if (!CONFIG.username || !CONFIG.password) {
      throw new Error('Missing Cloud Run environment variables: ROGERS_USERNAME or ROGERS_PASSWORD');
    }

    const requestedHours = String(req.body?.hotelingHours || '').trim();
    const newHours = requestedHours && !isNaN(requestedHours)
      ? requestedHours
      : await getHoursFromSheet();

    console.log(`Hours to apply: ${newHours}`);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    console.log('Opening landing page...');
    await page.goto(CONFIG.firstPageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('Clicking legacy portal link...');
    await page.getByText('CLICK HERE', { exact: true }).click();

    console.log('Waiting for login page...');
    await page.waitForURL('**/auth/login/**', { timeout: 60000 });

    console.log('Filling login...');
    await page.locator('input[name="username"]').fill(CONFIG.username);
    await page.locator('input[name="password"]').fill(CONFIG.password);

    console.log('Submitting login...');
    await page.getByRole('button', { name: 'Login' }).click();

    console.log('Waiting for dashboard...');
    await page.waitForURL('**/index/dashboard/**', { timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');

    console.log('Selecting user...');
    await page.getByLabel('User', { exact: true }).selectOption({ label: CONFIG.userOptionLabel });

    console.log('Waiting for user services page...');
    await page.waitForURL('**/user/user_services/**', { timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');

    const serviceType = page.locator('#serviceTypeSelect');
    if (await serviceType.count()) {
      console.log('Selecting Call Control...');
      await serviceType.selectOption('CallControl');
      await wait(1500);
    }

    console.log('Opening Hoteling Guest editor...');
    const hotelingRow = page.locator('.user_service_container').filter({ hasText: 'Hoteling Guest' });
    await hotelingRow.getByRole('button', { name: 'Edit' }).click();

    console.log('Waiting for Hoteling Guest modal...');
    const modal = page.locator('.ui-dialog').filter({ hasText: 'Hoteling Guest' });
    await modal.waitFor({ state: 'visible', timeout: 60000 });

    const hoursInput = modal.getByRole('textbox', { name: 'Hours' });
    await hoursInput.click();
    await hoursInput.fill('');
    await hoursInput.fill(newHours);

    const typedValue = await hoursInput.inputValue();

    if (typedValue !== newHours) {
      throw new Error(`Hours field verification failed. Expected ${newHours}, but found ${typedValue}`);
    }

    console.log('Saving modal...');
    await modal.getByRole('button', { name: 'Save' }).click();

    await wait(2000);

    res.status(200).json({
      ok: true,
      message: `Hoteling Guest hours updated to ${newHours}`
    });
  } catch (error) {
    console.error('Cloud Run failed:', error.message);

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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
