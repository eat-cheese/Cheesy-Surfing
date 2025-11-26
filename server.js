import express from 'express';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static('public'));

let browser = null;
let page = null;

// Initialize browser
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto('https://play.geforcenow.com', { waitUntil: 'networkidle2' });
  }
  return { browser, page };
}

// API endpoint to navigate
app.post('/api/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    const { page } = await initBrowser();
    
    let finalUrl = url;
    if (!url.match(/^https?:\/\//)) {
      finalUrl = 'https://' + url;
    }
    
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    res.json({ success: true, url: finalUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to get screenshot (optimized for speed)
app.get('/api/screenshot', async (req, res) => {
  try {
    const { page } = await initBrowser();
    const screenshot = await page.screenshot({ 
      encoding: 'base64', 
      type: 'jpeg', 
      quality: 60,  // Lower quality for faster updates
      optimizeForSpeed: true
    });
    res.json({ success: true, screenshot: `data:image/jpeg;base64,${screenshot}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to click
app.post('/api/click', async (req, res) => {
  try {
    const { x, y } = req.body;
    const { page } = await initBrowser();
    await page.mouse.click(x, y);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to type
app.post('/api/type', async (req, res) => {
  try {
    const { text } = req.body;
    const { page } = await initBrowser();
    await page.keyboard.type(text);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to press key
app.post('/api/key', async (req, res) => {
  try {
    const { key } = req.body;
    const { page } = await initBrowser();
    await page.keyboard.press(key);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to go back
app.post('/api/back', async (req, res) => {
  try {
    const { page } = await initBrowser();
    await page.goBack({ waitUntil: 'networkidle2' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to go forward
app.post('/api/forward', async (req, res) => {
  try {
    const { page } = await initBrowser();
    await page.goForward({ waitUntil: 'networkidle2' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to refresh
app.post('/api/refresh', async (req, res) => {
  try {
    const { page } = await initBrowser();
    await page.reload({ waitUntil: 'networkidle2' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to get current URL
app.get('/api/url', async (req, res) => {
  try {
    const { page } = await initBrowser();
    const url = page.url();
    res.json({ success: true, url });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Virtual Browser running on port ${PORT}`);
  initBrowser().then(() => {
    console.log('Browser initialized');
  });
});

// Cleanup on exit
process.on('SIGINT', async () => {
  if (browser) {
    await browser.close();
  }
  process.exit();
});