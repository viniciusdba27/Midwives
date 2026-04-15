const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.status(200).send('Rogers Playwright service is running.');
});

app.post('/run', async (req, res) => {
  const targetHours = String(req.body?.hotelingHours || '').trim();

  if (!targetHours || isNaN(targetHours)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid hotelingHours' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // TODO:
    // 1. Go to Rogers landing page
    // 2. Click CLICK HERE
    // 3. Login
    // 4. Navigate to user calling features
    // 5. Open Hoteling Guest modal
    // 6. Fill Hours
    // 7. Save
    // 8. Verify

    // Temporary success response
    res.status(200).json({
      ok: true,
      message: `Would update Hoteling Guest hours to ${targetHours}`
    });
  } catch (error) {
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