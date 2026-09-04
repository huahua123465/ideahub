import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_RESEARCH_DIMENSIONS,
  accountResearchPermissions,
  accountResearchRequestSha256,
  assertAccountResearchDto,
  buildAccountEvidenceManifest,
  buildAccountContentMatrix,
  buildAccountSaturation,
  buildAccountSamplingPlan,
  classifyAccountPattern,
  deduplicateAccountEvidence,
  deriveAccountClaimQuality,
  deriveAccountResearchQuality,
  measureCodeSaturation,
  normalizeAccountAnalysisOutput,
  normalizeAccountClaimDecision,
  normalizeAccountClaim,
  normalizeAccountRunRequest,
  requestAccountResearchAnalysis,
  resolveAccountIdentity,
  validateAccountClaimLanguage,
  validateEvidenceLocator,
  validateEvidenceQuote,
} from '../server/src/lib/account-research.mjs';

test('账户研究维度覆盖账户身份到时间演化', () => {
  assert.deepEqual(ACCOUNT_RESEARCH_DIMENSIONS.map(item => item.key), [
    'identity_positioning','audience_needs','content_supply','expression_mechanism',
    'trust_relationship','community_feedback','conversion_path','temporal_evolution',
  ]);
});

test('账户身份优先稳定平台ID并拒绝静默名称合并', () => {
  const explicit = resolveAccountIdentity({ platform:'xiaohongshu', sampleId:1,
    platformAccountId:'ABCD', profileUrl:'https://www.xiaohongshu.com/user/profile/ABCD', accountName:'同名账号' });
  assert.equal(explicit.key, 'xiaohongshu:id:ABCD');
  assert.equal(explicit.needsReview, false);
  const profile = resolveAccountIdentity({ platform:'xiaohongshu', sampleId:2,
    profileUrl:'https://www.xiaohongshu.com/user/profile/5B2B7035', accountName:'作者' });
  assert.equal(profile.key, 'xiaohongshu:id:5B2B7035');
  assert.equal(profile.quality, 'profile_id');
  const first = resolveAccountIdentity({ platform:'xiaohongshu', sampleId:3, accountName:'相同显示名' });
  const second = resolveAccountIdentity({ platform:'xiaohongshu', sampleId:4, accountName:'相同显示名' });
  assert.notEqual(first.key, second.key);
  assert.equal(first.needsReview, true);
  const conflict = resolveAccountIdentity({ platform:'xiaohongshu', sampleId:5,
    platformAccountId:'one', profileUrl:'https://www.xiaohongshu.com/user/profile/two' });
  assert.equal(conflict.quality, 'conflict');
  assert.notEqual(resolveAccountIdentity({platform:'youtube',platformAccountId:'AbC'}).key,
    resolveAccountIdentity({platform:'youtube',platformAccountId:'abc'}).key);
  assert.equal(resolveAccountIdentity({platform:'xiaohongshu',sampleId:9,
    profileUrl:'https://attacker.example/user/profile/stolen',accountName:'候选'}).quality,'name_candidate');
});

test('账户研究权限区分读取、评审和高成本运行', () => {
  assert.deepEqual(accountResearchPermissions(null), {canRead:false,canCreateRun:false,canRerun:false,canReview:false});
  assert.deepEqual(accountResearchPermissions({role:'member'}), {canRead:true,canCreateRun:false,canRerun:false,canReview:false});
  assert.deepEqual(accountResearchPermissions({role:'reviewer'}), {canRead:true,canCreateRun:false,canRerun:false,canReview:true});
  assert.deepEqual(accountResearchPermissions({role:'admin'}), {canRead:true,canCreateRun:true,canRerun:true,canReview:true});
});

test('运行请求固定窗口、边界、版本和确定摘要', () => {
  const first = normalizeAccountRunRequest({ windowStart:'2026-01-01',windowEnd:'2026-07-01',maxSamples:60,includeComments:true });
  const second = normalizeAccountRunRequest({ includeComments:true,maxSamples:60,windowEnd:'2026-07-01',windowStart:'2026-01-01' });
  assert.equal(first.dtoVersion, 'account-research-dto/1.1');
  assert.equal(accountResearchRequestSha256(first), accountResearchRequestSha256(second));
  assert.throws(() => normalizeAccountRunRequest({ windowStart:'2026-07-01',windowEnd:'2026-01-01' }));
  assert.throws(() => normalizeAccountRunRequest({ windowStart:'2026-01-01',windowEnd:'2026-07-01',maxSamples:9 }));
  assert.throws(() => normalizeAccountRunRequest({ windowStart:'2026-01-01',windowEnd:'2026-07-01',unknown:true }));
  assert.throws(() => normalizeAccountRunRequest({windowStart:['2026-01-01'],windowEnd:'2026-07-01'}));
  assert.throws(() => normalizeAccountRunRequest({windowStart:'2026-01-01',windowEnd:'2026-07-01',includeComments:1}));
});

