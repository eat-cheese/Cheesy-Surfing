import express from "express";
import puppeteer from "puppeteer-core";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
app.use(express.static("public"));

let browser, page, initializing = false;

async function initBrowser(){
  if(initializing) await new Promise(r=>setTimeout(r,100));
  if(browser && page && !page.isClosed()) return {browser,page};
  initializing = true;
  try{
    if(browser) await browser.close().catch(()=>{});
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-gpu",
        "--ignore-gpu-blacklist",
        "--window-size=1280,720",
        "--use-gl=swiftshader" 
      ]
    });
    page = await browser.newPage();
    await page.setViewport({width:1280,height:720});
    await page.goto("https://google.com",{waitUntil:"domcontentloaded"});
    initializing = false;
    return {browser,page};
  } catch(e){
    initializing = false;
    throw e;
  }
}

app.get("/health",(req,res)=>res.send("ok"));

app.post("/api/navigate", async (req,res)=>{
  try{
    const {url} = req.body;
    await initBrowser();
    const u = /^https?:\/\//.test(url)?url:"https://"+url;
    await page.goto(u,{waitUntil:"domcontentloaded"});
    res.json({success:true,url:u});
  }catch(e){ res.status(500).json({success:false,error:e.message}); }
});

// --- WebRTC signaling support ---
const server = app.listen(PORT, ()=>console.log("Running on",PORT));
const wss = new WebSocketServer({server});

wss.on("connection", ws=>{
  ws.on("message", async msg=>{
    const data = JSON.parse(msg);
    if(data.type === "offer"){
      try{
        await initBrowser();
        const session = await page.target().createCDPSession();
        const answer = await session.send("Browser.createWebrtcAnswer",{offer:data.sdp});
        ws.send(JSON.stringify({type:"answer",sdp:answer}));
      }catch(e){
        ws.send(JSON.stringify({type:"error",message:e.message}));
      }
    }
  });
});

process.on("SIGINT", async()=>{
  await browser?.close().catch(()=>{});
  process.exit();
});
