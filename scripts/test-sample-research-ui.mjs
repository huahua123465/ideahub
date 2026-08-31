import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import process from 'node:process';
import puppeteer from 'puppeteer';

const PORT=5173;
const BASE=`http://127.0.0.1:${PORT}`;
const desktopShot=join(tmpdir(),'ideahub-sample-research-focus-1440.png');
const mobileShot=join(tmpdir(),'ideahub-sample-research-focus-390.png');

function portOpen(){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:PORT});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(800,()=>{socket.destroy();resolve(false);});});}
async function waitForServer(){for(let i=0;i<50;i++){if(await portOpen())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('local UI server did not start');}

let server=null;
if(!await portOpen()){
  server=spawn(process.execPath,['scripts/serve-web.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,WEB_PORT:String(PORT)},stdio:'ignore'});
  await waitForServer();
}

const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox']});
try{
  const page=await browser.newPage();
  await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#tab-samples');
  await page.waitForSelector('#v-home h1');
  await page.click('#tab-samples');
  await page.waitForSelector('#v-samples .sample-card');

  let state=await page.evaluate(()=>({
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    cards:document.querySelectorAll('#v-samples .sample-card').length,
    intakeExpanded:document.querySelector('#samplesIntakeToggle')?.getAttribute('aria-expanded'),
  }));
  assert.deepEqual(state,{overflow:0,cards:2,intakeExpanded:'false'});

  // Cross-kind tags are ANDed and the card explains every match.
  await page.click('#sampleFiltersToggle');
  await page.waitForSelector('#sampleFilterBuilder:not([hidden])');
  for(const name of ['女性用户','关系判断需求','强结论标题','案例拆解结构']){
    const input=await page.$(`#sampleFilterBuilder input[type="checkbox"]`);
    assert.ok(input,'tag inputs should exist');
    await page.evaluate(label=>{const input=[...document.querySelectorAll('#sampleFilterBuilder label')].find(node=>node.textContent.includes(label))?.querySelector('input');input?.click();},name);
  }
  await page.waitForFunction(()=>document.querySelectorAll('#v-samples .sample-card').length===1);
  state=await page.evaluate(()=>({
    reasons:[...document.querySelectorAll('.sample-match-reasons span')].map(node=>node.textContent),
    cards:document.querySelectorAll('#v-samples .sample-card').length,
  }));
  assert.equal(state.cards,1);
  assert.deepEqual(state.reasons,['女性用户','关系判断需求','强结论标题','案例拆解结构']);

  // Keyboard opens a sample; research tabs expose exactly 15 dimensions.
  await page.focus('#v-samples .sample-card');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.research-tabs');
  await page.focus('#sampleResearchTab-original');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('.research-tabs [aria-selected="true"]')?.dataset.researchTab==='elements');
  state=await page.evaluate(()=>({
    dimensions:document.querySelectorAll('.dimension-card').length,
    focused:document.activeElement?.id,
    panels:document.querySelectorAll('[role="tabpanel"]').length,
    tabs:document.querySelectorAll('.research-tabs [role="tab"]').length,
    trendTab:document.querySelector('[data-research-tab="trend"]')!==null,
  }));
  assert.deepEqual(state,{dimensions:15,focused:'sampleResearchTab-elements',panels:1,tabs:3,trendTab:false});
  state=await page.evaluate(()=>{const visible=node=>getComputedStyle(node).display!=='none'&&node.getBoundingClientRect().width>0,workspace=document.querySelector('.samples-workspace'),rail=document.querySelector('.samples-list-column'),detail=document.querySelector('.samples-detail'),card=document.querySelector('.sample-card'),sticky=document.querySelector('.research-sticky'),tags=document.querySelector('.research-tag-editor');return{overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,focusNav:visible(document.querySelector('.samples-focus-nav')),pageHead:visible(document.querySelector('.samples-page-head')),railWidth:rail.getBoundingClientRect().width,detailWidth:detail.getBoundingClientRect().width,cardHeight:card.getBoundingClientRect().height,workspaceHeight:workspace.getBoundingClientRect().height,sticky:getComputedStyle(sticky).position,groups:document.querySelectorAll('.dimension-groups>section').length,tagsOpen:tags?.open,sequence:document.querySelectorAll('.research-sequence button').length};});
  const layoutEvidence=JSON.stringify(state);assert.equal(state.overflow,0,layoutEvidence);assert.equal(state.focusNav,true,layoutEvidence);assert.equal(state.pageHead,false,layoutEvidence);assert.ok(state.detailWidth/state.railWidth>=2.4,layoutEvidence);assert.ok(state.cardHeight<=82,layoutEvidence);assert.ok(state.workspaceHeight>=760,layoutEvidence);assert.equal(state.sticky,'sticky',layoutEvidence);assert.equal(state.groups,3,layoutEvidence);assert.equal(state.tagsOpen,false,layoutEvidence);assert.equal(state.sequence,2,layoutEvidence);
  await page.click('[data-sample-nav-toggle]');await page.waitForSelector('#v-samples.samples-nav-collapsed');
  assert.ok(await page.$eval('.samples-list-column',node=>node.getBoundingClientRect().width)<=80);
  await page.click('[data-sample-nav-toggle]');
  await page.screenshot({path:desktopShot});

  // AI jobs are visible immediately and create a new selected version without double submit.
  const versionsBefore=await page.$$eval('#sampleAnalysisVersion option',nodes=>nodes.length);
  await page.evaluate(()=>{globalThis.__IDEAHUB_MOCK_FAILURES__={'GET */analysis-jobs/*':{remaining:1,status:503,message:'任务状态临时不可用'}};});
  await page.waitForFunction(()=>document.querySelector('[data-research-action="start-ai"]')&&!document.querySelector('[data-research-action="start-ai"]').disabled);
  await page.$eval('[data-research-action="start-ai"]',node=>node.click());
  await page.waitForSelector('.analysis-job');
  assert.equal(await page.$eval('[data-research-action="start-ai"]',node=>node.disabled),true);
  await page.waitForFunction(()=>document.querySelector('.research-inline-error')?.textContent.includes('自动重连'),{timeout:5000});
  await page.waitForFunction(before=>!document.querySelector('.analysis-job')&&document.querySelectorAll('#sampleAnalysisVersion option').length===before+1,{timeout:8000},versionsBefore);

  // Leaving and returning resumes the same research controller.
  await page.click('#tab-home');
  await page.click('#tab-samples');
  await page.waitForSelector('.research-tabs');
  await page.click('[data-research-tab="elements"]');
  assert.equal(await page.$$eval('.dimension-card',nodes=>nodes.length),15);

  // Mobile uses an exclusive detail mode and all visible research controls are touch sized.
  await page.setViewport({width:390,height:844,deviceScaleFactor:1});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('#v-home h1');
  await page.click('#navToggle');
  await page.waitForSelector('#appNav.mobile-open');
  await page.click('#tab-samples');
  await page.waitForSelector('#v-samples .sample-card');
  await page.click('#v-samples .sample-card');
  await page.waitForSelector('.research-tabs');
  state=await page.evaluate(()=>{
    const visible=node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return box.width>0&&box.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0';};
    const controls=[...document.querySelectorAll('.research-head-actions button,.research-tabs button,.research-panel button,.research-panel select,.research-panel input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]),.research-panel summary,.research-panel a')].filter(visible);
    return{
      overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      detailMode:document.querySelector('#v-samples')?.classList.contains('samples-detail-mode'),
      minControl:Math.min(...controls.map(node=>node.getBoundingClientRect().height)),
      bodyFont:parseFloat(getComputedStyle(document.querySelector('.research-body')).fontSize),
    };
  });
  assert.equal(state.overflow,0);
  assert.equal(state.detailMode,true);
  assert.ok(state.minControl>=44,state);
  assert.ok(state.bodyFont>=14,state);
  await page.screenshot({path:mobileShot});

  console.log(`Stage 2 UI: desktop/mobile/filter/tabs/AI/lifecycle checks passed; screenshots ${desktopShot}, ${mobileShot}`);
} finally {
  await browser.close();
  if(server)server.kill();
}