test('决定输入有严格字段并要求编辑值，DTO 版本不匹配会失败', () => {
  assert.deepEqual(normalizeAccountClaimDecision({ decision:'confirmed',note:'已核对' }), {
    decision:'confirmed',claimText:null,operationalDefinition:null,limitations:null,note:'已核对',
  });
  assert.throws(() => normalizeAccountClaimDecision({ decision:'edited' }));
  assert.throws(() => normalizeAccountClaimDecision({decision:'edited',claimText:'修改',limitations:null}));
  assert.throws(() => normalizeAccountClaimDecision({decision:['confirmed']}));
  assert.throws(() => normalizeAccountClaimDecision({ decision:'rejected',extra:'x' }));
  assert.equal(assertAccountResearchDto({dtoVersion:'account-research-dto/1.1'}).dtoVersion, 'account-research-dto/1.1');
  assert.throws(() => assertAccountResearchDto({dtoVersion:'old'}));
});

test('小账户全量分析并显式提示样本和数据覆盖不足', () => {
  const plan = buildAccountSamplingPlan(Array.from({ length:8 }, (_, index) => ({
    id:index + 1, publishedAt:`2026-0${index % 3 + 1}-01T00:00:00Z`,
    contentType:index % 2 ? 'video' : 'image_post', bodyText:'正文', metrics:{ likes:100 + index },
    assetCount:index < 4 ? 1 : 0, commentCount:index < 2 ? 3 : 0,
  })), { windowStart:'2026-01-01', windowEnd:'2026-04-01' });
  assert.equal(plan.mode, 'census');
  assert.equal(plan.selectedCount, 8);
  assert.match(plan.warnings.join(' '), /少于 10 篇/);
  assert.match(plan.warnings.join(' '), /评论覆盖不足/);
});

test('大账户按时间格式和表现分层并固定样本清单', () => {
  const rows = Array.from({ length:96 }, (_, index) => ({
    id:index + 1, pinned:index < 2, publishedAt:new Date(Date.UTC(2025, index % 12, index % 27 + 1)).toISOString(),
    contentType:['video','image_post','article'][index % 3], bodyText:'正文', assetCount:1,
    commentCount:index % 2, metrics:{ likes:index * 100, collects:index * 20, comments:index },
  }));
  const first = buildAccountSamplingPlan(rows, { maxSamples:60 });
  const second = buildAccountSamplingPlan(rows, { maxSamples:60 });
  assert.equal(first.mode, 'stratified');
  assert.equal(first.selectedCount, 60);
  assert.deepEqual(first.items, second.items);
  assert.ok(first.items.some(item => item.inclusionReasons.includes('pinned')));
  assert.equal(Object.keys(first.coverage.formats).length, 3);
  assert.deepEqual(Object.keys(first.coverage.performanceBands).sort(), ['low','lower_middle','top','upper_middle']);
  assert.ok(Object.keys(first.coverage.timeBuckets).length >= 6);
});

