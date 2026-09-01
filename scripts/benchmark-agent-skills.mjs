/**
 * 项目 skills 的确定性对照评测。
 *
 * baseline: 只有精简后的 AGENTS.md。
 * with_skill: AGENTS.md + 当前任务应激活的 SKILL.md。
 *
 * 这不是模型能力跑分；它验证的是“激活 skill 后，完成该任务所需的项目契约是否
 * 明确进入上下文”，同时检查 skill 结构、路由和 eval 数据是否完整。输出遵循
 * skill-creator benchmark.json 的核心字段，便于后续接入真实模型 A/B 运行。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS_ROOT = join(ROOT, '.agents', 'skills');
const CONTRACT_PATH = join(ROOT, '.agents', 'evals', 'project-skills-contract.json');
const JSON_OUT = join(ROOT, 'docs', 'agent-skills-benchmark.json');
const MD_OUT = join(ROOT, 'docs', 'agent-skills-benchmark.md');

const contractSource = await readFile(CONTRACT_PATH, 'utf8');
const contract = JSON.parse(contractSource);
const globalRules = await readFile(join(ROOT, 'AGENTS.md'), 'utf8');
const skillNames = [...new Set(contract.cases.flatMap(item => item.skills))];
const skills = new Map();

for (const name of skillNames) {
  const skillPath = join(SKILLS_ROOT, name, 'SKILL.md');
  const content = await readFile(skillPath, 'utf8');
  const frontmatterName = /^---\s*[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?\n---/.exec(content)?.[1]?.trim();
  assert.equal(frontmatterName, name, `${name}: frontmatter name must match its directory`);
  assert.match(content, /\n## Mission\n/, `${name}: Mission section is required`);
  assert.ok(
    /\n## (?:Workflow|Local Commit And Push Workflow)\n/.test(content),
    `${name}: an operational workflow section is required`,
  );
  assert.ok(
    /\n## (?:Boundaries|Hard Boundaries|Hard Architecture Rules)\n/.test(content),
    `${name}: explicit boundaries are required`,
  );
  assert.ok(
    /\n## (?:Final Review|Final Handoff Format)\n/.test(content),
    `${name}: a final review or handoff section is required`,
  );
  assert.ok(lineCount(content) < 500, `${name}: SKILL.md must stay below 500 lines`);

  const evals = JSON.parse(await readFile(join(SKILLS_ROOT, name, 'evals', 'evals.json'), 'utf8'));
  assert.equal(evals.skill_name, name, `${name}: evals skill_name must match`);
  assert.ok(evals.evals.length >= 2, `${name}: at least two realistic evals are required`);
  assert.ok(evals.evals.every(item => item.prompt && item.expected_output && item.expectations?.length), `${name}: eval cases must include prompts, expected outputs, and expectations`);

  assert.ok(globalRules.includes(`.agents/skills/${name}/SKILL.md`), `${name}: AGENTS.md must route to this skill`);
  skills.set(name, { content, evalCount: evals.evals.length, evals: JSON.stringify(evals) });
}

const inputHash = createHash('sha256')
  .update(globalRules)
  .update(contractSource)
  .update([...skills.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${name}\n${item.content}\n${item.evals}`).join('\n'))
  .digest('hex');
let previous = null;
try { previous = JSON.parse(await readFile(JSON_OUT, 'utf8')); } catch { /* first run */ }
const timestamp = previous?.metadata?.input_sha256 === inputHash
  ? previous.metadata.timestamp
  : new Date().toISOString();

const runs = [];
for (const item of contract.cases) {
  const withContext = [globalRules, ...item.skills.map(name => skills.get(name).content)].join('\n\n');
  runs.push(makeRun(item, 'with_skill', withContext));
  runs.push(makeRun(item, 'without_skill', globalRules));
}

const withRuns = runs.filter(run => run.configuration === 'with_skill');
const withoutRuns = runs.filter(run => run.configuration === 'without_skill');
assert.ok(withRuns.every(run => run.result.pass_rate === 1), 'every activated-skill contract must pass 100%');

const globalLines = lineCount(globalRules);
assert.ok(globalLines < contract.baseline.legacy_startup_lines, 'the always-loaded AGENTS.md must be smaller than the legacy monolith');

const summary = {
  with_skill: summarize(withRuns),
  without_skill: summarize(withoutRuns),
};
summary.delta = {
  pass_rate: signed(summary.with_skill.pass_rate.mean - summary.without_skill.pass_rate.mean, 3),
  time_seconds: '+0.0',
  tokens: signed(summary.with_skill.tokens.mean - summary.without_skill.tokens.mean, 0),
};

