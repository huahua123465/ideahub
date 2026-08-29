import { createHash } from 'node:crypto';

import { ANALYSIS_DIMENSIONS } from './sample-research.mjs';

export const VECTOR_ALGORITHM_VERSION = 'fh15-q15/1';
export const TOKENIZER_VERSION = 'zhmix/1';
export const RETRIEVE_MAPPING_VERSION = 'retrieve-map/1';
export const CLUSTER_ALGORITHM_VERSION = 'mutual-knn/1';
export const INSIGHT_ALGORITHM_VERSION = 'descriptive-tags/1';
export const DIMENSIONS = Object.freeze(ANALYSIS_DIMENSIONS.map(({ key, ordinal, label }) => ({ key, ordinal, label })));
export const DIMENSION_KEYS = Object.freeze(DIMENSIONS.map(item => item.key));
export const TARGETS = Object.freeze(['traffic', 'persona', 'expertise', 'conversion']);
export const METRICS = Object.freeze(['likes','saves','comments','shares','views','likes_per_view','saves_per_view','comments_per_view','shares_per_view']);
export const TRUST_POLICIES = Object.freeze(['human_confirmed','reviewed_or_manual_tag','all_effective']);
export const LIMITS = Object.freeze({
  vectorSize:256, dimensionsPerSample:15, retrieveBodyBytes:16384, queryFieldChars:1000,
  minimumNormalizedTokens:8, tagIdsMax:20, excludeSampleIdsMax:100, sampleLimitDefault:10,
  sampleLimitMax:30, componentLimitDefault:8, componentLimitMax:20, sampleShortlistMax:600,
  componentShortlistMax:300, retrieveResponseBytesMax:524288, retrievePerUserConcurrent:2,
  retrieveGlobalConcurrent:4, statementTimeoutMs:2000, similarLimitMax:30, clusterNeighborK:12,
  clusterMinScore:.58, clusterMinSharedDimensions:6, clusterMinMembers:3, combinationsPerRunMax:20,
  combinationSizeMax:3, bootstrapReplicates:2000, pageSizeDefault:20, pageSizeMax:100,
  insightRequestBodyBytes:65536, insightNameChars:200, accountKeysMax:100, accountKeyChars:240,
  userNeedTagIdsMax:20, singleTagIdsMax:50, observationTargetSecondsMin:60,
  observationTargetSecondsMax:31536000, observationToleranceSecondsMax:2592000,
});

export const RETRIEVE_MAPPING = Object.freeze({
  userNeed:{ user_need:1, audience:.45 }, topic:{ topic:1, core_viewpoint:.45 },
  accountStyle:{ language_style:.85, visual_style:.65, layout:.45, length:.25, title_mechanism:.25, opening_method:.25, bgm:.15 },
  traffic:{ breakout_point:1, title_mechanism:.8, opening_method:.7, cta:.25 },
  persona:{ core_viewpoint:.8, language_style:.75, audience:.5, visual_style:.25 },
  expertise:{ argumentation_method:1, core_viewpoint:.8, content_structure:.6, topic:.4 },
  conversion:{ cta:1, user_need:.7, content_structure:.45, argumentation_method:.35, title_mechanism:.25 },
});
export const TARGET_DESCRIPTORS = Object.freeze({
  traffic:'吸引注意 点击 停留 分享 传播', persona:'账号人设 价值观 个性 信任 记忆',
  expertise:'专业 论证 方法 框架 证据', conversion:'行动 私信 咨询 购买 转化',
});

const ZH_STOP = new Set('的 了 是 在 和 与 及 或 也 都 就 而 被 把 对 为 中 上 下 有 没有 一个 一种 这个 那个'.split(' '));
const EN_STOP = new Set('a an the and or is are of to in on for with by as at be this that it'.split(' '));
const HAN = /^\p{Script=Han}$/u;
const LATIN_NUMBER = /^(?:\p{Script=Latin}|\p{Number})$/u;

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex'); }

export function jsonLeaves(value, out = []) {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) jsonLeaves(item, out);
  else if (value && typeof value === 'object') for (const key of Object.keys(value).sort()) jsonLeaves(value[key], out);
  return out;
}