test('重复正文和OCR在同一样本内合并为一个证据', () => {
  const items = deduplicateAccountEvidence([
    { sampleId:7, sourceId:'body:1', sourceKind:'body', content:'同一段 结论。' },
    { sampleId:7, sourceId:'ocr:1', sourceKind:'ocr', content:'同一段结论' },
    { sampleId:8, sourceId:'body:2', sourceKind:'body', content:'同一段结论' },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.find(item => item.sampleId === 7).sourceKinds, ['body','ocr']);
});

test('证据位置验证文本视频图片和评论定位', () => {
  assert.deepEqual(validateEvidenceLocator({ startOffset:2, endOffset:7 }, 9), { startOffset:2, endOffset:7 });
  assert.deepEqual(validateEvidenceLocator({ timeStartMs:1000, timeEndMs:2500 }), { timeStartMs:1000, timeEndMs:2500 });
  assert.deepEqual(validateEvidenceLocator({ imageIndex:2, region:{ x:.1,y:.2,width:.4,height:.5 } }),
    { imageIndex:2, region:{ x:.1,y:.2,width:.4,height:.5 } });
  assert.deepEqual(validateEvidenceLocator({ commentRef:'comment-9' }), { commentRef:'comment-9' });
  assert.throws(() => validateEvidenceLocator({ startOffset:5, endOffset:12 }, 10));
  assert.throws(() => validateEvidenceLocator({ imageIndex:1, region:{ x:.8,y:.2,width:.4,height:.5 } }));
  assert.throws(() => validateEvidenceLocator({ timeStartMs:1000,timeEndMs:2500 }, { durationMs:2000 }));
  assert.throws(() => validateEvidenceLocator({ imageIndex:3 }, { imageCount:2 }));
  assert.deepEqual(validateEvidenceLocator({profileField:'qualification'}),{profileField:'qualification'});
  assert.deepEqual(validateEvidenceQuote({sourceText:'甲😀乙结论',quoteText:'乙结论',locator:{startOffset:3,endOffset:6}}).quoteText,'乙结论');
});

test('账户清单只接收已验证证据并支持冻结资料快照',()=>{
  const manifest=buildAccountEvidenceManifest([{id:1,bodyText:'不得直接进入',comments:[{id:'c1',text:'也不得进入'}],elementEvidence:[
    {sourceId:'verified-body',sourceKind:'body',quoteText:'证据',locator:{startOffset:0,endOffset:2},elementEvidenceId:7,captureId:3,bounds:{contentLength:2}},
  ]}],{profileEvidence:[{sourceId:'profile-1',sampleId:1,sourceKind:'profile',quoteText:'认证咨询师',locator:{profileField:'qualification'},profileSnapshotId:9,captureId:3}]});
  assert.deepEqual(manifest.sources.map(item=>item.sourceKind),['body','profile']);
  assert.ok(manifest.sources.every(item=>item.elementEvidenceId||item.profileSnapshotId));
});

test('AI请求使用严格 schema、store false 并拒绝非法输出',async()=>{
  const samples=[{id:1,title:'样本',publishedAt:'2026-01-01T00:00:00Z',contentType:'text'}];
  const manifest={sources:[]};let request;
  const insufficient={claims:ACCOUNT_RESEARCH_DIMENSIONS.map(item=>({dimensionKey:item.key,patternCode:`insufficient_${item.key}`,contentGoal:null,claimType:'insufficient',claimText:null,
    operationalDefinition:null,eligibleSampleIds:[],presentSampleIds:[],representativeSampleIds:[],counterexampleSampleIds:[],timeBuckets:[],
    limitations:'材料不足',evidence:[]}))};
  const provider={apiKey:'stub',baseUrl:'https://provider.invalid/v1',model:'stub-model',source:'stub'};
  const result=await requestAccountResearchAnalysis({manifest,samples,provider,fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);
    return {ok:true,status:200,json:async()=>({model:'stub-model-v1',output_text:JSON.stringify(insufficient)})};}});
  assert.equal(request.store,false);assert.equal(request.text.format.strict,true);assert.equal(request.text.format.type,'json_schema');assert.equal(result.claims.length,8);
  await assert.rejects(requestAccountResearchAnalysis({manifest,samples,provider,fetchImpl:async()=>({ok:true,status:200,json:async()=>({output_text:'{"claims":[]}'})})}),error=>error.code==='AI_INVALID_OUTPUT');
});

test('稳定特征要求足量样本、占比和跨时间覆盖', () => {
  assert.equal(classifyAccountPattern({ eligibleCount:9,presentCount:9,timeBucketCount:3 }).level, 'insufficient');
  assert.equal(classifyAccountPattern({ eligibleCount:20,presentCount:13,timeBucketCount:3,counterexampleCount:7 }).level, 'stable');
  assert.equal(classifyAccountPattern({ eligibleCount:20,presentCount:8,timeBucketCount:1 }).level, 'recurring');
});