const benchmark = {
  metadata: {
    skill_name: 'ideahub-project-skills',
    skill_path: '.agents/skills',
    executor_model: 'deterministic-contract-check',
    analyzer_model: 'deterministic-contract-check',
    timestamp,
    input_sha256: inputHash,
    evals_run: contract.cases.map(item => item.id),
    runs_per_configuration: 1,
    baseline: contract.baseline.name,
    legacy_startup_lines: contract.baseline.legacy_startup_lines,
    current_startup_lines: globalLines,
    startup_line_reduction: Number((1 - globalLines / contract.baseline.legacy_startup_lines).toFixed(3)),
    skill_eval_count: [...skills.values()].reduce((sum, item) => sum + item.evalCount, 0),
  },
  runs,
  run_summary: summary,
  notes: [
    'This deterministic benchmark checks instruction-contract coverage, not model output quality.',
    'The baseline receives only AGENTS.md; with_skill receives AGENTS.md plus the task-matched skills.',
    'All activated-skill cases must pass every contract marker before this script exits successfully.',
  ],
};

await writeFile(JSON_OUT, JSON.stringify(benchmark, null, 2) + '\n');
await writeFile(MD_OUT, renderMarkdown(benchmark));

console.log(`Agent skills benchmark: with ${pct(summary.with_skill.pass_rate.mean)} vs baseline ${pct(summary.without_skill.pass_rate.mean)}`);
console.log(`Always-loaded rules: ${contract.baseline.legacy_startup_lines} -> ${globalLines} lines (${pct(benchmark.metadata.startup_line_reduction)} reduction)`);
console.log(`Eval prompts: ${benchmark.metadata.skill_eval_count}; contract cases: ${contract.cases.length}`);
console.log(`Report: ${MD_OUT}`);

function makeRun(item, configuration, context) {
  const expectations = item.expectations.map(expectation => {
    const missing = expectation.patterns.filter(pattern => !context.includes(pattern));
    return {
      text: expectation.text,
      passed: missing.length === 0,
      evidence: missing.length
        ? `Missing contract marker(s): ${missing.join(', ')}`
        : `Found contract marker(s): ${expectation.patterns.join(', ')}`,
    };
  });
  const passed = expectations.filter(itemExpectation => itemExpectation.passed).length;
  const lines = lineCount(context);
  return {
    eval_id: item.id,
    eval_name: item.name,
    configuration,
    run_number: 1,
    result: {
      pass_rate: Number((passed / expectations.length).toFixed(3)),
      passed,
      failed: expectations.length - passed,
      total: expectations.length,
      time_seconds: 0,
      tokens: Math.ceil(context.length / 4),
      context_lines: lines,
      tool_calls: 0,
      errors: 0,
    },
    expectations,
    notes: configuration === 'with_skill' ? [`Activated: ${item.skills.join(', ')}`] : ['Only AGENTS.md loaded'],
  };
}

function summarize(items) {
  const values = key => items.map(item => item.result[key]);
  return {
    pass_rate: stats(values('pass_rate')),
    time_seconds: stats(values('time_seconds')),
    tokens: stats(values('tokens')),
    context_lines: stats(values('context_lines')),
  };
}

function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean: Number(mean.toFixed(3)),
    stddev: Number(Math.sqrt(variance).toFixed(3)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function renderMarkdown(data) {
  const rows = contract.cases.map(item => {
    const withRun = data.runs.find(run => run.eval_id === item.id && run.configuration === 'with_skill');
    const withoutRun = data.runs.find(run => run.eval_id === item.id && run.configuration === 'without_skill');
    return `| ${item.name} | ${item.skills.join('<br>')} | ${pct(withRun.result.pass_rate)} | ${pct(withoutRun.result.pass_rate)} | ${withRun.result.context_lines} / ${withoutRun.result.context_lines} |`;
  }).join('\n');
  return `# IdeaHub Project Skills Benchmark

这是项目 skills 的确定性契约对照，不冒充模型能力跑分。baseline 只加载精简后的 \`AGENTS.md\`，with-skill 额外加载任务命中的 skills，再检查该任务所需规则是否明确进入上下文。

## Summary

- 激活 skills 后契约通过率：${pct(data.run_summary.with_skill.pass_rate.mean)}
- 仅全局规则通过率：${pct(data.run_summary.without_skill.pass_rate.mean)}
- 常驻规则：${data.metadata.legacy_startup_lines} → ${data.metadata.current_startup_lines} 行，减少 ${pct(data.metadata.startup_line_reduction)}
- 行为 eval 提示：${data.metadata.skill_eval_count} 条
- 确定性对照场景：${contract.cases.length} 条

| 场景 | 激活 skills | with-skill | global only | 上下文行数（with / baseline） |
|---|---|---:|---:|---:|
${rows}

## Interpretation

拆分后的全局文件只保留始终有效的安全规则。具体任务激活 skill 后会上下文更多，但这些内容与当前任务直接相关，并补齐原全局规则没有覆盖的架构、审美、验收、权限、迁移、Collector 和发布决策。

完整逐项证据见 \`docs/agent-skills-benchmark.json\`。真实模型 A/B 可直接使用各 skill 的 \`evals/evals.json\` 扩展，不应把本确定性检查解释成模型质量结论。
`;
}

function lineCount(text) {
  return text.split(/\r?\n/).length;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value, digits) {
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(digits)}`;
}