export function tokenize(value) {
  const text = jsonLeaves(value).join(' ').normalize('NFKC').toLowerCase().replace(/[\p{Cc}\p{Cf}]/gu, '');
  const points = [...text], tokens = [];
  for (let i=0;i<points.length;) {
    const kind = HAN.test(points[i]) ? 'han' : LATIN_NUMBER.test(points[i]) ? 'latin' : null;
    if (!kind) { i++; continue; }
    let j=i+1;
    while (j<points.length && (kind==='han' ? HAN.test(points[j]) : LATIN_NUMBER.test(points[j]))) j++;
    const run=points.slice(i,j);
    if (kind==='han') {
      for (const ch of run) if (!ZH_STOP.has(ch)) tokens.push(ch);
      for (let k=0;k+1<run.length;k++) tokens.push(run[k]+run[k+1]);
    } else {
      const full=run.join('');
      if (!EN_STOP.has(full)) tokens.push(full);
      if (run.length>=4) for(let k=0;k+2<run.length;k++) tokens.push(run.slice(k,k+3).join(''));
    }
    i=j;
  }
  return tokens;
}

export function vectorizeChannels(dimensionKey, channels, algorithmVersion = VECTOR_ALGORITHM_VERSION) {
  if (!DIMENSION_KEYS.includes(dimensionKey)) throw new TypeError(`unknown dimension: ${dimensionKey}`);
  const accumulator=new Float64Array(256);
  for(const channel of channels || []) {
    const coefficient=Number(channel.coefficient);
    if(!Number.isFinite(coefficient)||coefficient===0)continue;
    const counts=new Map();
    for(const token of tokenize(channel.value)) counts.set(token,(counts.get(token)||0)+1);
    for(const [token,tf] of counts) {
      const digest=createHash('sha256').update(`${algorithmVersion}\0${dimensionKey}\0${token}`,'utf8').digest();
      const bucket=digest.readUInt16BE(0)%256, sign=(digest[2]&1)===1?1:-1;
      accumulator[bucket]+=sign*coefficient*(1+Math.log(tf));
    }
  }
  const length=Math.sqrt(accumulator.reduce((sum,x)=>sum+x*x,0));
  const vector=Array.from(accumulator,x=>{
    if(!length)return 0;
    const normalized=x/length, q=Math.sign(normalized)*Math.floor(Math.abs(normalized)*32767+.5);
    return Math.max(-32767,Math.min(32767,q));
  });
  const normSq=vector.reduce((sum,x)=>sum+BigInt(x)*BigInt(x),0n);
  const nonzeroCount=vector.reduce((sum,x)=>sum+(x!==0),0);
  const {simhash,bands}=simhash64(dimensionKey,vector,algorithmVersion);
  return {vector,normSq,nonzeroCount,simhash,bands};
}

export function simhash64(dimensionKey, vector, algorithmVersion=VECTOR_ALGORITHM_VERSION) {
  let bits='';
  for(let b=0;b<64;b++){
    let sum=0n;
    for(let i=0;i<256;i++){
      const sign=(createHash('sha256').update(`simhash/${algorithmVersion}|${dimensionKey}|${i}|${b}`,'utf8').digest()[0]&1)===1?1n:-1n;
      sum+=BigInt(vector[i]||0)*sign;
    }
    bits+=sum>=0n?'1':'0';
  }
  return {simhash:bits,bands:Array.from({length:8},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2))};
}

export function cosineQ15(a,b,aNorm=null,bNorm=null) {
  let dot=0n,na=aNorm==null?0n:BigInt(aNorm),nb=bNorm==null?0n:BigInt(bNorm);
  const sparseA=a?.nonzeroIndices,sparseB=b?.nonzeroIndices;
  if(aNorm!=null&&bNorm!=null&&Array.isArray(sparseA)&&Array.isArray(sparseB)){
    const indices=sparseA.length<=sparseB.length?sparseA:sparseB;for(const i of indices)dot+=BigInt(a?.[i]||0)*BigInt(b?.[i]||0);
  }else for(let i=0;i<256;i++){const x=BigInt(a?.[i]||0),y=BigInt(b?.[i]||0);dot+=x*y;if(aNorm==null)na+=x*x;if(bNorm==null)nb+=y*y;}
  if(na===0n||nb===0n)return 0;
  return Math.max(-1,Math.min(1,Number(dot)/(Math.sqrt(Number(na))*Math.sqrt(Number(nb)))));
}