test('质量标签忽略AI自信并对假设和缺口降级', () => {
  const strong = deriveAccountClaimQuality({ claimType:'observation',supportEvidenceCount:8,exactEvidenceCount:8,
    eligibleCount:20,timeBucketCount:3,sampleCoverage:1,humanDecision:'confirmed',aiConfidence:.99 });
  assert.equal(strong.label, 'evidence_sufficient');
  assert.equal(strong.aiConfidenceIgnored, true);
  assert.equal(strong.formulaVersion, 'account-quality/1.0');
  const sameWithLowAiConfidence = deriveAccountClaimQuality({ claimType:'observation',supportEvidenceCount:8,
    exactEvidenceCount:8,eligibleCount:20,timeBucketCount:3,sampleCoverage:1,
    humanDecision:'confirmed',aiConfidence:.01 });
  assert.deepEqual(strong, sameWithLowAiConfidence);
  const pending = deriveAccountClaimQuality({ claimType:'interpretation',supportEvidenceCount:3,exactEvidenceCount:2,
    eligibleCount:7,timeBucketCount:1,sampleCoverage:.5,humanDecision:null,aiConfidence:.99 });
  assert.notEqual(pending.label, 'evidence_sufficient');
  assert.equal(deriveAccountClaimQuality({ claimType:'hypothesis',supportEvidenceCount:4 }).label, 'hypothesis_only');
});

test('账户质量报告同时呈现身份、样本、数据和人工审核缺口', () => {
  const report = deriveAccountResearchQuality({
    identity:{ quality:'profile_id',needsReview:false },
    samplingPlan:{ mode:'census',eligibleCount:12,selectedCount:12,
      coverage:{ publishedAt:1,body:1,media:.75,comments:.25 },warnings:[] },
    claims:[
      { qualityLabel:'evidence_sufficient',decision:'confirmed' },
      { qualityLabel:'hypothesis_only',decision:null },
    ],
  });
  assert.equal(report.status, 'review_required');
  assert.equal(report.decisions.reviewCoverage, .5);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.warnings.some(value => value.includes('媒体覆盖不足')));
  assert.ok(report.warnings.some(value => value.includes('评论覆盖不足')));
  const blocked = deriveAccountResearchQuality({
    identity:{ quality:'name_candidate',needsReview:true },
    samplingPlan:{ eligibleCount:8,selectedCount:8,coverage:{ body:.5 } },claims:[],
  });
  assert.equal(blocked.status, 'insufficient');
  assert.deepEqual(blocked.blockers.map(item => item.code), ['account_identity_unverified','eligible_samples_below_10','body_coverage_below_80pct']);
});

test('账户结论保存频率、代表样本、反例并禁止因果类型', () => {
  const value = normalizeAccountClaim({ dimensionKey:'expression_mechanism',patternCode:'command_title',contentGoal:null,claimType:'observation',
    claimText:'重复使用命令式标题',operationalDefinition:'标题含直接动作指令',eligibleCount:12,presentCount:8,
    timeBuckets:['2026-08','2026-07'],representativeSampleIds:[1,2,99],counterexampleSampleIds:[3],
    limitations:'只适用于当前窗口。' }, { availableSampleIds:[1,2,3] });
  assert.equal(value.prevalence, 8 / 12);
  assert.deepEqual(value.representativeSampleIds, [1,2]);
  assert.deepEqual(value.counterexampleSampleIds, [3]);
  assert.equal(value.causalClaimsAllowed, false);
  assert.throws(() => normalizeAccountClaim({ dimensionKey:'content_supply',patternCode:'causal_bad',contentGoal:'traffic',claimType:'causal',causal:true }));
});

test('观察和解释拒绝因果措辞，效果假设必须带不确定性和限制', () => {
  assert.throws(() => validateAccountClaimLanguage({ claimType:'observation',claimText:'这种标题导致收藏增长' }));
  for(const claimText of ['这种标题提高收藏','这种结构促进转化','这种表达推动传播','这种开头带动点赞','这种语气增强信任','这种排版改善完播','这种机制影响销量'])
    assert.throws(()=>validateAccountClaimLanguage({claimType:'interpretation',claimText}));
  for(const operationalDefinition of ['收藏增长是因为标题','转化归因于开头','传播源于清单结构'])
    assert.throws(()=>validateAccountClaimLanguage({claimType:'observation',claimText:'可见结构重复',operationalDefinition}));
  const reviewerExamples=['引发收藏增长','让收藏增长','促使转化提升','有助于粉丝增长','助推销量增长','令点击增加'];
  for(const claimText of reviewerExamples)assert.throws(()=>validateAccountClaimLanguage({claimType:'observation',claimText,limitations:'当前样本有限'}));
  assert.throws(()=>validateAccountClaimLanguage({claimType:'interpretation',claimText:'可见结构重复',limitations:'标题引发收藏增长'}));
  assert.doesNotThrow(()=>validateAccountClaimLanguage({claimType:'observation',claimText:'这种标题可能引发收藏增长，但无法证明因果',limitations:'当前样本有限'}));
  assert.throws(() => validateAccountClaimLanguage({ claimType:'hypothesis',claimText:'这种标题提高收藏' }));
  assert.deepEqual(validateAccountClaimLanguage({ claimType:'hypothesis',
    claimText:'这种标题可能提高收藏，但不能证明因果',limitations:'缺少曝光和对照数据。' }), {
    claimType:'hypothesis',claimText:'这种标题可能提高收藏,但不能证明因果',
    operationalDefinition:null,limitations:'缺少曝光和对照数据。',causalClaimsAllowed:false,
  });
});

