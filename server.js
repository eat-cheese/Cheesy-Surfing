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
let isInitializing = false;

// Initialize browser with better error handling
async function initBrowser() {
  // Prevent multiple initializations at once
  while (isInitializing) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  try {
    // Check if browser and page are still valid
    if (browser && page && !page.isClosed()) {
      return { browser, page };
    }

    isInitializing = true;
    console.log('Initializing browser...');

    // Close old browser if exists
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.log('Error closing old browser:', e.message);
      }
    }

    // Launch new browser
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
        '--disable-features=IsolateOrigins,site-per-process',
        '--single-process',
        '--no-zygote'
      ]
    });

    // Create new page
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    
    // Set a reasonable timeout
    page.setDefaultTimeout(10000);
    
    // Navigate to initial URL
    await page.goto('https://play.geforcenow.com', { 
      waitUntil: 'domcontentloaded',
      timeout: 15000 
    }).catch(err => {
      console.log('Initial navigation warning:', err.message);
    });

    console.log('Browser initialized successfully');
    isInitializing = false;
    return { browser, page };
    
  } catch (error) {
    isInitializing = false;
    console.error('Browser initialization failed:', error);
    browser = null;
    page = null;
    throw error;
  }
}

// Get optimized screenshot with better error handling
async function getOptimizedScreenshot() {
  try {
    await initBrowser();
    
    // Double check page is still valid
    if (!page || page.isClosed()) {
      console.log('Page is closed, reinitializing...');
      browser = null;
      page = null;
      await initBrowser();
    }

    // Take screenshot as buffer
    const screenshot = await page.screenshot({ 
      type: 'jpeg',
      quality: 40,
      optimizeForSpeed: true
    });

    // Compress further with sharp
    const compressed = await sharp(screenshot)
      .resize(1280, 720, { fit: 'contain' })
      .jpeg({ quality: 35, mozjpeg: true })
      .toBuffer();

    // Simple change detection - compare size
    if (previousScreenshot && Math.abs(compressed.length - previousScreenshot.length) < 1000) {
      return null; // Very similar frame, skip
    }

    previousScreenshot = compressed;
    return compressed.toString('base64');
    
  } catch (error) {
    console.error('Screenshot error:', error.message);
    
    // Reset browser on error
    browser = null;
    page = null;
    previousScreenshot = null;
    
    // Try to reinitialize
    try {
      await initBrowser();
    } catch (reinitError) {
      console.error('Failed to reinitialize:', reinitError.message);
    }
    
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

  // Stream screenshots at 30 FPS (more stable than 60)
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
      console.error('Stream error:', error.message);
    }
  }, 33); // ~30 FPS (1000ms / 30 = 33ms) - more stable than 60

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

// Cleanup with better error handling
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try {
    if (browser) await browser.close();
  } catch (e) {
    console.log('Error during shutdown:', e.message);
  }
  process.exit();
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});