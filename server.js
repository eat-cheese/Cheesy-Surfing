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

// Initialize browser safely (NO GUI ATTEMPT)
async function initBrowser() {
  while (isInitializing) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  try {
    if (browser && page && !page.isClosed()) {
      return { browser, page };
    }

    isInitializing = true;
    console.log('Initializing browser...');

    if (browser) {
      try { await browser.close(); } catch {}
    }

    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: true,
      args: [
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--mute-audio',
        '--window-size=640,360', // lighter resolution for CPU hosts
        '--disable-web-security',
        '--single-process',
        '--no-zygote'
      ]
    });

    page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });

    page.setDefaultTimeout(10000);

    await page.goto('https://google.com', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    }).catch(() => {});

    console.log('Browser initialized');
    isInitializing = false;
    return { browser, page };

  } catch (error) {
    isInitializing = false;
    browser = null;
    page = null;
    previousScreenshot = null;
    throw error;
  }
}

// Take optimized screenshot (returns base64 or null if too similar)
async function getOptimizedScreenshot() {
  try {
    await initBrowser();
    if (!page || page.isClosed()) {
      browser = null;
      page = null;
      await initBrowser();
    }

    const raw = await page.screenshot({ type: 'jpeg', quality: 35 });

    const compressed = await sharp(raw)
      .resize(640, 360, { fit: 'contain' })
      .jpeg({ quality: 30, mozjpeg: true })
      .toBuffer();

    if (previousScreenshot && Math.abs(compressed.length - previousScreenshot.length) < 500) {
      return null;
    }

    previousScreenshot = compressed;
    return compressed.toString('base64');

  } catch {
    browser = null;
    page = null;
    previousScreenshot = null;
    return null;
  }
}

// --- NORMAL API ENDPOINTS (NO WEBRTC ANYMORE) ---
app.post('/api/navigate', async (req, res) => {
  const { url } = req.body;
  try {
    await initBrowser();
    let safeUrl = url.match(/^https?:\/\//) ? url : 'https://' + url;
    await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    previousScreenshot = null;
    res.json({ success: true, url: safeUrl });
  } catch (e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

app.post('/api/click', async (req, res) => {
  const { x, y } = req.body;
  try {
    await initBrowser();
    await page.mouse.click(x, y);
    previousScreenshot = null;
    res.json({ success:true });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

app.post('/api/type', async (req, res) => {
  const { text } = req.body;
  try {
    await initBrowser();
    await page.keyboard.type(text);
    res.json({ success:true });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

app.post('/api/key', async (req, res) => {
  const { key } = req.body;
  try {
    await initBrowser();
    await page.keyboard.press(key);
    res.json({ success:true });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

app.post('/api/scroll', async (req, res) => {
  const { deltaY } = req.body;
  try {
    await initBrowser();
    await page.evaluate(d => window.scrollBy(0, d), deltaY);
    res.json({ success:true });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

app.post('/api/back', async (req,res)=>{
  try{ await initBrowser(); await page.goBack({waitUntil:'domcontentloaded'}); previousScreenshot=null; res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.post('/api/forward', async (req,res)=>{
  try{ await initBrowser(); await page.goForward({waitUntil:'domcontentloaded'}); previousScreenshot=null; res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.post('/api/refresh', async (req,res)=>{
  try{ await initBrowser(); await page.reload({waitUntil:'domcontentloaded'}); previousScreenshot=null; res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get('/api/url', async (req,res)=>{
  try{ await initBrowser(); res.json({success:true,url:page.url()}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

const server = app.listen(PORT, ()=>console.log(`Virtual Browser running on ${PORT}`));

// --- KEEP WS STREAMING, CAP TO 30FPS, NO IMAGE API ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws)=>{
  console.log("Client connected");
  const interval = setInterval(async ()=>{
    const frame = await getOptimizedScreenshot();
    if(frame && ws.readyState === 1){
      ws.send(JSON.stringify({ type:"frame", data:frame }));
    }
  }, 33);

  ws.on('close', ()=>{ clearInterval(interval); console.log("Client disconnected"); });
  ws.on('error', ()=>{ clearInterval(interval); });
});

// Final cleanup safety
process.on('SIGINT', async ()=>{
  try{ if(browser) await browser.close(); } catch{}
  process.exit();
});
