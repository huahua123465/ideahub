import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import process from 'node:process';
import puppeteer from 'puppeteer';

const PORT=5181,BASE=`http://127.0.0.1:${PORT}`;
const modalShot=join(tmpdir(),'ideahub-idea-files-modal-1440.png');
const mobileShot=join(tmpdir(),'ideahub-idea-files-modal-390.png');
const shot=join(tmpdir(),'ideahub-idea-files-1440.png');
function portOpen(){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:PORT});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(800,()=>{socket.destroy();resolve(false);});});}
async function waitForServer(){for(let i=0;i<50;i++){if(await portOpen())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('UI server did not start');}

const temp=await mkdtemp(join(tmpdir(),'ideahub-idea-files-'));
const paths=[join(temp,'方案.pdf'),join(temp,'需求.docx'),join(temp,'数据.xlsx')];
await Promise.all(paths.map((path,index)=>writeFile(path,`idea attachment ${index}`)));
let server=null;
try{
  server=spawn(process.execPath,['scripts/serve-web.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,WEB_PORT:String(PORT)},stdio:'ignore'});
  await waitForServer();
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox']});
  try{
    const page=await browser.newPage();await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
    await page.goto(`${BASE}/?mock=1`,{waitUntil:'domcontentloaded'});await page.waitForSelector('#tab-pool');
    await page.click('#tab-pool');await page.waitForSelector('#v-pool.view.on');await page.click('#btnNew');
    await page.waitForSelector('#modal.on');
    assert.equal(await page.$eval('#fFiles',input=>input.accept),'.pdf,.doc,.docx,.xls,.xlsx');
    await (await page.$('#fFiles')).uploadFile(...paths);
    await page.waitForFunction(()=>document.querySelectorAll('.idea-pending-file').length===3);
    const modalLayout=await page.$eval('#modal',node=>{const box=node.getBoundingClientRect(),form=node.querySelector('.form');return{top:box.top,bottom:box.bottom,scrollable:form.scrollHeight>=form.clientHeight};});
    assert.ok(modalLayout.top>=0&&modalLayout.bottom<=900,modalLayout);assert.equal(modalLayout.scrollable,true);
    await page.screenshot({path:modalShot});
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    const mobile=await page.$eval('#modal',node=>{const box=node.getBoundingClientRect(),picker=node.querySelector('.idea-file-picker').getBoundingClientRect();return{left:box.left,right:box.right,top:box.top,bottom:box.bottom,pickerHeight:picker.height};});
    assert.ok(mobile.left>=0&&mobile.right<=390&&mobile.top>=0&&mobile.bottom<=844,mobile);assert.ok(mobile.pickerHeight>=44,mobile);
    await page.screenshot({path:mobileShot});await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
    await page.type('#fTitle','自测附件灵感');await page.type('#fBody','提交灵感时同时上传 PDF、Word 和 Excel 文件。');
    await page.click('#btnSubmit');await page.waitForSelector('#modal:not(.on)');
    await page.waitForFunction(()=>[...document.querySelectorAll('#poolGrid .idea-card')].some(card=>card.textContent.includes('自测附件灵感')));
    await page.evaluate(()=>[...document.querySelectorAll('#poolGrid .idea-card')].find(card=>card.textContent.includes('自测附件灵感'))?.click());
    await page.waitForSelector('#drawer.on .idea-drawer-file');
    const state=await page.evaluate(()=>({files:document.querySelectorAll('.idea-drawer-file').length,names:[...document.querySelectorAll('.idea-drawer-file>a:not(.idea-file-download)')].map(node=>node.textContent),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}));
    assert.equal(state.files,3);assert.deepEqual(state.names,['数据.xlsx','需求.docx','方案.pdf']);assert.equal(state.overflow,0);
    await page.screenshot({path:shot});
    console.log(`Idea file UI: create/upload/detail checks passed; screenshots ${modalShot}, ${mobileShot}, ${shot}`);
  }finally{await browser.close();}
}finally{
  if(server)server.kill();await rm(temp,{recursive:true,force:true});
}
