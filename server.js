const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json());

const CONFIG = {
  firstPageUrl: 'https://smartvoice.shawbusiness.ca/auth/login/',
  username: process.env.ROGERS_USERNAME || '',
  password: process.env.ROGERS_PASSWORD || '',
  headless: true,
  userServicesUrl: 'https://smartvoice.shawbusiness.ca/user/user_services/?userId=6047698134%40shawbusiness.ca&type=CallControl',
  dashboardUrl: 'https://smartvoice.shawbusiness.ca/index/dashboard/',
  appsScriptWebAppUrl: 'https://script.google.com/macros/s/AKfycbwuQfMkznzO-rJfeqZh6VafGl5-Sm6PjHfPVh2BC01yEgo-n4mWLeptuQg7mh0pZ-Qy/exec'
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveDebugArtifacts(page, label) {
  try {
    const ts = Date.now();
    const screenshotPath = `/tmp/${label}-${ts}.png`;
    const htmlPath = `/tmp/${label}-${ts}.html`;

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    fs.writeFileSync(htmlPath, html);

    console.log(`Saved screenshot: ${screenshotPath}`);
    console.log(`Saved html: ${htmlPath}`);
  } catch (e) {
    console.log(`Failed saving debug artifacts: ${e.message}`);
  }
}

async function navigateToLegacyLogin(page) {
  await page.route('**/js/common.js**', route => route.abort());

  await page.goto(CONFIG.firstPageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  await page.evaluate(() => {
    const banner = document.getElementById('banner-redirect-notice');
    if (banner) banner.remove();

    const loginDiv = document.getElementById('login');
    if (loginDiv) {
      loginDiv.classList.remove('banner-countdown-hidden');
      loginDiv.style.display = 'block';
      loginDiv.style.visibility = 'visible';
      loginDiv.style.opacity = '1';
    }

    ['username', 'password'].forEach(name => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (el) {
        el.style.display = 'block';
        el.style.visibility = 'visible';
        el.style.opacity = '1';
      }
    });
  });
}

async function waitForLoginForm(page) {
  const usernameLocator = page.locator('input[name="username"]');
  const passwordLocator = page.locator('input[name="password"]');

  try {
    await usernameLocator.waitFor({ state: 'visible', timeout: 15000 });
    await passwordLocator.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
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
        if (el.tagName === 'INPUT') el.style.display = 'block';
        el = el.parentElement;
      }

      let el2 = document.querySelector('input[name="password"]');
      while (el2 && el2 !== document.body) {
        el2.style.visibility = 'visible';
        el2.style.opacity = '1';
        if (el2.tagName === 'INPUT') el2.style.display = 'block';
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
}

async function getVisibleLoginElements(page) {
  const loginContainerCandidates = [
    page.locator('#login').first(),
    page.locator('form:has(input[name="username"])').first(),
    page.locator('body').first()
  ];

  for (const candidate of loginContainerCandidates) {
    try {
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) continue;

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

        return {
          usernameInput,
          passwordInput,
          loginButton
        };
      }
    } catch {
      // continue
    }
  }

  throw new Error('Could not find a visible usable login form');
}

async function waitForAuthenticatedPage(page) {
  await Promise.race([
    page.waitForURL('**/index/dashboard/**', { timeout: 60000 }),
    page.waitForURL('**/user/user_services/**', { timeout: 60000 }),
    page.waitForURL('**/assistant/login**', { timeout: 60000 }),
    page.waitForURL('**/auth/login/**', { timeout: 60000 })
  ]);

  const postLoginUrl = page.url();

  if (postLoginUrl.includes('/assistant/login') || postLoginUrl.includes('/auth/login/')) {
    throw new Error(`Login did not reach an authenticated page. Landed on: ${postLoginUrl}`);
  }
}

async function pageLooksEmpty(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const serviceCardCount = await page.locator('.user_service_container').count().catch(() => 0);
  const hasMeaningfulText = bodyText.trim().length > 20;
  const hasServiceCards = serviceCardCount > 0;
  return !(hasMeaningfulText || hasServiceCards);
}

async function navigateToUserServices(page) {
  await page.goto(CONFIG.userServicesUrl, {
    waitUntil: 'load',
    timeout: 60000
  });

  await wait(5000);

  let empty = await pageLooksEmpty(page);

  if (!empty) return;

  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await wait(5000);

  empty = await pageLooksEmpty(page);

  if (!empty) return;

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

  await userSelect.selectOption({ label: '1, User (6047698134)' });

  await page.waitForURL('**/user/user_services/**', { timeout: 60000 });
  await page.waitForLoadState('load');
  await wait(5000);

  const finalEmpty = await pageLooksEmpty(page);
  if (finalEmpty) {
    throw new Error('User services page is still empty even after dashboard fallback');
  }
}

async function ensureCallControlSelected(page) {
  const serviceType = page.locator('#serviceTypeSelect');

  const exists = await serviceType.count().catch(() => 0);
  if (!exists) return;

  const currentValue = await serviceType.inputValue().catch(() => '');

  if (currentValue !== 'CallControl') {
    await serviceType.selectOption('CallControl');
    await wait(3000);

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // continue
    }

    await wait(2000);
  }
}