export function buildQueryVectors({userNeed,topic,target,accountStyle}) {
  const fields=[['userNeed',userNeed,RETRIEVE_MAPPING.userNeed],['topic',topic,RETRIEVE_MAPPING.topic],
    ['accountStyle',accountStyle,RETRIEVE_MAPPING.accountStyle],['target',TARGET_DESCRIPTORS[target],RETRIEVE_MAPPING[target]]];
  const merged=new Map();
  for(const [field,value,mapping] of fields) for(const [dimension,coefficient] of Object.entries(mapping||{})) {
    if(!merged.has(dimension))merged.set(dimension,[]);
    merged.get(dimension).push({value,coefficient,source:field});
  }
  const rawWeights=new Map();
  for(const [dimension,channels] of merged)rawWeights.set(dimension,channels.reduce((n,c)=>n+c.coefficient,0));
  const total=[...rawWeights.values()].reduce((a,b)=>a+b,0);
  const vectors={};
  for(const [dimension,channels] of merged)vectors[dimension]={...vectorizeChannels(dimension,channels),weight:rawWeights.get(dimension)/total,sources:channels.map(c=>c.source)};
  const userTokens=new Set([...tokenize(userNeed),...tokenize(topic),...tokenize(accountStyle)]);
  return {vectors,uniqueUserTokens:userTokens.size,queryStrength:Math.min(1,userTokens.size/24)};
}

export function reliabilityFor(row={}) {
  const decisionState=row.decisionState??row.decision_state??row.decision??null;
  if(['confirmed','edited'].includes(decisionState))return 1;
  if(row.source==='manual')return .9;if(row.source==='legacy')return .55;
  const factors={none:.35,weak:.55,medium:.75,strong:1};
  return Math.max(0,Math.min(1,Number(row.confidence)||0))*(factors[row.evidenceStrength??row.evidence_strength]??.35);
}

export function scoreCandidate(queryVectors,candidateVectors,{component=false,queryStrength=0}={}) {
  let score=0,coverage=0,reliabilitySum=0;const reasons=[];
  for(const dimension of DIMENSIONS){const q=queryVectors[dimension.key],c=candidateVectors?.[dimension.key];if(!q)continue;
    const cosine=c&&BigInt(c.normSq??c.norm_sq??0)!==0n?Math.max(0,cosineQ15(q.vector,c.vector,q.normSq,c.normSq??c.norm_sq)):0;
    const contribution=q.weight*cosine;score+=contribution;
    if(c&&BigInt(c.normSq??c.norm_sq??0)!==0n){coverage+=q.weight;reliabilitySum+=q.weight*reliabilityFor(c);}
    reasons.push({dimensionKey:dimension.key,ordinal:dimension.ordinal,sourceChannels:q.sources,cosine,contribution});
  }
  const weightedReliability=coverage?reliabilitySum/coverage:0;
  const confidence=Math.max(0,Math.min(1,coverage*(.75*weightedReliability+.25*queryStrength)));
  reasons.sort((a,b)=>b.contribution-a.contribution||a.ordinal-b.ordinal||a.dimensionKey.localeCompare(b.dimensionKey));
  return {score,coverage,confidence,confidenceLabel:confidence>=.75?'high':confidence>=.5?'medium':'low',weightedReliability,reasons:reasons.slice(0,3)};
}

export function pairSimilarity(a,b,dimensionKeys=DIMENSION_KEYS) {
  const dimensions=[];
  for(const key of dimensionKeys){const av=a?.[key],bv=b?.[key];if(!av||!bv||BigInt(av.normSq??av.norm_sq??0)===0n||BigInt(bv.normSq??bv.norm_sq??0)===0n)continue;
    dimensions.push({dimensionKey:key,cosine:cosineQ15(av.vector,bv.vector,av.normSq??av.norm_sq,bv.normSq??bv.norm_sq)});}
  return {pairSimilarity:dimensions.length?dimensions.reduce((n,x)=>n+x.cosine,0)/dimensions.length:0,
    sharedDimensionCount:dimensions.length,coverage:dimensions.length/dimensionKeys.length,dimensions};
}

export function pairSimilarityCompact(a,b,dimensionKeys=DIMENSION_KEYS){let sum=0,shared=0;for(const key of dimensionKeys){const av=a?.[key],bv=b?.[key];if(!av||!bv||BigInt(av.normSq??av.norm_sq??0)===0n||BigInt(bv.normSq??bv.norm_sq??0)===0n)continue;sum+=cosineQ15(av.vector,bv.vector,av.normSq??av.norm_sq,bv.normSq??bv.norm_sq);shared++;}return{pairSimilarity:shared?sum/shared:0,sharedDimensionCount:shared,coverage:shared/dimensionKeys.length};}

