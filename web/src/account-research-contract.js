/** Shared, executable account-research-dto/1.1 browser/mock contract. */
export const ACCOUNT_RESEARCH_DTO_VERSION='account-research-dto/1.1';
export const ACCOUNT_RESEARCH_DIMENSIONS=Object.freeze([
  ['identity_positioning','账户定位','账户身份、核心承诺、差异化和边界'],
  ['audience_needs','用户需求地图','区分作者宣称对象、内容召唤对象、评论用户与推断人群'],
  ['content_supply','内容供给系统','内容支柱、栏目、选题母题、形式与更新节奏'],
  ['expression_mechanism','标志性表达','标题、开头、结构、语言、视觉与视听机制'],
  ['trust_relationship','人设与信任','专业性、真实性、自我披露、关系距离与质疑处理'],
  ['community_feedback','社群与互动','评论问题、异议、用户自我认同、作者回复与社群语言'],
  ['conversion_path','商业与转化','产品服务、行动引导、承接路径与人设匹配'],
  ['temporal_evolution','时间演化','定位、栏目、表达、互动和商业化的阶段变化'],
].map(([dimensionKey,label,description],index)=>Object.freeze({dimensionKey,ordinal:index+1,label,description})));

const sorted=value=>[...value].sort();
function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`${label} must be an object`);return value;}
function exact(value,keys,label){object(value,label);const actual=sorted(Object.keys(value)),expected=sorted(keys);if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index]))throw new TypeError(`${label} fields mismatch: ${actual.join(',')}`);return value;}
function array(value,label){if(!Array.isArray(value))throw new TypeError(`${label} must be an array`);return value;}
function version(value,label){if(value.dtoVersion!==ACCOUNT_RESEARCH_DTO_VERSION)throw new TypeError(`${label} dto version mismatch`);}
function permissions(value,label){exact(value,['canRead','canCreateRun','canRerun','canReview'],label);for(const key of Object.keys(value))if(typeof value[key]!=='boolean')throw new TypeError(`${label}.${key} must be boolean`);}
function identity(value,label){exact(value,['quality','label','needsReview','source'],label);}
function windowShape(value,label){exact(value,['start','end','label'],label);}
function humanReview(value,label){exact(value,['reviewed','total','confirmed','edited','rejected'],label);}
function runQuality(value,label){exact(value,['label','labelText','coverage','humanReview','risks'],label);exact(value.coverage,['sample','exactEvidence','time','media','comments'],`${label}.coverage`);humanReview(value.humanReview,`${label}.humanReview`);array(value.risks,`${label}.risks`);}
function sampleRef(value,label){exact(value,['sampleId','title','publishedAt','contentType','inclusionReasons'],label);array(value.inclusionReasons,`${label}.inclusionReasons`);}

export function assertAccountResearchEvidenceDto(value,label='evidence'){
  exact(value,['dtoVersion','evidenceId','direction','sampleId','sampleTitle','sourceKind','quoteText','locator'],label);version(value,label);object(value.locator,`${label}.locator`);
  if(!['support','challenge'].includes(value.direction))throw new TypeError(`${label}.direction invalid`);
  if(!['body','image','video','comment','profile'].includes(value.sourceKind))throw new TypeError(`${label}.sourceKind invalid`);
  const locatorKeys=Object.keys(value.locator);if(!locatorKeys.some(key=>['startOffset','imageIndex','timeStartMs','commentRef','profileField'].includes(key)))throw new TypeError(`${label}.locator is not exact`);
  return value;
}

