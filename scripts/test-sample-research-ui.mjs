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
const inlineShot=join(tmpdir(),'ideahub-sample-research-inline-1440.png');
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
  await page.waitForFunction(()=>[...document.querySelectorAll('.element-review-filters button b')].reduce((sum,node)=>sum+Number(node.textContent||0),0)===30);
  state=await page.evaluate(()=>({
    dimensions:document.querySelectorAll('.dimension-card').length,
    focused:document.activeElement?.id,
    panels:document.querySelectorAll('[role="tabpanel"]').length,
    tabs:document.querySelectorAll('.research-tabs [role="tab"]').length,
    trendTab:document.querySelector('[data-research-tab="trend"]')!==null,
    pending:Number(document.querySelector('[data-element-status-filter="pending"] b')?.textContent),
    confirmed:Number(document.querySelector('[data-element-status-filter="confirmed"] b')?.textContent),
  }));
  assert.deepEqual(state,{dimensions:10,focused:'sampleResearchTab-elements',panels:1,tabs:3,trendTab:false,pending:10,confirmed:5});
  await page.click('[data-element-status-filter="all"]');await page.waitForFunction(()=>document.querySelectorAll('.dimension-card').length===15);
  // The inline preview fallback stays readable if detail focus mode is absent or temporarily restored late.
  state=await page.evaluate(()=>{const root=document.querySelector('#v-samples');root.classList.remove('samples-detail-mode');const grid=document.querySelector('.dimension-groups>section>div'),tags=document.querySelector('.dimension-tags'),pills=[...document.querySelectorAll('.dimension-tags label i')];return{columns:getComputedStyle(grid).gridTemplateColumns,tagColumns:getComputedStyle(tags).gridTemplateColumns,verticalPill:pills.some(node=>node.getBoundingClientRect().height>node.getBoundingClientRect().width*1.6)};});
  assert.equal(state.columns.split(' ').length,1,JSON.stringify(state));assert.equal(state.tagColumns.split(' ').length,2,JSON.stringify(state));assert.equal(state.verticalPill,false,JSON.stringify(state));
  await page.$eval('.dimension-groups',node=>node.scrollIntoView({block:'start'}));
  await page.screenshot({path:inlineShot});
  await page.evaluate(()=>document.querySelector('#v-samples').classList.add('samples-detail-mode'));
  state=await page.evaluate(()=>{const visible=node=>getComputedStyle(node).display!=='none'&&node.getBoundingClientRect().width>0,workspace=document.querySelector('.samples-workspace'),rail=document.querySelector('.samples-list-column'),detail=document.querySelector('.samples-detail'),card=document.querySelector('.sample-card'),sticky=document.querySelector('.research-sticky'),tags=document.querySelector('.research-tag-editor');return{overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,focusNav:visible(document.querySelector('.samples-focus-nav')),pageHead:visible(document.querySelector('.samples-page-head')),railWidth:rail.getBoundingClientRect().width,detailWidth:detail.getBoundingClientRect().width,cardHeight:card.getBoundingClientRect().height,workspaceHeight:workspace.getBoundingClientRect().height,sticky:getComputedStyle(sticky).position,groups:document.querySelectorAll('.dimension-groups>section').length,tagsOpen:tags?.open,sequence:document.querySelectorAll('.research-sequence button').length};});
  const layoutEvidence=JSON.stringify(state);assert.equal(state.overflow,0,layoutEvidence);assert.equal(state.focusNav,true,layoutEvidence);assert.equal(state.pageHead,false,layoutEvidence);assert.ok(state.detailWidth/state.railWidth>=2.4,layoutEvidence);assert.ok(state.cardHeight<=82,layoutEvidence);assert.ok(state.workspaceHeight>=760,layoutEvidence);assert.equal(state.sticky,'sticky',layoutEvidence);assert.equal(state.groups,3,layoutEvidence);assert.equal(state.tagsOpen,false,layoutEvidence);assert.equal(state.sequence,2,layoutEvidence);
  await page.click('[data-sample-nav-toggle]');await page.waitForSelector('#v-samples.samples-nav-collapsed');
  assert.ok(await page.$eval('.samples-list-column',node=>node.getBoundingClientRect().width)<=80);
  await page.click('[data-sample-nav-toggle]');
  await page.screenshot({path:desktopShot});

  // A single dimension can be regenerated without clearing the other review decisions.
  const partialVersionsBefore=await page.$$eval('#sampleAnalysisVersion option',nodes=>nodes.length);
  await page.$eval('.dimension-card .dimension-ai-rerun',node=>node.click());
  await page.waitForFunction(before=>document.querySelectorAll('#sampleAnalysisVersion option').length===before+1,
    {timeout:5000},partialVersionsBefore);
  await page.waitForFunction(()=>Number(document.querySelector('[data-element-status-filter="pending"] b')?.textContent)===11
    &&Number(document.querySelector('[data-element-status-filter="confirmed"] b')?.textContent)===4,{timeout:5000});
  state=await page.evaluate(()=>(
    {pending:Number(document.querySelector('[data-element-status-filter="pending"] b')?.textContent),
      confirmed:Number(document.querySelector('[data-element-status-filter="confirmed"] b')?.textContent),
      cards:document.querySelectorAll('.dimension-card').length,
      version:document.querySelector('#sampleAnalysisVersion option:checked')?.textContent,
      provenance:document.querySelector('.analysis-provenance')?.textContent}));
  assert.equal(state.pending,11);assert.equal(state.confirmed,4);assert.equal(state.cards,11);
  assert.match(state.version,/AI 单项重拆/);assert.match(state.provenance,/其余继承 v1/);
  await page.click('[data-element-status-filter="all"]');
  await page.waitForFunction(()=>document.querySelectorAll('.dimension-card').length===15);

  // AI jobs are visible immediately and create a new selected version without double submit.
  const versionsBefore=await page.$$eval('#sampleAnalysisVersion option',nodes=>nodes.length);
  await page.evaluate(()=>{globalThis.__IDEAHUB_MOCK_FAILURES__={'GET */analysis-jobs/*':{remaining:1,status:503,message:'任务状态临时不可用'}};});
  await page.waitForFunction(()=>document.querySelector('[data-research-action="start-ai"]')&&!document.querySelector('[data-research-action="start-ai"]').disabled);
  await page.$eval('[data-research-action="start-ai"]',node=>node.click());
  await page.waitForSelector('.analysis-job');
  assert.equal(await page.$eval('[data-research-action="start-ai"]',node=>node.disabled),true);
  await page.waitForFunction(()=>document.querySelector('.research-inline-error')?.textContent.includes('自动重连'),{timeout:5000});
  await page.waitForFunction(before=>!document.querySelector('.analysis-job')&&document.querySelectorAll('#sampleAnalysisVersion option').length===before+1,{timeout:8000},versionsBefore);
  assert.equal(await page.$$eval('.dimension-card',nodes=>nodes.length),15);
  await page.click('.dimension-card [data-research-action="decision-confirm"]');
  await page.waitForFunction(()=>document.querySelectorAll('.dimension-card').length===14&&document.querySelector('.research-progress b')?.textContent==='1/15');
  await page.waitForFunction(()=>[...document.querySelectorAll('.sample-compact-meta b')].some(node=>/^1\/15/.test(node.textContent)));
  await page.click('[data-element-status-filter="confirmed"]');await page.waitForFunction(()=>document.querySelectorAll('.dimension-card').length===1);
  state=await page.$eval('.dimension-card',card=>({status:card.querySelector('header i')?.textContent,button:card.querySelector('[data-research-action="decision-confirm"]')?.textContent.trim(),disabled:card.querySelector('[data-research-action="decision-confirm"]')?.disabled}));
  assert.deepEqual(state,{status:'已确认',button:'✓ 已确认',disabled:true});
  await page.click('[data-element-status-filter="pending"]');

  // Leaving and returning resumes the same research controller.
  await page.click('#tab-home');
  await page.click('#tab-samples');
  await page.waitForSelector('.research-tabs');
  await page.click('[data-research-tab="elements"]');
  assert.equal(await page.$$eval('.dimension-card',nodes=>nodes.length),14);

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

  console.log(`Stage 2 UI: desktop/inline/mobile/filter/tabs/AI/lifecycle checks passed; screenshots ${desktopShot}, ${inlineShot}, ${mobileShot}`);
} finally {
  await browser.close();
  if(server)server.kill();
}
