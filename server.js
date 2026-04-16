const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const CONFIG = {
  firstPageUrl: 'https://smartvoice.shawbusiness.ca/auth/login/',
  username: process.env.ROGERS_USERNAME || '',
  password: process.env.ROGERS_PASSWORD || '',
  headless: true,
  userServicesUrl: 'https://smartvoice.shawbusiness.ca/user/user_services/?userId=6047698134%40shawbusiness.ca&type=CallControl',
  dashboardUrl: 'https://smartvoice.shawbusiness.ca/index/dashboard/'
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
      loginDiv.style.display = 'block';
      loginDiv.style.visibility = 'visible';
      loginDiv.style.opacity = '1';
    }

    ['username', 'password'].forEach((name) => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (el) {
        el.style.display = 'block';
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

async function getVisibleLoginElements(page) {
  console.log('[login] Locating visible login form...');

  const loginContainerCandidates = [
    page.locator('#login').first(),
    page.locator('form:has(input[name="username"])').first(),
    page.locator('body').first()
  ];

  for (const candidate of loginContainerCandidates) {
    try {
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      const usernameInput = candidate.locator('input[name="username"]').first();
      const passwordInput = candidate.locator('input[name="password"]').first();

      const userVisible = await usernameInput.isVisible().catch(() => false);
      const passVisible = await passwordInput.isVisible().catch(() => false);

      if (userVisible && passVisible) {
        let loginButton = candidate.getByRole('button', { name: 'Login' }).first();
        const buttonVisible = await loginButton.isVisible().catch(() => false);

        if (!buttonVisible) {
          loginButton = page.getByRole('button', { name: 'Login' }).first();
        }

        console.log('[login] Using visible login container.');
        return {
          usernameInput,
          passwordInput,
          loginButton
        };
      }
    } catch (e) {
      // continue
    }
  }

  throw new Error('Could not find a visible usable login form');
}

async function waitForAuthenticatedPage(page) {
  console.log('[login] Waiting for post login navigation...');

  await Promise.race([
    page.waitForURL('**/index/dashboard/**', { timeout: 60000 }),
    page.waitForURL('**/user/user_services/**', { timeout: 60000 }),
    page.waitForURL('**/assistant/login**', { timeout: 60000 }),
    page.waitForURL('**/auth/login/**', { timeout: 60000 })
  ]);

  const postLoginUrl = page.url();
  console.log('[login] Post login URL:', postLoginUrl);

  if (postLoginUrl.includes('/assistant/login') || postLoginUrl.includes('/auth/login/')) {
    throw new Error(`Login did not reach an authenticated page. Landed on: ${postLoginUrl}`);
  }
}

async function getPageDiagnostics(page, label) {
  const currentUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
  const serviceCardCount = await page.locator('.user_service_container').count().catch(() => 0);

  console.log(`[diag:${label}] URL:`, currentUrl);
  console.log(`[diag:${label}] Title:`, title);
  console.log(`[diag:${label}] Service card count:`, serviceCardCount);
  console.log(`[diag:${label}] Body text sample:`, bodyText.slice(0, 4000));
  console.log(`[diag:${label}] Body HTML sample:`, bodyHtml.slice(0, 4000));

  return {
    currentUrl,
    title,
    bodyText,
    bodyHtml,
    serviceCardCount
  };
}

async function pageLooksEmpty(page) {
  const diag = await getPageDiagnostics(page, 'emptiness-check');
  const hasMeaningfulText = diag.bodyText.trim().length > 20;
  const hasServiceCards = diag.serviceCardCount > 0;
  return !(hasMeaningfulText || hasServiceCards);
}

async function navigateToUserServices(page) {
  console.log('[services] Trying direct navigation to user services page...');
  await page.goto(CONFIG.userServicesUrl, {
    waitUntil: 'load',
    timeout: 60000
  });

  await wait(5000);

  let empty = await pageLooksEmpty(page);

  if (!empty) {
    console.log('[services] Direct user services page has content.');
    return;
  }

  console.log('[services] Direct page looks empty. Retrying once with reload...');
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await wait(5000);

  empty = await pageLooksEmpty(page);

  if (!empty) {
    console.log('[services] User services page has content after reload.');
    return;
  }

  console.log('[services] Still empty. Falling back to dashboard dropdown flow...');

  await page.goto(CONFIG.dashboardUrl, {
    waitUntil: 'load',
    timeout: 60000
  });

  await wait(3000);

  const userSelect = page.getByLabel('User', { exact: true });
  await userSelect.waitFor({ state: 'visible', timeout: 30000 });

  await page.waitForFunction(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    const sel = selects.find(s => {
      const label = s.labels && s.labels[0];
      return label && label.textContent && label.textContent.trim() === 'User';
    });
    return sel && sel.options.length > 1 && !sel.disabled;
  }, { timeout: 15000 });

  console.log('[services] Selecting user from dashboard: 1, User (6047698134)');
  await userSelect.selectOption({ label: '1, User (6047698134)' });

  await page.waitForURL('**/user/user_services/**', { timeout: 60000 });
  await page.waitForLoadState('load');
  await wait(5000);

  const finalEmpty = await pageLooksEmpty(page);
  if (finalEmpty) {
    throw new Error('User services page is still empty even after dashboard fallback');
  }

  console.log('[services] Dashboard fallback reached a populated user services page.');
}

async function ensureCallControlSelected(page) {
  const serviceType = page.locator('#serviceTypeSelect');

  const exists = await serviceType.count().catch(() => 0);
  if (!exists) {
    console.log('[services] No service type dropdown found. Continuing...');
    return;
  }

  console.log('[services] Ensuring Call Control is selected...');

  const currentValue = await serviceType.inputValue().catch(() => '');
  console.log('[services] Current serviceType value:', currentValue);

  if (currentValue !== 'CallControl') {
    await serviceType.selectOption('CallControl');
    await wait(3000);

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (e) {
      console.log('[services] networkidle did not happen after Call Control select. Continuing...');
    }

    await wait(2000);
  }

  console.log('[services] Call Control selection step complete.');
}

async function openHotelingModal(page) {
  console.log('[hoteling] Waiting for user services content to render...');

  await page.waitForLoadState('domcontentloaded');
  await wait(3000);

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (e) {
    console.log('[hoteling] networkidle did not happen, continuing...');
  }

  await wait(3000);

  await ensureCallControlSelected(page);

  const pageText = await page.locator('body').innerText().catch(() => '');
  console.log('[hoteling] Page text sample:', pageText.slice(0, 4000));

  const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
  console.log('[hoteling] Page HTML sample:', bodyHtml.slice(0, 4000));

  const serviceCards = page.locator('.user_service_container');
  const serviceCardCount = await serviceCards.count().catch(() => 0);
  console.log('[hoteling] Service card count:', serviceCardCount);

  const hotelingRow = page
    .locator('.user_service_container')
    .filter({ hasText: /Hoteling Guest/i });

  const hotelingAnywhere = page.locator('text=/Hoteling/i').first();
  const guestAnywhere = page.locator('text=/Guest/i').first();

  const hotelingRowCount = await hotelingRow.count().catch(() => 0);
  const hotelingAnywhereCount = await hotelingAnywhere.count().catch(() => 0);
  const guestAnywhereCount = await guestAnywhere.count().catch(() => 0);

  console.log('[hoteling] Matching row count:', hotelingRowCount);
  console.log('[hoteling] Hoteling text count:', hotelingAnywhereCount);
  console.log('[hoteling] Guest text count:', guestAnywhereCount);

  if (hotelingRowCount > 0) {
    await hotelingRow.first().waitFor({ state: 'visible', timeout: 30000 });
    await hotelingRow.first().getByRole('button', { name: 'Edit' }).click();
    return;
  }

  if (hotelingAnywhereCount > 0) {
    const container = hotelingAnywhere.locator('xpath=ancestor::*[contains(@class,"user_service_container")][1]');
    await container.waitFor({ state: 'visible', timeout: 30000 });
    await container.getByRole('button', { name: 'Edit' }).click();
    return;
  }

  throw new Error('Hoteling Guest section not found on the fully rendered user services page');
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

    const { usernameInput, passwordInput, loginButton } = await getVisibleLoginElements(page);

    console.log('[login] Filling credentials...');
    await usernameInput.fill(CONFIG.username);
    await passwordInput.fill(CONFIG.password);

    console.log('[login] Submitting...');
    await loginButton.click();

    await waitForAuthenticatedPage(page);

    await page.unroute('**/js/common.js**');
    console.log('[nav] common.js interception removed after login');

    await navigateToUserServices(page);

    console.log('[services] Current URL after navigation strategy:', page.url());

    await openHotelingModal(page);

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