export function assertAccountResearchClaimDto(value,label='claim'){
  exact(value,['dtoVersion','claimId','dimensionKey','patternCode','contentGoal','claimType','claimText','operationalDefinition','eligibleCount','presentCount','prevalence','stability','timeCoverage','limitations','representativeSamples','counterexamples','sampleScope','quality','decision','causalClaimsAllowed','evidence'],label);version(value,label);
  if(value.patternCode!==null&&!/^[a-z0-9_]{3,64}$/.test(value.patternCode))throw new TypeError(`${label}.patternCode invalid`);
  if(value.dimensionKey==='content_supply'&&value.claimType!=='insufficient'){if(!['traffic','persona','expertise','relationship','conversion','mixed'].includes(value.contentGoal))throw new TypeError(`${label}.contentGoal invalid`);}else if(value.contentGoal!==null)throw new TypeError(`${label}.contentGoal must be null`);
  if(!['observation','interpretation','hypothesis','insufficient'].includes(value.claimType))throw new TypeError(`${label}.claimType invalid`);
  exact(value.stability,['level','label'],`${label}.stability`);exact(value.timeCoverage,['start','end','buckets','label'],`${label}.timeCoverage`);array(value.timeCoverage.buckets,`${label}.timeCoverage.buckets`);
  exact(value.quality,['label','formulaVersion','aiConfidenceIgnored'],`${label}.quality`);assertAccountResearchDecisionDto(value.decision,`${label}.decision`);
  for(const [index,item] of array(value.representativeSamples,`${label}.representativeSamples`).entries())sampleRef(item,`${label}.representativeSamples[${index}]`);
  for(const [index,item] of array(value.counterexamples,`${label}.counterexamples`).entries())sampleRef(item,`${label}.counterexamples[${index}]`);
  exact(value.sampleScope,['auditable','eligibleSamples','presentSamples'],`${label}.sampleScope`);if(typeof value.sampleScope.auditable!=='boolean')throw new TypeError(`${label}.sampleScope.auditable invalid`);
  for(const key of ['eligibleSamples','presentSamples'])for(const [index,item]of array(value.sampleScope[key],`${label}.sampleScope.${key}`).entries())sampleRef(item,`${label}.sampleScope.${key}[${index}]`);
  if(value.sampleScope.auditable){const eligibleIds=new Set(value.sampleScope.eligibleSamples.map(item=>String(item.sampleId))),presentIds=value.sampleScope.presentSamples.map(item=>String(item.sampleId));if(eligibleIds.size!==value.eligibleCount||new Set(presentIds).size!==value.presentCount||presentIds.some(id=>!eligibleIds.has(id)))throw new TypeError(`${label}.sampleScope counts or subsets mismatch`);}
  for(const [index,item] of array(value.evidence,`${label}.evidence`).entries())assertAccountResearchEvidenceDto(item,`${label}.evidence[${index}]`);
  return value;
}

export function assertAccountResearchDecisionDto(value,label='decision'){
  exact(value,['dtoVersion','status','note','decidedBy','decidedAt'],label);version(value,label);if(!['pending','confirmed','edited','rejected'].includes(value.status))throw new TypeError(`${label}.status invalid`);return value;
}

