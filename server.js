import express from 'express';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static('public'));

let browser, page, cdp;

async function initBrowser(){
  try{
    if(browser && page && !page.isClosed()) return;
    if(browser){ try{await browser.close()}catch{} }

    console.log('Launching browser...');

    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      headless: true,
      args:[
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=640,360',
        '--disable-web-security',
        '--single-process',
        '--no-zygote'
      ]
    });

    page = await browser.newPage();
    await page.setViewport({width:640,height:360});

    const client = await page.target().createCDPSession();
    cdp = client;

    await client.send('Page.enable');
    await client.send('Page.setLifecycleEventsEnabled',{enabled:true});
    await client.send('Page.startScreencast',{
      format:'jpeg',
      quality:50,
      maxWidth:640,
      maxHeight:360,
      everyNthFrame:2
    });

  }catch(err){
    console.error(err);
    browser = null;
    page = null;
    cdp = null;
  }
}

function sendBinary(ws,buffer){
  if(ws.readyState===1){ try{ws.send(buffer)}catch{} }
}

app.post('/api/navigate', async (req,res)=>{
  try{
    const {url} = req.body;
    await initBrowser();
    if(!page || page.isClosed()) await initBrowser();
    await page.goto(url.startsWith('http')?url:'https://'+url,{waitUntil:'domcontentloaded',timeout:20000});
    res.json({success:true,url});
  }catch(err){
    res.json({success:false,error:err.message});
  }
});

app.post('/api/back', async (req,res)=>{ await initBrowser(); try{await page.goBack({waitUntil:'domcontentloaded',timeout:15000});res.json({success:true})}catch(e){res.json({success:false})} });
app.post('/api/forward', async (req,res)=>{ await initBrowser(); try{await page.goForward({waitUntil:'domcontentloaded',timeout:15000});res.json({success:true})}catch(e){res.json({success:false})} });
app.post('/api/refresh', async (req,res)=>{ await initBrowser(); try{await page.reload({waitUntil:'domcontentloaded',timeout:15000});res.json({success:true})}catch(e){res.json({success:false})} });
app.get('/api/url', async (req,res)=>{ await initBrowser(); try{res.json({success:true,url:page.url()})}catch(e){res.json({success:false})} });

const server = app.listen(PORT, ()=>console.log('Server ready on',PORT));

// WebSocket streaming (binary JPEG frames)
const wss = new WebSocketServer({ server });

wss.on('connection', (ws)=>{
  console.log('Client connected');
  let active = true;

  (async()=>{
    await initBrowser();
    if(!cdp){
      console.log('No CDP session, closing client.');
      ws.close();
      return;
    }

    cdp.on('Page.screencastFrame', async (frame)=>{
      try{
        if(!active){ await cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}); return; }
        const buffer = Buffer.from(frame.data,'base64');
        sendBinary(ws, buffer);
        await cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId});
      }catch(e){}
    });

    ws.on('close', async()=>{
      active=false;
      try{await cdp.send('Page.stopScreencast')}catch{}
      try{await cdp.detach()}catch{}
      console.log('Client disconnected');
    });

    ws.on('error', ()=>active=false);
  })();
});