export function accumulateDimensionPairStats(dimensionStats,pair){for(const dimension of pair.dimensions||[]){const stats=dimensionStats.get(dimension.dimensionKey);if(!stats)continue;stats.sum+=Math.max(0,dimension.cosine);stats.count++;}return dimensionStats;}

export function deterministicClusterKey(algorithmSelectionId,profileIds){return sha256(`${CLUSTER_ALGORITHM_VERSION}\0${algorithmSelectionId}\0${[...profileIds].sort((a,b)=>Number(a)-Number(b)).join(',')}`);}

export function buildMutualKnnGraph(profiles,neighbors,{minScore=.58,minShared=6}={}){const ordered=[...profiles].sort((a,b)=>Number(a.sampleId)-Number(b.sampleId)),parent=new Map(ordered.map(p=>[String(p.sampleId),String(p.sampleId)])),find=x=>{while(parent.get(x)!==x){parent.set(x,parent.get(parent.get(x)));x=parent.get(x);}return x;},union=(a,b)=>{a=find(a);b=find(b);if(a===b)return;parent.set(Number(a)<Number(b)?b:a,Number(a)<Number(b)?a:b);},edges=[];for(const a of ordered)for(const n of neighbors.get(String(a.sampleId))||[]){if(Number(a.sampleId)>=Number(n.sampleId)||n.pairSimilarity<minScore||n.sharedDimensionCount<minShared)continue;if((neighbors.get(String(n.sampleId))||[]).some(x=>String(x.sampleId)===String(a.sampleId)))edges.push([String(a.sampleId),String(n.sampleId)]);}edges.sort((a,b)=>Number(a[0])-Number(b[0])||Number(a[1])-Number(b[1])).forEach(e=>union(...e));const groups=new Map();for(const p of ordered){const root=find(String(p.sampleId));if(!groups.has(root))groups.set(root,[]);groups.get(root).push(p);}return{ordered,edges,groups};}