export function assertAccountResearchRunDto(value,label='run'){
  exact(value,['dtoVersion','schemaVersion','runId','version','status','createdAt','completedAt','observationWindow','sampling','quality','contentMatrix','saturation','reproducibility','dimensions'],label);version(value,label);windowShape(value.observationWindow,`${label}.observationWindow`);
  exact(value.sampling,['mode','eligibleCount','frozenSampleCount','maxSamples','coverage','items','warnings'],`${label}.sampling`);exact(value.sampling.coverage,['publishedAt','body','media','comments'],`${label}.sampling.coverage`);
  for(const [index,item] of array(value.sampling.items,`${label}.sampling.items`).entries())sampleRef(item,`${label}.sampling.items[${index}]`);array(value.sampling.warnings,`${label}.sampling.warnings`);runQuality(value.quality,`${label}.quality`);
  exact(value.reproducibility,['samplingRuleVersion','qualityFormulaVersion','modelVersion','promptVersion','inputDigest'],`${label}.reproducibility`);
  exact(value.contentMatrix,['status','periods','rows','membershipTotal','uniqueSampleCount','limitations'],`${label}.contentMatrix`);array(value.contentMatrix.periods,`${label}.contentMatrix.periods`);array(value.contentMatrix.limitations,`${label}.contentMatrix.limitations`);
  if(JSON.stringify(value.contentMatrix.periods)!==JSON.stringify(['early','middle','recent','unknown']))throw new TypeError(`${label}.contentMatrix periods invalid`);const matrixPatterns=new Set(),matrixUnion=new Set();let matrixMemberships=0;
  for(const [index,row]of array(value.contentMatrix.rows,`${label}.contentMatrix.rows`).entries()){exact(row,['patternCode','contentGoal','sampleIds','count','cells'],`${label}.contentMatrix.rows[${index}]`);if(!/^[a-z0-9_]{3,64}$/.test(row.patternCode)||matrixPatterns.has(row.patternCode)||!['traffic','persona','expertise','relationship','conversion','mixed'].includes(row.contentGoal))throw new TypeError(`${label}.contentMatrix row identity invalid`);matrixPatterns.add(row.patternCode);const rowIds=array(row.sampleIds,`${label}.contentMatrix.rows[${index}].sampleIds`).map(String),rowSet=new Set(rowIds);if(rowSet.size!==rowIds.length||row.count!==rowIds.length)throw new TypeError(`${label}.contentMatrix row count invalid`);rowIds.forEach(id=>matrixUnion.add(id));matrixMemberships+=rowIds.length;const cellKeys=new Set(),cellUnion=new Set();let cellTotal=0;for(const [cellIndex,cell]of array(row.cells,`${label}.contentMatrix.rows[${index}].cells`).entries()){exact(cell,['format','period','sampleIds','count'],`${label}.contentMatrix.rows[${index}].cells[${cellIndex}]`);const key=`${cell.format}\u0000${cell.period}`;if(!String(cell.format).trim()||!['early','middle','recent','unknown'].includes(cell.period)||cellKeys.has(key))throw new TypeError(`${label}.contentMatrix cell identity invalid`);cellKeys.add(key);const ids=array(cell.sampleIds,`${label}.contentMatrix.rows[${index}].cells[${cellIndex}].sampleIds`).map(String),set=new Set(ids);if(set.size!==ids.length||cell.count!==ids.length||ids.some(id=>!rowSet.has(id)))throw new TypeError(`${label}.contentMatrix cell count invalid`);ids.forEach(id=>cellUnion.add(id));cellTotal+=ids.length;}if(cellTotal!==rowIds.length||cellUnion.size!==rowSet.size)throw new TypeError(`${label}.contentMatrix row cells mismatch`);}
  if(value.contentMatrix.membershipTotal!==matrixMemberships||value.contentMatrix.uniqueSampleCount!==matrixUnion.size||value.contentMatrix.status!==(matrixPatterns.size?'measured':'insufficient'))throw new TypeError(`${label}.contentMatrix totals invalid`);
  exact(value.saturation,['ruleVersion','status','reached','threshold','batchSize','totalCodes','batches','observations','limitations'],`${label}.saturation`);const batches=array(value.saturation.batches,`${label}.saturation.batches`);if(value.saturation.ruleVersion!=='saturation/1.0'||value.saturation.threshold!==.05||value.saturation.batchSize!==5||JSON.stringify(value.saturation.observations)!==JSON.stringify(batches)||!array(value.saturation.limitations,`${label}.saturation.limitations`).length)throw new TypeError(`${label}.saturation contract invalid`);const seenCodes=new Set();let cumulative=0;batches.forEach((batch,index)=>{exact(batch,['batch','codes','codeCount','newCodeCount','cumulativeCodeCount','newCodeRatio','newCodes'],`${label}.saturation.batches[${index}]`);const codes=array(batch.codes,`${label}.saturation.batches[${index}].codes`),newCodes=array(batch.newCodes,`${label}.saturation.batches[${index}].newCodes`);if(batch.batch!==index+1||new Set(codes).size!==codes.length||new Set(newCodes).size!==newCodes.length||codes.some(code=>typeof code!=='string'||!/^[a-z_]+\/[a-z0-9_]{3,64}$/.test(code)||seenCodes.has(code))||JSON.stringify(codes)!==JSON.stringify(newCodes))throw new TypeError(`${label}.saturation codes invalid`);codes.forEach(code=>seenCodes.add(code));cumulative+=codes.length;const ratio=codes.length/Math.max(1,cumulative);if(batch.codeCount!==codes.length||batch.newCodeCount!==newCodes.length||batch.cumulativeCodeCount!==cumulative||Math.abs(batch.newCodeRatio-ratio)>1e-12)throw new TypeError(`${label}.saturation batch counts invalid`);});const saturationStatus=batches.length>=3&&seenCodes.size>0?'measured':'insufficient',reached=saturationStatus==='measured'&&batches.slice(-2).every(batch=>batch.newCodeRatio<=.05);if(value.saturation.totalCodes!==seenCodes.size||value.saturation.status!==saturationStatus||value.saturation.reached!==reached)throw new TypeError(`${label}.saturation result invalid`);
  const dimensions=array(value.dimensions,`${label}.dimensions`);if(dimensions.length!==ACCOUNT_RESEARCH_DIMENSIONS.length)throw new TypeError(`${label}.dimensions length mismatch`);let totalClaims=0;
  dimensions.forEach((dimension,index)=>{exact(dimension,['dimensionKey','ordinal','label','description','claims'],`${label}.dimensions[${index}]`);if(dimension.dimensionKey!==ACCOUNT_RESEARCH_DIMENSIONS[index].dimensionKey)throw new TypeError(`${label}.dimensions order mismatch`);const claims=array(dimension.claims,`${label}.dimensions[${index}].claims`);if(claims.length<1||claims.length>5)throw new TypeError(`${label}.dimensions[${index}] claims cardinality invalid`);totalClaims+=claims.length;const patterns=new Set();claims.forEach((claim,claimIndex)=>{assertAccountResearchClaimDto(claim,`${label}.dimensions[${index}].claims[${claimIndex}]`);if(value.schemaVersion==='account-research/1.1'){if(!claim.patternCode||patterns.has(claim.patternCode))throw new TypeError(`${label}.dimensions[${index}] patternCode invalid or duplicated`);patterns.add(claim.patternCode);}});});if(totalClaims<8||totalClaims>40)throw new TypeError(`${label}.claims total invalid`);return value;
}

