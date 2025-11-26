import express from 'express';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static('public'));

let browser = null;
let page = null;
let previousScreenshot = null;

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
        '--window-size=1280,720',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto('https://play.geforcenow.com', { waitUntil: 'domcontentloaded' });
  }
  return { browser, page };
}

// Get optimized screenshot with change detection
async function getOptimizedScreenshot() {
  try {
    const { page } = await initBrowser();
    
    // Take screenshot as buffer
    const screenshot = await page.screenshot({ 
      type: 'jpeg',
      quality: 50,
      optimizeForSpeed: true
    });

    // Compress further with sharp
    const compressed = await sharp(screenshot)
      .resize(1280, 720, { fit: 'contain' })
      .jpeg({ quality: 45, mozjpeg: true })
      .toBuffer();

    // Check if image changed significantly
    if (previousScreenshot) {
      const diff = Buffer.compare(
        compressed.slice(0, 1000), 
        previousScreenshot.slice(0, 1000)
      );
      if (diff === 0) {
        return null; // No change, don't send
      }
    }

    previousScreenshot = compressed;
    return compressed.toString('base64');
  } catch (error) {
    console.error('Screenshot error:', error);
    return null;
  }
}

// API endpoints
app.post('/api/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    const { page } = await initBrowser();
    
    let finalUrl = url;
    if (!url.match(/^https?:\/\//)) {
      finalUrl = 'https://' + url;
    }
    
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    previousScreenshot = null; // Force update
    res.json({ success: true, url: finalUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/click', async (req, res) => {
  try {
    const { x, y } = req.body;
    const { page } = await initBrowser();
    await page.mouse.click(x, y);
    previousScreenshot = null; // Force update after interaction
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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

app.post('/api/scroll', async (req, res) => {
  try {
    const { deltaY } = req.body;
    const { page } = await initBrowser();
    await page.evaluate((delta) => {
      window.scrollBy(0, delta);
    }, deltaY);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/back', async (req, res) => {
  try {
    const { page } = await initBrowser();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    previousScreenshot = null;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/forward', async (req, res) => {
  try {
    const { page } = await initBrowser();
    await page.goForward({ waitUntil: 'domcontentloaded' });
    previousScreenshot = null;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const { page } = await initBrowser();
    await page.reload({ waitUntil: 'domcontentloaded' });
    previousScreenshot = null;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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

// WebSocket for streaming
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  let streaming = true;

  // Stream screenshots at 60 FPS
  const streamInterval = setInterval(async () => {
    if (!streaming) return;
    
    try {
      const screenshot = await getOptimizedScreenshot();
      if (screenshot && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'frame',
          data: screenshot
        }));
      }
    } catch (error) {
      console.error('Stream error:', error);
    }
  }, 16); // ~60 FPS (1000ms / 60 = 16.67ms)

  ws.on('close', () => {
    streaming = false;
    clearInterval(streamInterval);
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    streaming = false;
    clearInterval(streamInterval);
  });
});

// Cleanup
process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit();
});