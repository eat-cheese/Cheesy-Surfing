import express from 'express';
import puppeteer from 'puppeteer-core';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Puppeteer globals
let browser = null;
let page = null;
let isInitializing = false;

async function initBrowser() {
  // Avoid races
  while (isInitializing) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (browser && page && !page.isClosed()) return { browser, page };

  try {
    isInitializing = true;
    if (browser) {
      try { await browser.close(); } catch (e) { console.warn('Error closing old browser:', e.message); }
    }

    console.log('Launching Chromium...');

    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: false, // IMPORTANT: set false if getDisplayMedia is blocked in headless; try first with false
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1280,720',
        // Screen capture / GPU flags — help with display capture & performance
        '--enable-usermedia-screen-capturing',
        '--allow-http-screen-capture',
        '--enable-experimental-web-platform-features',
        '--enable-gpu',
        '--enable-accelerated-2d-canvas',
        '--enable-gpu-rasterization',
        '--ignore-gpu-blacklist',
        '--use-gl=egl'
      ]
    });

    page = await browser.newPage();
    // Keep viewport modest for performance; you can change
    await page.setViewport({ width: 1280, height: 720 });

    // Navigate to an empty page (we'll reuse it)
    await page.goto('about:blank');

    console.log('Chromium launched and page ready');
    isInitializing = false;
    return { browser, page };
  } catch (err) {
    isInitializing = false;
    console.error('initBrowser error:', err);
    browser = null;
    page = null;
    throw err;
  }
}

// Helper: evaluate the sender-bridge on the page (we keep a small string)
const SENDER_BRIDGE = `
/*
  This runs inside the page context. It:
  - creates an RTCPeerConnection
  - captures the page as a MediaStream using .captureStream() or getDisplayMedia
  - adds the stream tracks to the pc and creates an offer
  - exposes createOffer() and setAnswer(answer) helpers on window.__webrtcBridge
*/

// Create a bridge object if missing
if (!window.__webrtcBridge) {
  window.__webrtcBridge = {
    pc: null,
    localStream: null,
    lastOffer: null,
    createOffer: async function() {
      if (this.pc) {
        try { this.pc.close(); } catch(e) {}
        this.pc = null;
      }
      this.pc = new RTCPeerConnection({
        iceServers: []
      });

      this.pc.oniceconnectionstatechange = () => {
        console.log('Sender pc ice connection state:', this.pc.iceConnectionState);
      };

      // Try capture strategies in order of preference
      const captureFallback = async () => {
        // 1) If the page has an element with captureStream (canvas/video), try capturing documentElement via captureStream (not standard everywhere)
        try {
          if (document.documentElement && document.documentElement.captureStream) {
            console.log('Using documentElement.captureStream()');
            return document.documentElement.captureStream(30);
          }
        } catch(e) { console.warn('documentElement.captureStream failed', e); }

        // 2) Try capture a specific canvas if you have one (user may adapt)
        try {
          const canvas = document.querySelector('canvas');
          if (canvas && canvas.captureStream) {
            console.log('Using canvas.captureStream()');
            return canvas.captureStream(30);
          }
        } catch(e) { console.warn('canvas.captureStream failed', e); }

        // 3) Last resort: try getDisplayMedia (may be blocked in headless)
        try {
          console.log('Trying navigator.mediaDevices.getDisplayMedia()');
          // userGesture requirement may block this in some environments
          return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        } catch(e) {
          console.error('getDisplayMedia failed:', e);
          throw e;
        }
      };

      // Acquire stream
      try {
        this.localStream = await captureFallback();
      } catch (err) {
        console.error('captureFallback failed:', err);
        throw err;
      }

      // Attach tracks to pc
      for (const t of this.localStream.getTracks()) {
        this.pc.addTrack(t, this.localStream);
      }

      // Optional: collect ICE candidates to local array (we'll not use trickle ICE)
      const candidates = [];
      this.pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          candidates.push(ev.candidate);
        }
      };

      // Create an offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Wait a short time to gather localDescription + candidates then return
      await new Promise(r => setTimeout(r, 500));
      this.lastOffer = {
        sdp: this.pc.localDescription.sdp,
        type: this.pc.localDescription.type,
        candidates
      };
      console.log('Created offer with sdp length', this.lastOffer.sdp.length);
      return this.lastOffer;
    },
    // used by server to set the remote answer
    setAnswer: async function(answer) {
      if (!this.pc) throw new Error('pc not initialized');
      await this.pc.setRemoteDescription(answer);
      console.log('Remote description (answer) set on sender pc');
      return true;
    }
  };
}
window.__webrtcBridge; // return the bridge object
`;

// Endpoint to get an SDP Offer from the page (server calls page.evaluate to run createOffer)
app.get('/webrtc/offer', async (req, res) => {
  try {
    await initBrowser();
    if (!page) throw new Error('No page available');
    // Inject the bridge if needed
    await page.evaluate(SENDER_BRIDGE);

    // Call createOffer inside the page
    const offer = await page.evaluate(async () => {
      try {
        const bridge = window.__webrtcBridge;
        const off = await bridge.createOffer();
        // Return a plain object serializable across protocol
        return { success: true, offer: off };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });

    if (!offer.success) {
      res.status(500).json({ success: false, error: offer.error || 'createOffer failed' });
      return;
    }

    // Return the offer (sdp + type). Candidates are included if any.
    res.json({ success: true, offer: offer.offer });
  } catch (err) {
    console.error('/webrtc/offer error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint for viewer to send back the SDP Answer (viewer posts answer object)
app.post('/webrtc/answer', async (req, res) => {
  try {
    const { answer } = req.body;
    if (!answer) return res.status(400).json({ success: false, error: 'missing answer' });

    await initBrowser();
    if (!page) throw new Error('No page available');

    // Evaluate in page to set the answer
    const ok = await page.evaluate(async (ans) => {
      try {
        // ans is an object with { type, sdp }
        const bridge = window.__webrtcBridge;
        if (!bridge) throw new Error('bridge missing');
        await bridge.setAnswer({ type: ans.type, sdp: ans.sdp });
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }, answer);

    if (!ok.success) {
      return res.status(500).json({ success: false, error: ok.error });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('/webrtc/answer error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await initBrowser();
  } catch (e) {
    console.error('Initial browser launch failed:', e);
  }
});