export function assertAccountResearchConfigDto(value){
  exact(value,['dtoVersion','dimensions','claimTypes','qualityLabels','permissions','causalClaimsAllowed'],'config');version(value,'config');permissions(value.permissions,'config.permissions');array(value.claimTypes,'config.claimTypes');array(value.qualityLabels,'config.qualityLabels');
  const dimensions=array(value.dimensions,'config.dimensions');if(dimensions.length!==8)throw new TypeError('config.dimensions length mismatch');dimensions.forEach((item,index)=>{exact(item,['dimensionKey','ordinal','label','description'],`config.dimensions[${index}]`);if(item.dimensionKey!==ACCOUNT_RESEARCH_DIMENSIONS[index].dimensionKey||item.label!==ACCOUNT_RESEARCH_DIMENSIONS[index].label)throw new TypeError('config.dimensions order mismatch');});return value;
}

export function assertAccountResearchListDto(value){
  exact(value,['dtoVersion','items','total','page','pageSize','permissions'],'list');version(value,'list');permissions(value.permissions,'list.permissions');array(value.items,'list.items').forEach((item,index)=>{const label=`list.items[${index}]`;exact(item,['dtoVersion','accountId','stableKey','platform','platformLabel','displayName','handle','identity','currentRunId','versionCount','frozenSampleCount','observationWindow','quality','updatedAt'],label);version(item,label);identity(item.identity,`${label}.identity`);if(item.observationWindow)windowShape(item.observationWindow,`${label}.observationWindow`);if(item.quality)runQuality(item.quality,`${label}.quality`);});return value;
}

export function assertAccountResearchDetailDto(value){
  exact(value,['dtoVersion','account','currentRunId','runs','permissions'],'detail');version(value,'detail');permissions(value.permissions,'detail.permissions');exact(value.account,['accountId','stableKey','platform','platformLabel','displayName','handle','profileUrl','identity'],'detail.account');identity(value.account.identity,'detail.account.identity');array(value.runs,'detail.runs').forEach((run,index)=>assertAccountResearchRunDto(run,`detail.runs[${index}]`));return value;
}

export function assertAccountResearchRunMutationDto(value){exact(value,['dtoVersion','accountId','run','currentRunId'],'runMutation');version(value,'runMutation');assertAccountResearchRunDto(value.run,'runMutation.run');return value;}
export function assertAccountResearchDecisionMutationDto(value){exact(value,['dtoVersion','accountId','runId','claimId','decision','claim'],'decisionMutation');version(value,'decisionMutation');assertAccountResearchDecisionDto(value.decision,'decisionMutation.decision');assertAccountResearchClaimDto(value.claim,'decisionMutation.claim');return value;}
export function assertAccountResearchErrorDto(value){exact(value,['dtoVersion','error'],'errorDto');version(value,'errorDto');exact(value.error,['status','code','message'],'errorDto.error');if(!Number.isInteger(value.error.status)||value.error.status<400||value.error.status>599||!/^[A-Z0-9_]+$/.test(value.error.code)||/(?:stack|file:\/\/|[A-Z]:\\|token|password|secret|api.?key)/iu.test(value.error.message))throw new TypeError('errorDto is unsafe');return value;}

export function accountResearchError(status,code,message){const data={dtoVersion:ACCOUNT_RESEARCH_DTO_VERSION,error:{status,code,message}};assertAccountResearchErrorDto(data);return Object.assign(new Error(message),{status,code,data});}