async function openHotelingModal(page) {
  await page.waitForLoadState('domcontentloaded');
  await wait(3000);

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    // continue
  }

  await wait(3000);

  await ensureCallControlSelected(page);

  const hotelingRow = page
    .locator('.user_service_container')
    .filter({ hasText: /Hoteling Guest/i });

  const hotelingAnywhere = page.locator('text=/Hoteling/i').first();

  const hotelingRowCount = await hotelingRow.count().catch(() => 0);
  const hotelingAnywhereCount = await hotelingAnywhere.count().catch(() => 0);

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

async function runRogersUpdate(hotelingHours, dryRun, traceLabel) {
  let browser;
  let page;

  try {
    if (!hotelingHours || isNaN(hotelingHours)) {
      throw new Error('Invalid hotelingHours: must be a number');
    }

    if (!CONFIG.username || !CONFIG.password) {
      throw new Error('Missing env vars: ROGERS_USERNAME or ROGERS_PASSWORD');
    }

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

    page = await context.newPage();
    page.setDefaultTimeout(60000);

    console.log(`Run started. Label: ${traceLabel}. Dry run: ${dryRun}. Hours: ${hotelingHours}`);

    await navigateToLegacyLogin(page);
    await waitForLoginForm(page);

    const { usernameInput, passwordInput, loginButton } = await getVisibleLoginElements(page);

    await usernameInput.fill(CONFIG.username);
    await passwordInput.fill(CONFIG.password);
    await loginButton.click();

    await waitForAuthenticatedPage(page);

    await page.unroute('**/js/common.js**');

    await navigateToUserServices(page);
    await openHotelingModal(page);

    const modal = page
      .locator('.ui-dialog')
      .filter({ hasText: 'Hoteling Guest' });

    await modal.waitFor({ state: 'visible', timeout: 30000 });

    const hoursInput = modal.getByRole('textbox', { name: 'Hours' });

    await hoursInput.click({ clickCount: 3 });
    await hoursInput.press('Backspace');
    await hoursInput.fill(String(hotelingHours));

    const typedValue = await hoursInput.inputValue();

    if (typedValue !== String(hotelingHours)) {
      throw new Error(`Hours field mismatch. Expected "${hotelingHours}", got "${typedValue}"`);
    }

    if (dryRun) {
      console.log('Dry run completed successfully');
      return {
        ok: true,
        dryRun: true,
        message: `Dry run confirmed access to Hoteling Guest for hours ${hotelingHours}`
      };
    }

    await modal.getByRole('button', { name: 'Save' }).click();
    await modal.waitFor({ state: 'hidden', timeout: 15000 });

    console.log('Run completed successfully');

    return {
      ok: true,
      dryRun: false,
      message: `Updated Hoteling Guest hours to ${hotelingHours}`
    };
  } catch (error) {
    console.error('Run failed:', error.message);

    if (page) {
      await saveDebugArtifacts(page, 'run-error');
    }

    return {
      ok: false,
      error: error.message
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function callAppsScriptAction(action) {
  const response = await fetch(CONFIG.appsScriptWebAppUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = {
      ok: false,
      error: 'Apps Script response was not valid JSON',
      raw: text
    };
  }

  return {
    httpStatus: response.status,
    data
  };
}

app.get('/', (_req, res) => {
  res.send('Rogers Playwright service is running.');
});

/*
  Direct route. Keeps your existing manual test path.
*/
app.post('/run', async (req, res) => {
  const hotelingHours = String(req.body?.hotelingHours || '').trim();
  const dryRun = Boolean(req.body?.dryRun);
  const traceLabel = String(req.body?.traceLabel || '');

  const result = await runRogersUpdate(hotelingHours, dryRun, traceLabel);

  if (result.ok) {
    return res.status(200).json(result);
  }

  return res.status(500).json(result);
});

/*
  New orchestrator route.
  Cloud Scheduler should call THIS route.
*/
app.post('/orchestrate', async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim();

    if (!action) {
      return res.status(400).json({
        ok: false,
        error: 'Missing action'
      });
    }

    const allowedActions = ['precheck', 'execute', 'retry1', 'retry2'];

    if (!allowedActions.includes(action)) {
      return res.status(400).json({
        ok: false,
        error: `Invalid action: ${action}`
      });
    }

    console.log(`Orchestrate request received for action: ${action}`);

    const appsScriptResult = await callAppsScriptAction(action);

    console.log('Apps Script HTTP status:', appsScriptResult.httpStatus);
    console.log('Apps Script response:', JSON.stringify(appsScriptResult.data));

    if (appsScriptResult.httpStatus >= 200 && appsScriptResult.httpStatus < 300 && appsScriptResult.data.ok === true) {
      return res.status(200).json({
        ok: true,
        action,
        appsScript: appsScriptResult.data
      });
    }

    return res.status(500).json({
      ok: false,
      action,
      appsScriptHttpStatus: appsScriptResult.httpStatus,
      appsScript: appsScriptResult.data
    });
  } catch (error) {
    console.error('Orchestrate failed:', error.message);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});