export function deterministicClusters(profiles,{algorithmSelectionId,neighborK=12,minScore=.58,minShared=6,candidateMap=null}={}) {
  const ordered=[...profiles].sort((a,b)=>Number(a.sampleId)-Number(b.sampleId));const neighbors=new Map();
  for(const a of ordered){const items=[],allowed=candidateMap?new Set(candidateMap.get(String(a.sampleId))??candidateMap.get(Number(a.sampleId))??[]):null;for(const b of ordered){if(a===b||allowed&&!allowed.has(String(b.sampleId))&&!allowed.has(Number(b.sampleId)))continue;const pair=pairSimilarity(a.vectors,b.vectors);
    if(pair.sharedDimensionCount>=minShared)items.push({sampleId:b.sampleId,...pair});}
    items.sort((x,y)=>y.pairSimilarity-x.pairSimilarity||y.sharedDimensionCount-x.sharedDimensionCount||Number(x.sampleId)-Number(y.sampleId));neighbors.set(String(a.sampleId),items.slice(0,neighborK));}
  const {groups,edges}=buildMutualKnnGraph(ordered,neighbors,{minScore,minShared}),globalTags=new Map();for(const p of ordered)for(const tag of uniqueTags(p.tags)){const id=Number(tag.id);globalTags.set(id,{tag,count:(globalTags.get(id)?.count||0)+1});}
  const clusters=[];const outliers=[];for(const members of [...groups.values()].sort((a,b)=>Number(a[0].sampleId)-Number(b[0].sampleId))){if(members.length<3){outliers.push(...members.map(x=>x.sampleId));continue;}
    const profileIds=members.map(x=>x.profileId).sort((a,b)=>Number(a)-Number(b));const clusterKey=deterministicClusterKey(algorithmSelectionId,profileIds);
    const means=members.map(a=>({sampleId:a.sampleId,mean:members.filter(b=>b!==a).map(b=>pairSimilarity(a.vectors,b.vectors)).filter(x=>x.sharedDimensionCount>=minShared).reduce((s,x,_,arr)=>s+x.pairSimilarity/arr.length,0)})).sort((a,b)=>b.mean-a.mean||Number(a.sampleId)-Number(b.sampleId));
    const eligibleClusterPairs=[];for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++){const pair=pairSimilarity(members[i].vectors,members[j].vectors);if(pair.sharedDimensionCount>=minShared)eligibleClusterPairs.push(pair.pairSimilarity);}const cohesion=eligibleClusterPairs.length?eligibleClusterPairs.reduce((a,b)=>a+b,0)/eligibleClusterPairs.length:null;
    const tagCounts=new Map();for(const member of members)for(const tag of uniqueTags(member.tags)){const id=Number(tag.id);tagCounts.set(id,{tag,count:(tagCounts.get(id)?.count||0)+1});}
    const frequencies=[...tagCounts].map(([id,x])=>({id,name:x.tag.name,kind:x.tag.kind,clusterFrequency:x.count/members.length,globalRunFrequency:(globalTags.get(id)?.count||0)/ordered.length,presentCount:x.count}));
    const commonTags=frequencies.filter(x=>x.clusterFrequency>=.5).sort((a,b)=>b.clusterFrequency-a.clusterFrequency||a.id-b.id).slice(0,5);
    const distinguishingTags=frequencies.map(x=>({...x,difference:x.clusterFrequency-x.globalRunFrequency})).filter(x=>x.difference>0&&x.presentCount>=2).sort((a,b)=>b.difference-a.difference||b.clusterFrequency-a.clusterFrequency||a.id-b.id).slice(0,5);
    const allPairs=members.length*(members.length-1)/2,dimensionContributions=DIMENSIONS.map(d=>{let sum=0,eligible=0;for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++){const a=members[i].vectors[d.key],b=members[j].vectors[d.key];if(!a||!b||BigInt(a.normSq??a.norm_sq??0)===0n||BigInt(b.normSq??b.norm_sq??0)===0n)continue;eligible++;sum+=Math.max(0,cosineQ15(a.vector,b.vector,a.normSq??a.norm_sq,b.normSq??b.norm_sq));}return{dimensionKey:d.key,label:d.label,ordinal:d.ordinal,eligiblePairCount:eligible,contribution:allPairs?sum/allPairs:0};}).sort((a,b)=>b.contribution-a.contribution||a.ordinal-b.ordinal).slice(0,3);
    clusters.push({clusterKey,members:members.map(x=>x.sampleId),representativeSampleId:means[0].sampleId,cohesion,commonTags,distinguishingTags,dimensionContributions});}
  clusters.forEach((c,i)=>{c.ordinal=i+1;c.label=c.commonTags.length?c.commonTags.map(x=>x.name).join(' · '):`结构簇 ${c.ordinal}`;const labels=c.dimensionContributions.filter(x=>x.contribution>0).map(x=>x.label);c.summary=`${c.members.length}篇作品在${labels.length?labels.join('、'):'结构维度'}呈现相近特征`;c.limitation='聚类仅描述内部结构一致性，不代表内容表现、价值或因果。';});return {clusters,outliers:outliers.sort((a,b)=>Number(a)-Number(b)),neighbors,edges};
}

function uniqueTags(tags=[]){const seen=new Set(),out=[];for(const tag of tags||[]){const id=Number(tag?.id);if(!Number.isSafeInteger(id)||seen.has(id))continue;seen.add(id);out.push(tag);}return out;}

export function quantile(values,p){const xs=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!xs.length)return null;const h=(xs.length-1)*p,l=Math.floor(h),u=Math.ceil(h);return xs[l]+(h-l)*(xs[u]-xs[l]);}
export const median=values=>quantile(values,.5);
export function cliffsDelta(present,absent){if(!present.length||!absent.length)return null;let n=0;for(const a of present)for(const b of absent)n+=a>b?1:a<b?-1:0;return n/(present.length*absent.length);}

export function xoshiro128ss(seedText){const d=createHash('sha256').update(seedText).digest();const s=[0,4,8,12].map(i=>d.readUInt32BE(i));if(s.every(x=>x===0))s[3]=1;
  const rotl=(x,k)=>((x<<k)|(x>>>(32-k)))>>>0;return()=>{const result=Math.imul(rotl(Math.imul(s[1],5)>>>0,7),9)>>>0,t=(s[1]<<9)>>>0;s[2]^=s[0];s[3]^=s[1];s[1]^=s[2];s[0]^=s[3];s[2]^=t;s[3]=rotl(s[3],11);return result/4294967296;};}

