import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import process from 'node:process';
import puppeteer from 'puppeteer';

const PORT=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();probe.close(error=>error?reject(error):resolve(address.port));});});
const BASE=`http://127.0.0.1:${PORT}`;
const artifacts=await mkdtemp(join(tmpdir(),'ideahub-stage3-ui-'));

function portOpen(){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:PORT});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(800,()=>{socket.destroy();resolve(false);});});}
async function waitForServer(){for(let i=0;i<60;i++){if(await portOpen())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('local UI server did not start');}
async function openSamples(page){await page.waitForSelector('#v-home h1');const mobile=await page.evaluate(()=>innerWidth<=1180);if(mobile){await page.click('#navToggle');await page.waitForSelector('#appNav.mobile-open');}await page.click('#tab-samples');await page.waitForSelector('#v-samples .sample-card');}
async function selectSampleForComparison(page,id){await page.$eval(`[data-compare-toggle][value="${id}"]`,input=>input.click());}
async function setFault(page,pattern,{remaining=1,status=500,message='模拟故障',code='MOCK_FAILURE'}={}){await page.evaluate((key,value)=>{globalThis.__IDEAHUB_MOCK_FAILURES__={[key]:value};},pattern,{remaining,status,message,code});}
async function clearFaults(page){await page.evaluate(()=>{globalThis.__IDEAHUB_MOCK_FAILURES__={};});}

const server=spawn(process.execPath,['scripts/serve-web.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,WEB_PORT:String(PORT)},stdio:'ignore'});
await waitForServer();

const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox']});
try{
  const page=await browser.newPage();
  await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
  await page.goto(`${BASE}/?stage3=1&mock=1`,{waitUntil:'domcontentloaded'});
  await openSamples(page);

  let state=await page.evaluate(()=>({
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    modes:document.querySelectorAll('.sample-library-modes [role="tab"]').length,
    cards:document.querySelectorAll('#samplesList .sample-card').length,
    nativeCheckbox:document.querySelector('[data-compare-toggle]')?.tagName,
    trayHidden:document.querySelector('#sampleComparisonTray')?.hidden,
  }));
  assert.deepEqual(state,{overflow:0,modes:3,cards:24,nativeCheckbox:'INPUT',trayHidden:false});

  // One selection cannot start; two can. The second selection survives page changes.
  await selectSampleForComparison(page,1);
  state=await page.evaluate(()=>({count:document.querySelectorAll('#sampleComparisonTray [data-compare-remove]').length,disabled:document.querySelector('[data-compare-start]').disabled,research:!!document.querySelector('.research-tabs')}));
  assert.deepEqual(state,{count:1,disabled:true,research:false});
  await page.click('[data-sample-page="2"]');
  await page.waitForFunction(()=>document.querySelector('.samples-pager b')?.textContent.includes('2 / 2'));
  const secondPageId=await page.$eval('[data-compare-toggle]',node=>Number(node.value));
  await selectSampleForComparison(page,secondPageId);
  assert.equal(await page.$$eval('#sampleComparisonTray [data-compare-remove]',nodes=>nodes.length),2);
  await page.click('[data-sample-page="1"]');
  await page.waitForFunction(()=>document.querySelector('.samples-pager b')?.textContent.includes('1 / 2'));
  assert.equal(await page.$$eval('#sampleComparisonTray [data-compare-remove]',nodes=>nodes.length),2);
  await page.click(`[data-compare-remove="${secondPageId}"]`);

  // Six is allowed, the seventh checkbox is disabled, and opening a card is still independent.
  for(const id of [2,3,4,5,6])await selectSampleForComparison(page,id);
  state=await page.evaluate(()=>({count:document.querySelectorAll('#sampleComparisonTray [data-compare-remove]').length,startDisabled:document.querySelector('[data-compare-start]').disabled,seventhDisabled:document.querySelector('[data-compare-toggle][value="7"]').disabled}));
  assert.deepEqual(state,{count:6,startDisabled:false,seventhDisabled:true});
  await page.$eval('.sample-card[data-sample-id="7"]',node=>node.click());
  await page.waitForSelector('.research-tabs');
  assert.equal(await page.$eval('#sampleComparisonTray [data-compare-start]',node=>node.disabled),false);

  // Create a frozen comparison and enter the full-width workspace.
  await page.click('[data-compare-start]');
  await page.waitForSelector('#sampleComparisonCreateDialog[open]');
  await page.type('#sampleComparisonCreateForm [name="name"]','Stage 3 六篇样本比较');
  await page.type('#sampleComparisonCreateForm [name="topic"]','观察标题机制、内容结构与行动承接的局部差异');
  await page.click('#sampleComparisonCreateForm button[type="submit"]');
  await page.waitForSelector('.comparison-workspace .comparison-matrix-table');
  state=await page.evaluate(()=>{
    const scroll=document.querySelector('.comparison-matrix-scroll'),cells=[...document.querySelectorAll('.comparison-matrix-table thead th')].slice(1);
    return{overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,tabs:document.querySelectorAll('.comparison-tabs [role="tab"]').length,rows:document.querySelectorAll('.comparison-matrix-table tbody tr').length,columns:cells.length,cellMin:Math.min(...cells.map(node=>node.getBoundingClientRect().width)),internalScroll:scroll.scrollWidth>scroll.clientWidth,stickyHead:getComputedStyle(cells[0]).position,stickyRow:getComputedStyle(document.querySelector('.comparison-matrix-table tbody th')).position};
  });
  assert.equal(state.overflow,0);assert.equal(state.tabs,4);assert.equal(state.rows,15);assert.equal(state.columns,6);assert.ok(state.cellMin>=224,state);assert.equal(state.internalScroll,true);assert.equal(state.stickyHead,'sticky');assert.equal(state.stickyRow,'sticky');
  await page.click('.comparison-frozen-note summary');
  state=await page.evaluate(()=>({members:document.querySelectorAll('.comparison-frozen-grid article').length,coverage:document.querySelectorAll('.comparison-policy span').length,metricValues:document.querySelectorAll('.comparison-frozen-metrics span').length,text:document.querySelector('.comparison-frozen-note').textContent}));
  assert.equal(state.members,6);assert.equal(state.coverage,5);assert.equal(state.metricValues,30);assert.match(state.text,/样本量 6/);assert.match(state.text,/指标观察/);assert.match(state.text,/观察窗口/);assert.match(state.text,/—/);assert.match(state.text,/不同平台/);
  await page.screenshot({path:join(artifacts,'stage3-desktop-1440.png'),fullPage:true});

  // Roving tabs and manual/AI assessment history. Failed save retains input.
  await page.focus('#comparisonTab-matrix');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('.comparison-tabs [aria-selected="true"]')?.dataset.tab==='assessments');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'comparisonTab-assessments');
  await setFault(page,'POST */assessments/manual',{message:'人工评价保存暂时失败'});
  await page.type('#comparisonManualAssessmentForm [name="commonPoints"]','输入必须在失败后保留');
  await page.click('#comparisonManualAssessmentForm button[type="submit"]');
  await page.waitForFunction(()=>document.querySelector('#comparisonManualAssessmentForm .stage3-form-error')?.textContent.includes('失败'));
  assert.equal(await page.$eval('#comparisonManualAssessmentForm [name="commonPoints"]',node=>node.value),'输入必须在失败后保留');
  await clearFaults(page);
  const assessmentCount=await page.$$eval('.comparison-assessment-card',nodes=>nodes.length);
  await page.click('#comparisonManualAssessmentForm button[type="submit"]');
  await page.waitForFunction(before=>document.querySelectorAll('.comparison-assessment-card').length===before+1,{timeout:5000},assessmentCount);
  state=await page.evaluate(()=>{const request=[...(globalThis.__IDEAHUB_STAGE3_REQUESTS__||[])].reverse().find(item=>item.path.endsWith('/assessments/manual'));return{keys:Object.keys(request.body).sort(),finding:request.body.findings[0],target:request.body.target};});
  assert.deepEqual(state.keys,['commonPoints','doNotCopy','findings','hypotheses','keyDifferences','limitations','methodLimitations','openQuestions','strengths','target','worthLearning']);assert.equal(state.target,'traffic');assert.equal(state.finding.kind,'observation');assert.equal(state.finding.evidenceState,'manual_unverified');
  await page.select('#comparisonAssessmentTarget','persona');await page.waitForFunction(()=>document.querySelector('#comparisonManualAssessmentForm [name="target"]')?.value==='persona');
  await page.type('#comparisonManualAssessmentForm [name="strengths"]','人设立场表达保持一致');await page.click('#comparisonManualAssessmentForm button[type="submit"]');await page.waitForSelector('.comparison-assessment-card');
  assert.equal(await page.$eval('.comparison-assessment-card .source',node=>node.textContent),'人工评价');
  await page.select('#comparisonAssessmentTarget','traffic');await page.waitForFunction(()=>document.querySelector('#comparisonManualAssessmentForm [name="target"]')?.value==='traffic');
  await page.click('[data-comparison-action="start-ai"]');
  await page.waitForSelector('.stage3-job');
  assert.equal(await page.$eval('[data-comparison-action="start-ai"]',node=>node.disabled),true);
  await setFault(page,'GET */assessment-jobs/1',{message:'任务状态网络瞬时失败'});
  await page.click('[data-comparison-action="records"]');await page.waitForSelector('.comparison-record-card [data-comparison-id="41"]');await page.click('.comparison-record-card [data-comparison-id="41"]');await page.waitForSelector('#comparisonTab-assessments');await page.click('#comparisonTab-assessments');await page.waitForSelector('.stage3-job');
  await page.waitForSelector('.stage3-job.error [data-comparison-action="retry-job"]');assert.match(await page.$eval('.stage3-job.error',node=>node.textContent),/任务仍保留/);await clearFaults(page);await page.click('[data-comparison-action="retry-job"]');
  await page.waitForFunction(()=>!document.querySelector('.stage3-job'),{timeout:8000});
  assert.match(await page.$eval('#comparisonAssessmentTarget option[value="traffic"]',node=>node.textContent),/2 个版本/);assert.match(await page.$eval('#comparisonAssessmentTarget option[value="persona"]',node=>node.textContent),/1 个版本/);

  // Relation editor is an accessible text workflow; errors retain text and Escape restores focus.
  await page.focus('#comparisonTab-assessments');await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.comparison-relation-card');
  const relationTrigger='[data-comparison-action="new-relation"]';
  await page.click(relationTrigger);await page.waitForSelector('#comparisonRelationDialog[open]');
  await page.select('#comparisonRelationForm [name="objectSampleId"]','2');
  await page.type('#comparisonRelationForm [name="rationale"]','两篇作品采用相同问题入口，但证据与段落功能不同。');
  await setFault(page,'POST /api/sample-relations',{message:'关系保存失败'});
  await page.click('#comparisonRelationForm button[type="submit"]');
  await page.waitForFunction(()=>document.querySelector('#comparisonRelationForm .stage3-form-error')?.textContent.includes('失败'));
  assert.match(await page.$eval('#comparisonRelationForm [name="rationale"]',node=>node.value),/问题入口/);
  await clearFaults(page);await page.click('#comparisonRelationForm button[type="submit"]');
  await page.waitForFunction(()=>!document.querySelector('#comparisonRelationDialog[open]'));
  await page.waitForSelector('.comparison-relation-card:first-child [data-comparison-action="add-relation-evidence"]');
  await page.click('.comparison-relation-card:first-child [data-comparison-action="add-relation-evidence"]');await page.waitForSelector('#comparisonRelationEvidenceDialog[open] input[name="evidenceIndex"]');
  await page.type('#comparisonRelationEvidenceForm [name="note"]','来自主作品固定分析版本的正文证据');await page.click('#comparisonRelationEvidenceForm button[type="submit"]');await page.waitForFunction(()=>!document.querySelector('#comparisonRelationEvidenceDialog[open]'));await page.waitForFunction(()=>document.querySelector('.comparison-relation-card:first-child details')?.textContent.includes('1 条'));
  await page.click('[data-comparison-action="records"]');await page.waitForSelector('.comparison-record-card [data-comparison-id="41"]');await page.click('.comparison-record-card [data-comparison-id="41"]');await page.waitForSelector('#comparisonTab-relations');await page.click('#comparisonTab-relations');await page.waitForSelector('.comparison-relation-card:first-child [data-comparison-action="relation-event"][data-event="confirm"]');
  assert.match(await page.$eval('.comparison-relation-card:first-child details',node=>node.textContent),/1 条/);await page.click('.comparison-relation-card:first-child [data-event="confirm"]');await page.waitForFunction(()=>document.querySelector('.comparison-relation-card:first-child .relation-state')?.textContent.includes('已确认'));
  await page.waitForSelector('.comparison-relation-card:first-child [data-event="withdraw"]');await page.click('.comparison-relation-card:first-child [data-event="withdraw"]');await page.waitForFunction(()=>document.querySelector('.comparison-relation-card:first-child .relation-state')?.textContent.includes('已撤回'));
  state=await page.evaluate(()=>{const requests=globalThis.__IDEAHUB_STAGE3_REQUESTS__||[],relation=requests.findLast(item=>item.path==='/api/sample-relations'&&item.method==='POST'),evidence=requests.findLast(item=>/\/sample-relations\/\d+\/evidence$/.test(item.path));return{relationKeys:Object.keys(relation.body).sort(),evidenceKeys:Object.keys(evidence.body).sort()};});
  assert.deepEqual(state.relationKeys,['objectAnalysisVersionId','objectSampleId','rationale','relationType','subjectAnalysisVersionId','subjectSampleId']);assert.deepEqual(state.evidenceKeys,['elementEvidenceId','endpointAnalysisVersionId','endpointSampleId','note']);
  await page.click(relationTrigger);await page.waitForSelector('#comparisonRelationDialog[open]');await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.comparisonAction),'new-relation');

  // Local extraction is a focus-trapped sheet with input retention and a component handoff.
  await page.click('#comparisonTab-extractions');await page.waitForSelector('[data-comparison-action="new-extraction"]');
  await page.click('[data-comparison-action="new-extraction"]');await page.waitForSelector('#comparisonExtractionDialog[open]');
  const extractionValues={pattern:'场景限定加可检查步骤',functionText:'完成受众识别与价值说明',rationale:'两篇固定快照出现相同段落功能',applicability:'方法型内容',limitations:'当前样本量有限',doNotCopy:'不复制具体人物与时间结论'};
  for(const [name,value] of Object.entries(extractionValues))await page.type(`#comparisonExtractionForm [name="${name}"]`,value);
  await setFault(page,'POST */extractions',{message:'局部提取保存失败'});
  await page.$eval('#comparisonExtractionForm button[type="submit"]',node=>node.click());
  await page.waitForFunction(()=>document.querySelector('#comparisonExtractionForm .stage3-form-error')?.textContent.includes('失败'));
  assert.equal(await page.$eval('#comparisonExtractionForm [name="pattern"]',node=>node.value),extractionValues.pattern);
  await clearFaults(page);const extractionCount=await page.$$eval('.comparison-extraction-card',nodes=>nodes.length);await page.$eval('#comparisonExtractionForm button[type="submit"]',node=>node.click());
  await page.waitForFunction(before=>document.querySelectorAll('.comparison-extraction-card').length===before+1,{timeout:5000},extractionCount);
  await page.click('.comparison-extraction-card [data-comparison-action="component-from-extraction"]');
  await page.waitForSelector('#componentEditorDialog[open]');
  assert.equal(await page.$eval('#componentEditorForm [name="pattern"]',node=>node.value),extractionValues.pattern);
  await page.type('#componentEditorForm [name="applicability"]',extractionValues.applicability);await page.type('#componentEditorForm [name="limitations"]',extractionValues.limitations);await page.type('#componentEditorForm [name="doNotCopy"]',extractionValues.doNotCopy);
  await page.$eval('#componentEditorForm button[type="submit"]',node=>node.click());await page.waitForFunction(()=>!document.querySelector('#componentEditorDialog[open]'));
  state=await page.evaluate(()=>{const request=[...(globalThis.__IDEAHUB_STAGE3_REQUESTS__||[])].reverse().find(item=>item.path==='/api/content-components'&&item.method==='POST');return{tagIds:request.body.tagIds,keys:Object.keys(request.body).sort()};});assert.deepEqual(state.tagIds,[]);assert.deepEqual(state.keys,['applicability','dimensionKey','doNotCopy','extractionIds','functionText','limitations','name','patternText','tagIds']);

  // Management and reusable surfaces remain separate; component cards never expose whole-work metrics.
  await page.waitForSelector('.component-management-card');
  state=await page.evaluate(()=>({states:new Set([...document.querySelectorAll('.component-management-card header i')].map(node=>node.textContent)).size,cards:document.querySelectorAll('.component-management-card').length}));
  assert.ok(state.states>=4,state);assert.ok(state.cards>=5,state);
  await page.click('[data-component-id="11"]');await page.waitForSelector('.component-current-approved');
  assert.match(await page.$eval('.component-current-approved',node=>node.textContent),/当前可复用版本/);
  await page.click('[data-component-action="mode"][data-mode="reusable"]');await page.waitForSelector('.component-reusable-card');
  const reusableText=await page.$$eval('.component-reusable-card',nodes=>nodes.map(node=>node.textContent).join('\n'));
  assert.doesNotMatch(reusableText,/点赞|播放|浏览|排名|总分/);
  await page.focus('[data-component-action="mode"][data-mode="reusable"]');await page.keyboard.press('Home');await page.waitForFunction(()=>document.activeElement?.dataset.mode==='management');

  // Member sees deterministic list failure/retry and cannot review or change lifecycle.
  await page.goto(`${BASE}/?stage3=1&mock=1&mockRole=member`,{waitUntil:'domcontentloaded'});await openSamples(page);
  await page.click('[data-library-mode="comparisons"]');await page.waitForSelector('.comparison-record-card [data-comparison-id="31"]');await page.click('.comparison-record-card [data-comparison-id="31"]');await page.waitForSelector('#comparisonTab-assessments');await page.click('#comparisonTab-assessments');await page.waitForSelector('.comparison-assessment-card');
  assert.equal(await page.$$eval('[data-comparison-action="select-assessment"]',nodes=>nodes.length),0);
  assert.ok(await page.$$eval('[data-comparison-action="load-assessment-detail"]',nodes=>nodes.length)>=1);state=await page.evaluate(()=>{const official=document.querySelector('.comparison-assessment-card header i')?.closest('.comparison-assessment-card');return{official:!!official,officialLoad:!!official?.querySelector('[data-comparison-action="load-assessment-detail"]')};});assert.deepEqual(state,{official:true,officialLoad:false});const lazyId=await page.$eval('[data-comparison-action="load-assessment-detail"]',node=>node.dataset.id);await page.click(`[data-comparison-action="load-assessment-detail"][data-id="${lazyId}"]`);await page.waitForFunction(id=>!document.querySelector(`[data-comparison-action="load-assessment-detail"][data-id="${id}"]`),{},lazyId);
  await page.click('#comparisonTab-relations');await page.waitForSelector('.comparison-relation-card');
  assert.equal(await page.$$eval('[data-comparison-action="edit-relation"],[data-event="confirm"],[data-event="reject"]',nodes=>nodes.length),0);assert.ok(await page.$$eval('[data-event="withdraw"]',nodes=>nodes.length)>=1);
  await setFault(page,'GET /api/content-components',{message:'组件列表临时不可用'});
  await page.click('[data-library-mode="components"]');await page.waitForFunction(()=>document.querySelector('.stage3-state.error')?.textContent.includes('临时不可用'));
  await clearFaults(page);await page.click('[data-component-action="retry-list"]');await page.waitForSelector('.component-management-card');
  await page.click('[data-component-id="12"]');await page.waitForSelector('.component-detail-pane .component-revision-history');
  assert.equal(await page.$$eval('[data-component-action="review"]',nodes=>nodes.length),0);
  await page.$eval('[data-component-action="close-detail"]',node=>node.click());await page.click('[data-component-id="14"]');await page.waitForSelector('.component-detail-pane .component-lifecycle');
  assert.equal(await page.$$eval('.component-lifecycle [data-component-action="lifecycle"]',nodes=>nodes.length),0);

  // Reviewer can review but cannot retire/reactivate.
  await page.goto(`${BASE}/?stage3=1&mock=1&mockRole=reviewer`,{waitUntil:'domcontentloaded'});await openSamples(page);await page.click('[data-library-mode="components"]');await page.waitForSelector('.component-management-card');
  await page.click('[data-component-id="12"]');await page.waitForSelector('[data-component-action="review"]');
  assert.ok(await page.$$eval('[data-component-action="review"]',nodes=>nodes.length)>=2);
  assert.equal(await page.$$eval('.component-lifecycle [data-component-action="lifecycle"]',nodes=>nodes.length),0);

  // Mobile replaces the table with one vertical card per dimension and keeps all controls touch sized.
  await page.setViewport({width:390,height:844,deviceScaleFactor:1});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`${BASE}/?stage3=1&mock=1`,{waitUntil:'domcontentloaded'});await openSamples(page);
  await page.click('[data-library-mode="comparisons"]');await page.waitForSelector('.comparison-record-card');await page.click('.comparison-record-card [data-comparison-id="31"]');await page.waitForSelector('.comparison-mobile-dimension');
  await page.click('.comparison-frozen-note summary');await page.waitForSelector('.comparison-frozen-grid article');
  state=await page.evaluate(()=>{
    const visible=node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return box.width>0&&box.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
    const controls=[...document.querySelectorAll('#sampleLibraryComparisons button,#sampleLibraryComparisons summary,#sampleLibraryComparisons input,#sampleLibraryComparisons select,#sampleLibraryComparisons textarea')].filter(visible);
    const metricCards=[...document.querySelectorAll('.comparison-frozen-grid article')].map(article=>{const box=article.getBoundingClientRect(),metrics=[...article.querySelectorAll('.comparison-frozen-metrics span')];return{count:metrics.length,inside:metrics.every(node=>{const cell=node.getBoundingClientRect();return cell.left>=box.left-.5&&cell.right<=box.right+.5&&cell.top>=box.top-.5&&cell.bottom<=box.bottom+.5;})};});
    return{overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,cards:document.querySelectorAll('.comparison-mobile-dimension').length,members:document.querySelectorAll('.comparison-mobile-dimension:first-child>section').length,tableVisible:visible(document.querySelector('.comparison-matrix-scroll')),minControl:Math.min(...controls.map(node=>node.getBoundingClientRect().height)),reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,metricCards};
  });
  assert.equal(state.overflow,0);assert.equal(state.cards,15);assert.equal(state.members,6);assert.equal(state.tableVisible,false);assert.ok(state.minControl>=44,state);assert.equal(state.reduced,true);assert.equal(state.metricCards.length,6);assert.ok(state.metricCards.every(card=>card.count===5&&card.inside),state.metricCards);
  await page.screenshot({path:join(artifacts,'stage3-mobile-390.png'),fullPage:true});

  console.log(`Stage 3 UI: selection/workspace/assessment/relation/extraction/components/roles/mobile checks passed; screenshots ${artifacts}`);
} finally {
  await browser.close();
  server.kill();
}
