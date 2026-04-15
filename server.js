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

// Improved banner bypass function
async function bypassRedirectBanner(page) {
  console.log('Attempting to bypass redirect banner and countdown...');

  try {
    // Small wait for page to start rendering the banner
    await page.waitForTimeout(800);

    // Try to click the legacy portal link
    const legacySelectors = [
      'text=CLICK HERE to access the legacy portal',
      '#legacyPortalButton',
      'a:has-text("CLICK HERE")',
      'a.notice-middle-text-link'
    ];

    let clicked = false;
    for (const selector of legacySelectors) {
      try {
        const element = page.locator(selector).first();
        if (await element.count() > 0) {
          await element.click({ timeout: 5000 });
          console.log(`Successfully clicked legacy link using: ${selector}`);
          clicked = true;
          break;
        }
      } catch (e) {
        // continue to next selector
      }
    }

    if (!clicked) {
      console.log('Legacy link not found - using JavaScript fallback');
    }

    // Strong JavaScript fallback: force hide banner and show login form
    await page.evaluate(() => {
      // Hide the entire redirect banner
      const banner = document.getElementById('banner-redirect-notice');
      if (banner) {
        banner.style.display = 'none';
        banner.remove();
      }

      // Show the login section
      const loginSection = document.getElementById('login');
      if (loginSection) {
        loginSection.classList.remove('banner-countdown-hidden');
        loginSection.style.display = 'block';
        loginSection.style.visibility = 'visible';
      }

      // Remove any anti-clickjack styles
      const antiClickjack = document.getElementById('antiClickjack');
      if (antiClickjack) antiClickjack.remove();

      // Extra cleanup - remove any overlays or hidden classes
      document.querySelectorAll('div[style*="display: none"]').forEach(el => {
        if (el.id === 'login' || el.classList.contains('main')) {
          el.style.display = 'block';
        }
      });
    });

    console.log('Banner bypass completed (click + JS fallback)');

    // Wait for the actual login form to appear
    await page.waitForSelector('input[name="username"]', {
      state: 'visible',
      timeout: 15000
    });

    console.log('✅ Legacy login form is visible and ready');
    return true;

  } catch (err) {
    console.warn('Banner bypass encountered an issue:', err.message);
    // Continue anyway - the form might still be accessible
    return false;
  }
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
      throw new Error('Missing environment variables: ROGERS_USERNAME or ROGERS_PASSWORD');
    }

    console.log('Hours to apply:', hotelingHours);

    browser = await chromium.launch({
      headless: CONFIG.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    console.log('Opening entry page...');
    await page.goto(CONFIG.firstPageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('Initial URL:', page.url());

    // === Bypass the countdown banner ===
    await bypassRedirectBanner(page);

    console.log('Filling login credentials...');
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

    console.log('Saving changes...');
    await modal.getByRole('button', { name: 'Save' }).click();
    await wait(2000);

    console.log('✅ SUCCESS');
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