export function normalizeAccountKey({platform,sampleId,accountHandle,accountName}){const clean=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[\p{Cc}\p{Cf}]/gu,'').replace(/\s+/gu,' ').trim();
  const handle=clean(accountHandle).replace(/^@+/,'');if(handle)return{key:`${platform}:handle:${handle}`,quality:'verified_handle'};const name=clean(accountName);if(name)return{key:`${platform}:name:${name}`,quality:'name_fallback'};return{key:`missing:${sampleId}`,quality:'missing_singleton'};}

export function reliabilityLevel({nObserved,nPresent,nAbsent,presentAccounts,absentAccounts,outcomeCoverage,featureCoverage}){
  if(nObserved>=100&&nPresent>=30&&nAbsent>=30&&presentAccounts>=10&&absentAccounts>=10&&outcomeCoverage>=.9&&featureCoverage>=.9)return'stronger_descriptive';
  if(nObserved>=30&&nPresent>=10&&nAbsent>=10&&presentAccounts>=5&&absentAccounts>=5&&outcomeCoverage>=.8&&featureCoverage>=.8)return'directional';
  if(nObserved>=10&&nPresent>=5&&nAbsent>=5&&presentAccounts>=3&&absentAccounts>=3)return'exploratory';return'insufficient';}

export function bootstrapIntervals(rows,{manifestSha256,statisticKey,replicates=2000,maxDraws=10000}={}){const byAccount=new Map();for(const row of rows){if(!byAccount.has(row.accountKey))byAccount.set(row.accountKey,[]);byAccount.get(row.accountKey).push(row);}const keys=[...byAccount.keys()].sort(),random=xoshiro128ss(`${manifestSha256}|${statisticKey}`),differences=[],deltas=[];
  for(let draw=0;draw<maxDraws&&differences.length<replicates;draw++){const p=[],a=[];for(let i=0;i<keys.length;i++)for(const row of byAccount.get(keys[Math.floor(random()*keys.length)])) (row.state==='present'?p:a).push(row.value);if(!p.length||!a.length)continue;differences.push(median(p)-median(a));deltas.push(cliffsDelta(p,a));}
  return differences.length===replicates?{medianDifference:[quantile(differences,.025),quantile(differences,.975)],cliffsDelta:[quantile(deltas,.025),quantile(deltas,.975)],validReplicates:replicates}:{medianDifference:null,cliffsDelta:null,validReplicates:differences.length};}

export function describeStatistic(rows,coverage,{manifestSha256,statisticKey}={}){const observed=rows.filter(x=>['present','absent'].includes(x.state)&&Number.isFinite(x.value)),p=observed.filter(x=>x.state==='present'),a=observed.filter(x=>x.state==='absent');const level=reliabilityLevel({nObserved:observed.length,nPresent:p.length,nAbsent:a.length,presentAccounts:new Set(p.map(x=>x.accountKey)).size,absentAccounts:new Set(a.map(x=>x.accountKey)).size,...coverage});
  const base={nEligible:coverage.nEligible,nOutcomeObserved:coverage.nOutcomeObserved,nFeatureObserved:coverage.nFeatureObserved,nObserved:observed.length,nPresent:p.length,nAbsent:a.length,uniqueAccounts:new Set(observed.map(x=>x.accountKey)).size,outcomeCoverage:coverage.outcomeCoverage,featureCoverage:coverage.featureCoverage,reliability:level,causalClaimsAllowed:false};if(level==='insufficient')return{...base,present:null,absent:null,medianDifference:null,cliffsDelta:null,intervals:null,direction:null};
  const pv=p.map(x=>x.value),av=a.map(x=>x.value),difference=median(pv)-median(av);return{...base,present:{median:median(pv),q1:quantile(pv,.25),q3:quantile(pv,.75)},absent:{median:median(av),q1:quantile(av,.25),q3:quantile(av,.75)},medianDifference:difference,cliffsDelta:cliffsDelta(pv,av),intervals:bootstrapIntervals(observed,{manifestSha256,statisticKey}),direction:difference>0?'positive':difference<0?'negative':'neutral'};}

export function featureCombinationState(states){if(states.every(x=>x==='present'))return'present';if(states.every(x=>x!=='unknown')&&states.some(x=>x==='absent'))return'absent';return'unknown';}

export function safeSummary(value,max=160){const leaves=jsonLeaves(value);return leaves.join(' ').replace(/\s+/g,' ').trim().slice(0,max);}