test('AI账户输出逐句拒绝未限定的因果效果措辞',()=>{
  const samples=[{id:1,publishedAt:'2026-01-01T00:00:00Z'}],manifest={sources:[{sourceId:'s1',sampleId:1}]};
  const reviewerExamples=['引发收藏增长','让收藏增长','促使转化提升','有助于粉丝增长','助推销量增长','令点击增加'];
  for(const phrase of reviewerExamples){const claims=ACCOUNT_RESEARCH_DIMENSIONS.map((dimension,index)=>index===0?{
      dimensionKey:dimension.key,patternCode:`pattern_${index}`,contentGoal:null,claimType:'observation',claimText:phrase,operationalDefinition:'可见文本',eligibleSampleIds:[1],presentSampleIds:[1],
      representativeSampleIds:[1],counterexampleSampleIds:[],timeBuckets:['2026-01'],limitations:'当前样本有限',evidence:[{sourceId:'s1',direction:'support'}],
    }:{dimensionKey:dimension.key,patternCode:`insufficient_${index}`,contentGoal:null,claimType:'insufficient',claimText:null,operationalDefinition:null,eligibleSampleIds:[],presentSampleIds:[],
      representativeSampleIds:[],counterexampleSampleIds:[],timeBuckets:[],limitations:'材料不足',evidence:[]});
    assert.throws(()=>normalizeAccountAnalysisOutput({claims},manifest,samples),/causal/i);}
});

test('编码饱和必须连续两个批次几乎无新增编码', () => {
  const result = measureCodeSaturation([['A','B'],['A'],['A']], .05);
  assert.equal(result.reached, true);
  const notReached = measureCodeSaturation([['A'],['B'],['B']], .05);
  assert.equal(notReached.reached, false);
});

test('多结论、内容目标、矩阵和冻结批次饱和度遵守 1.1 契约',()=>{
  const samples=Array.from({length:15},(_,index)=>({sampleId:index+1,ordinal:index+1,publishedAt:index===14?null:new Date(Date.UTC(2026,0,index+1)).toISOString(),contentType:index===14?null:index%2?'video':'image'}));
  const claims=[
    {dimensionKey:'content_supply',patternCode:'case_study',contentGoal:'expertise',claimType:'observation',presentSampleIds:[1,6,15]},
    {dimensionKey:'content_supply',patternCode:'checklist',contentGoal:'traffic',claimType:'observation',presentSampleIds:[1,2]},
    {dimensionKey:'identity_positioning',patternCode:'calm_voice',contentGoal:null,claimType:'observation',presentSampleIds:[1]},
  ];
  const matrix=buildAccountContentMatrix(claims,samples,{start:'2026-01-01',end:'2026-02-01'});
  assert.equal(matrix.membershipTotal,5);assert.equal(matrix.uniqueSampleCount,4);assert.ok(matrix.rows.some(row=>row.cells.some(cell=>cell.period==='unknown'&&cell.format==='unknown')));
  const saturation=buildAccountSaturation(claims,samples);assert.equal(saturation.ruleVersion,'saturation/1.0');assert.equal(saturation.status,'measured');assert.equal(saturation.reached,true);
  assert.equal(saturation.batches[1].newCodeRatio,0);assert.deepEqual(saturation,buildAccountSaturation(claims,samples));
  assert.throws(()=>buildAccountContentMatrix([{...claims[0],contentGoal:'illegal'}],samples,{start:'2026-01-01',end:'2026-02-01'}));
});
