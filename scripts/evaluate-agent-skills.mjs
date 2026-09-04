#!/usr/bin/env node

/**
 * Vendor-neutral real-agent evaluation harness for IdeaHub project skills.
 *
 * An external runner receives one JSON request on stdin and must return one
 * JSON response on stdout. Expected criteria are withheld from task runners
 * and shown only to a fresh blind judge. Disposable fixture verification,
 * execution source bans, and routing remain deterministic; none is an overall score.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwnedProcess, terminateOwnedProcessTree } from './lib/owned-process-tree.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_SUITE = join(ROOT, '.agents', 'evals', 'agent-evaluation-suite.json');
const DEFAULT_OUTPUT_ROOT = join(ROOT, 'scripts', '.agent-evals');
const PROTOCOL = 'ideahub-agent-eval/v1';
const HARNESS_VERSION = '1.1.0';
const TEXT_RESOURCE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.js', '.mjs', '.css', '.html']);

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const suitePath = resolve(ROOT, args.suite || DEFAULT_SUITE);
  const suiteText = await readFile(suitePath, 'utf8');
  const suite = JSON.parse(suiteText);
  const catalog = await loadSkillCatalog(join(ROOT, '.agents', 'skills'));
  validateSuite(suite, catalog);
  await validateSuiteFiles(suite);

  const plan = buildPlan(suite, args, catalog);
  const planSummary = {
    schema_version: 1,
    kind: 'agent-evaluation-plan',
    protocol: PROTOCOL,
    suite: relativePath(suitePath),
    suite_sha256: sha256(suiteText),
    selected_trigger_cases: new Set(plan.filter(item => item.kind === 'trigger').map(item => item.case.id)).size,
    runner_invocations: plan.length,
    planned_judge_invocations: countBehaviorPairs(plan),
    total_external_invocations: plan.length + countBehaviorPairs(plan),
    selected_behavior_cases: new Set(plan.filter(item => item.kind === 'behavior').map(item => item.case.id)).size,
    selected_execution_cases: new Set(plan.filter(item => item.kind === 'execution').map(item => item.case.id)).size,
    runs_per_behavior_variant: args.runs ?? suite.runs_per_variant,
    runs_per_trigger_case: args.triggerRuns ?? suite.runs_per_trigger,
    runs_per_execution_variant: args.executionRuns ?? suite.runs_per_execution_variant,
    disclaimer: 'A plan contains no agent result and no quality score.',
  };

  if (args.validateOnly) {
    emit(args.json, {
      ...planSummary,
      kind: 'agent-evaluation-suite-validation',
      ok: true,
      message: 'Suite, skill catalog, and case references are valid.',
    });
    process.exit(0);
  }

  if (args.dryRun) {
    emit(args.json, planSummary);
    process.exit(0);
  }

  if (!args.runner) throw new Error('Actual evaluation requires --runner <executable>. Use --dry-run to inspect the plan.');

  const outputDir = resolve(ROOT, args.output || join(DEFAULT_OUTPUT_ROOT, timestampForPath()));
  if (!isWithin(ROOT, outputDir)) throw new Error('--output must stay inside the repository.');
  await mkdir(join(outputDir, 'runs'), { recursive: true });

  const globalInstructions = await readFile(join(ROOT, 'AGENTS.md'), 'utf8');
  const runRecords = [];
  const responseByRunId = new Map();
  for (const item of plan) {
    const request = await buildRunnerRequest({
      item,
      suite,
      suiteHash: planSummary.suite_sha256,
      catalog,
      globalInstructions,
    });
    const runDir = join(outputDir, 'runs', request.run_id);
    await mkdir(runDir, { recursive: true });
    await writeJson(join(runDir, 'request.json'), request);

    let record;
    try {
      const invocation = await invokeRunner({
        executable: args.runner,
        runnerArgs: args.runnerArgs,
        request,
        timeoutMs: args.timeoutMs,
      });
      await writeFile(join(runDir, 'runner.stderr.log'), invocation.stderr, 'utf8');
      const response = parseRunnerResponse(invocation.stdout, request, catalog, args.allowFixture);
      await writeJson(join(runDir, 'response.json'), response);
      record = gradeResponse(item, response, invocation.elapsedMs);
      responseByRunId.set(request.run_id, response);
    } catch (error) {
      record = {
        run_id: request.run_id,
        kind: item.kind,
        case_id: item.case.id,
        variant: item.variant,
        repetition: item.repetition,
        completed: false,
        passed: false,
        error: error.message,
      };
    }
    await writeJson(join(runDir, 'result.json'), record);
    runRecords.push(record);
    if (!args.quiet) printRun(record);
  }

  const judgeRecords = await runBlindJudges({
    plan,
    runRecords,
    responseByRunId,
    suite,
    suiteHash: planSummary.suite_sha256,
    outputDir,
    catalog,
    executable: args.judgeRunner || args.runner,
    runnerArgs: args.judgeRunner ? args.judgeRunnerArgs : args.runnerArgs,
    timeoutMs: args.judgeTimeoutMs || args.timeoutMs,
    allowFixture: args.allowFixture,
    quiet: args.quiet,
  });

  const report = makeReport({
    suite,
    suitePath,
    suiteHash: planSummary.suite_sha256,
    outputDir,
    args,
    runRecords,
    judgeRecords,
  });
  await writeJson(join(outputDir, 'report.json'), report);
  await writeFile(join(outputDir, 'report.md'), renderMarkdown(report), 'utf8');

  emit(args.json, args.json ? report : {
    completed: report.summary.completed_runs,
    failed_runner_invocations: report.summary.failed_runner_invocations,
    behavior: report.summary.behavior,
    execution: report.summary.execution,
    trigger: report.summary.trigger,
    output: relativePath(outputDir),
    disclaimer: report.disclaimer,
  });

  if (report.summary.failed_runner_invocations > 0) process.exitCode = 1;
  else if (args.requirePass && !report.summary.acceptance_contracts_passed) process.exitCode = 2;
} catch (error) {
  console.error(`Agent evaluation failed: ${error.message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {
    suite: null,
    runner: null,
    runnerArgs: [],
    judgeRunner: null,
    judgeRunnerArgs: [],
    output: null,
    kind: 'all',
    cases: [],
    runs: null,
    triggerRuns: null,
    executionRuns: null,
    timeoutMs: 300_000,
    judgeTimeoutMs: null,
    dryRun: false,
    validateOnly: false,
    requirePass: false,
    allowFixture: false,
    quiet: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--suite') args.suite = requireOptionValue(argv, ++i, '--suite');
    else if (arg === '--runner') args.runner = requireOptionValue(argv, ++i, '--runner');
    else if (arg === '--runner-arg') args.runnerArgs.push(requireAnyValue(argv, ++i, '--runner-arg'));
    else if (arg === '--judge-runner') args.judgeRunner = requireOptionValue(argv, ++i, '--judge-runner');
    else if (arg === '--judge-runner-arg') args.judgeRunnerArgs.push(requireAnyValue(argv, ++i, '--judge-runner-arg'));
    else if (arg === '--output') args.output = requireOptionValue(argv, ++i, '--output');
    else if (arg === '--kind') args.kind = requireOptionValue(argv, ++i, '--kind');
    else if (arg === '--case') args.cases.push(requireOptionValue(argv, ++i, '--case'));
    else if (arg === '--runs') args.runs = positiveInteger(requireOptionValue(argv, ++i, '--runs'), '--runs', 10);
    else if (arg === '--trigger-runs') args.triggerRuns = positiveInteger(requireOptionValue(argv, ++i, '--trigger-runs'), '--trigger-runs', 10);
    else if (arg === '--execution-runs') args.executionRuns = positiveInteger(requireOptionValue(argv, ++i, '--execution-runs'), '--execution-runs', 5);
    else if (arg === '--timeout-ms') args.timeoutMs = positiveInteger(requireOptionValue(argv, ++i, '--timeout-ms'), '--timeout-ms', 3_600_000);
    else if (arg === '--judge-timeout-ms') args.judgeTimeoutMs = positiveInteger(requireOptionValue(argv, ++i, '--judge-timeout-ms'), '--judge-timeout-ms', 3_600_000);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--validate-only') args.validateOnly = true;
    else if (arg === '--require-pass') args.requirePass = true;
    else if (arg === '--allow-fixture') args.allowFixture = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--json') args.json = true;
    else throw new Error(`Unknown option: ${arg}. Run with --help.`);
  }
  if (!['all', 'behavior', 'trigger', 'execution'].includes(args.kind)) throw new Error('--kind must be all, behavior, trigger, or execution.');
  if (args.dryRun && args.validateOnly) throw new Error('Choose either --dry-run or --validate-only.');
  return args;
}

function printHelp() {
  console.log(`IdeaHub real-agent A/B and trigger evaluation

Usage:
  node scripts/evaluate-agent-skills.mjs --validate-only
  node scripts/evaluate-agent-skills.mjs --dry-run [filters]
  node scripts/evaluate-agent-skills.mjs --runner <executable> [options]

Runner protocol:
  The executable receives one ${PROTOCOL} JSON request on stdin and returns
  exactly one JSON response on stdout. Logs belong on stderr. No provider or
  model is hardcoded by this harness.

Options:
  --suite <path>         Evaluation suite JSON
  --runner <executable>  External runner executable for actual evaluations
  --runner-arg <value>   Argument passed to the runner; repeat as needed
  --judge-runner <path>  Optional independent judge runner (default: runner)
  --judge-runner-arg <v> Argument passed to the judge runner; repeat as needed
  --output <directory>   Result directory inside the repository
  --kind <kind>          all, behavior, trigger, or execution (default: all)
  --case <id>            Run one case; repeat to select more cases
  --runs <1-10>          Override repetitions per behavior variant
  --trigger-runs <1-10>  Override repetitions per trigger case
  --execution-runs <1-5> Override repetitions per disposable execution variant
  --timeout-ms <number>  Per-run timeout (default: 300000)
  --judge-timeout-ms <n> Per-judge timeout (default: --timeout-ms)
  --validate-only        Validate suite and skill references without a runner
  --dry-run              Print the planned invocations without calling a runner
  --require-pass         Exit 2 when judged treatment, execution, or trigger acceptance gates fail
  --allow-fixture        Permit provenance.kind=fixture (tooling tests only)
  --quiet                Suppress per-run progress
  --json                 Emit JSON on stdout
  -h, --help             Show this help

Actual reports contain blind judged plan criteria (including prohibited behavior),
disposable execution verification, and routing contracts. They are not
an overall model-quality score.`);
}

async function loadSkillCatalog(skillRoot) {
  const entries = (await readdir(skillRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const catalog = new Map();
  for (const entry of entries) {
    const skillPath = join(skillRoot, entry.name, 'SKILL.md');
    const content = await readFile(skillPath, 'utf8');
    const metadata = readMetadata(content, skillPath);
    if (metadata.name !== entry.name) throw new Error(`${relativePath(skillPath)} name does not match its directory.`);
    catalog.set(entry.name, {
      name: entry.name,
      description: metadata.description,
      version: metadata.version || null,
      path: relativePath(skillPath),
      absolutePath: skillPath,
      content,
      sha256: sha256(content),
    });
  }
  return catalog;
}

function readMetadata(content, path) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(normalized);
  if (!match) throw new Error(`${relativePath(path)} has invalid frontmatter.`);
  const lines = match[1].split('\n');
  const name = scalarLine(lines, 'name');
  const description = scalarLine(lines, 'description');
  const metadataIndex = lines.findIndex(line => /^metadata:\s*$/.test(line));
  let version = null;
  if (metadataIndex >= 0) {
    for (let i = metadataIndex + 1; i < lines.length && /^\s+/.test(lines[i]); i += 1) {
      const versionMatch = /^\s+version:\s*(.*)$/.exec(lines[i]);
      if (versionMatch) version = stripQuotes(versionMatch[1].trim());
    }
  }
  if (!name || !description) throw new Error(`${relativePath(path)} requires one-line name and description fields for evaluation.`);
  return { name, description, version };
}

function scalarLine(lines, key) {
  const match = lines.map(line => new RegExp(`^${key}:\\s*(.+)$`).exec(line)).find(Boolean);
  return match ? stripQuotes(match[1].trim()) : null;
}

function validateSuite(suite, catalog) {
  if (suite.schema_version !== 1) throw new Error('Suite schema_version must be 1.');
  if (suite.runner_protocol !== PROTOCOL) throw new Error(`Suite runner_protocol must be ${PROTOCOL}.`);
  positiveInteger(suite.runs_per_variant, 'runs_per_variant', 10);
  positiveInteger(suite.runs_per_trigger, 'runs_per_trigger', 10);
  positiveInteger(suite.runs_per_execution_variant, 'runs_per_execution_variant', 5);
  if (suite.workspace_mode !== 'read-only') throw new Error('Suite workspace_mode must be read-only.');
  if (!Array.isArray(suite.behavior_cases) || !suite.behavior_cases.length) throw new Error('Suite requires behavior_cases.');
  if (!Array.isArray(suite.trigger_cases) || !suite.trigger_cases.length) throw new Error('Suite requires trigger_cases.');
  if (!Array.isArray(suite.execution_cases) || !suite.execution_cases.length) throw new Error('Suite requires execution_cases.');
  const ids = new Set();
  for (const item of [...suite.behavior_cases, ...suite.execution_cases, ...suite.trigger_cases]) {
    if (!item?.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) throw new Error('Every case id must use lowercase kebab-case.');
    if (ids.has(item.id)) throw new Error(`Duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) throw new Error(`${item.id}: prompt is required.`);
  }
  for (const item of suite.behavior_cases) {
    validateSkillNames(item.active_skills, catalog, `${item.id}.active_skills`);
    validateCriteria(item.criteria, `${item.id}.criteria`);
  }
  for (const item of suite.trigger_cases) {
    validateSkillNames(item.expected_skills, catalog, `${item.id}.expected_skills`);
    if (item.forbidden_skills != null) validateSkillNames(item.forbidden_skills, catalog, `${item.id}.forbidden_skills`);
    if (item.allow_additional_skills != null && typeof item.allow_additional_skills !== 'boolean') {
      throw new Error(`${item.id}.allow_additional_skills must be boolean.`);
    }
  }
  for (const item of suite.execution_cases) {
    validateSkillNames(item.active_skills, catalog, `${item.id}.active_skills`);
    if (!item.fixture || typeof item.fixture !== 'object') throw new Error(`${item.id}.fixture is required.`);
    for (const field of ['path', 'workspace_subdir', 'verifier']) {
      if (typeof item.fixture[field] !== 'string' || !item.fixture[field].trim()) throw new Error(`${item.id}.fixture.${field} is required.`);
    }
    for (const field of ['required_changes', 'allowed_changes', 'hard_forbidden_content']) {
      if (!Array.isArray(item[field]) || item[field].some(value => typeof value !== 'string' || !value)) {
        throw new Error(`${item.id}.${field} must be a string array.`);
      }
    }
    if (!item.required_changes.length || !item.allowed_changes.length) throw new Error(`${item.id} requires required_changes and allowed_changes.`);
    for (const required of item.required_changes) {
      if (!item.allowed_changes.includes(required)) throw new Error(`${item.id}: required change ${required} is not allowed.`);
    }
  }
}

async function validateSuiteFiles(suite) {
  for (const item of suite.execution_cases) {
    const fixtureRoot = resolveInside(ROOT, item.fixture.path, `${item.id}.fixture.path`);
    const workspace = resolveInside(fixtureRoot, item.fixture.workspace_subdir, `${item.id}.fixture.workspace_subdir`);
    const verifier = resolveInside(fixtureRoot, item.fixture.verifier, `${item.id}.fixture.verifier`);
    if (isWithin(workspace, verifier)) throw new Error(`${item.id}: verifier must stay outside the writable fixture workspace.`);
    await readdir(workspace);
    await readFile(verifier, 'utf8');
    for (const path of [...item.required_changes, ...item.allowed_changes]) {
      if (path.includes('..') || isAbsolute(path)) throw new Error(`${item.id}: change path must be relative and cannot traverse: ${path}`);
    }
  }
}

function validateSkillNames(value, catalog, label) {
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) throw new Error(`${label} must be a string array.`);
  for (const name of value) if (!catalog.has(name)) throw new Error(`${label} references unknown skill ${name}.`);
}

function validateCriteria(criteria, label) {
  if (!criteria || typeof criteria !== 'object') throw new Error(`${label} is required.`);
  if (criteria.judge != null) {
    if (!Array.isArray(criteria.judge) || !criteria.judge.length) throw new Error(`${label}.judge must be a non-empty array.`);
    const ids = new Set();
    for (const [index, criterion] of criteria.judge.entries()) {
      if (!criterion || typeof criterion !== 'object') throw new Error(`${label}.judge[${index}] must be an object.`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(criterion.id || '')) throw new Error(`${label}.judge[${index}].id must use lowercase kebab-case.`);
      if (ids.has(criterion.id)) throw new Error(`${label}.judge contains duplicate id ${criterion.id}.`);
      ids.add(criterion.id);
      if (typeof criterion.text !== 'string' || !criterion.text.trim()) throw new Error(`${label}.judge[${index}].text is required.`);
    }
  } else {
    if (!isNonEmptyStringArray(criteria.must_include)) throw new Error(`${label}.must_include must be a non-empty string array for legacy suites.`);
  }
  const forbidden = criteria.semantic_prohibitions ?? criteria.hard_forbidden ?? criteria.must_not_include;
  if (!Array.isArray(forbidden) || forbidden.some(value => typeof value !== 'string' || !value)) {
    throw new Error(`${label}.semantic_prohibitions must be a string array.`);
  }
}

function normalizedCriteria(criteria) {
  const baseJudge = criteria.judge || criteria.must_include.map((text, index) => ({
    id: `legacy-criterion-${index + 1}`,
    text: `The answer substantively and correctly addresses: ${text}`,
  }));
  const semanticProhibitions = criteria.semantic_prohibitions ?? criteria.hard_forbidden ?? criteria.must_not_include ?? [];
  return {
    judge: [
      ...baseJudge,
      {
        id: 'avoid-prohibited-behavior',
        text: `Semantically reject unsafe shortcuts or prohibited behavior represented by these examples: ${semanticProhibitions.join('; ')}. Quoting an example solely to reject it is acceptable; recommending, normalizing, or leaving the risk unaddressed is not.`,
      },
    ],
  };
}

function buildPlan(suite, args, catalog) {
  const selected = new Set(args.cases);
  const unknown = [...selected].filter(id => ![...suite.behavior_cases, ...suite.execution_cases, ...suite.trigger_cases].some(item => item.id === id));
  if (unknown.length) throw new Error(`Unknown --case value(s): ${unknown.join(', ')}`);
  const runs = args.runs ?? suite.runs_per_variant;
  const plan = [];
  if (args.kind === 'all' || args.kind === 'behavior') {
    for (const evalCase of suite.behavior_cases) {
      if (selected.size && !selected.has(evalCase.id)) continue;
      for (let repetition = 1; repetition <= runs; repetition += 1) {
        const variants = repetition % 2 ? ['baseline', 'with_skill'] : ['with_skill', 'baseline'];
        for (const variant of variants) plan.push({ kind: 'behavior', case: evalCase, variant, repetition });
      }
    }
  }
  if (args.kind === 'all' || args.kind === 'execution') {
    const executionRuns = args.executionRuns ?? suite.runs_per_execution_variant;
    for (const evalCase of suite.execution_cases) {
      if (selected.size && !selected.has(evalCase.id)) continue;
      for (let repetition = 1; repetition <= executionRuns; repetition += 1) {
        const variants = repetition % 2 ? ['baseline', 'with_skill'] : ['with_skill', 'baseline'];
        for (const variant of variants) plan.push({ kind: 'execution', case: evalCase, variant, repetition });
      }
    }
  }
  if (args.kind === 'all' || args.kind === 'trigger') {
    const triggerRuns = args.triggerRuns ?? suite.runs_per_trigger;
    for (const evalCase of suite.trigger_cases) {
      if (selected.size && !selected.has(evalCase.id)) continue;
      for (let repetition = 1; repetition <= triggerRuns; repetition += 1) {
        plan.push({ kind: 'trigger', case: evalCase, variant: 'routing', repetition });
      }
    }
  }
  if (!plan.length) throw new Error('Filters selected no evaluation cases.');
  for (const item of plan) {
    if (item.kind === 'behavior' || item.kind === 'execution') validateSkillNames(item.case.active_skills, catalog, item.case.id);
  }
  return plan;
}

async function buildRunnerRequest({ item, suite, suiteHash, catalog, globalInstructions }) {
  const runId = `${item.kind}-${item.case.id}-${item.variant}-r${item.repetition}`;
  const availableSkills = [...catalog.values()].map(skill => ({
    name: skill.name,
    description: skill.description,
    version: skill.version,
    path: skill.path,
    sha256: skill.sha256,
  }));
  const activeNames = (item.kind === 'behavior' || item.kind === 'execution') && item.variant === 'with_skill'
    ? [...item.case.active_skills]
    : [];
  const skillContexts = [];
  for (const name of activeNames) {
    const skill = catalog.get(name);
    skillContexts.push({
      name,
      version: skill.version,
      skill_md: { path: skill.path, sha256: skill.sha256, content: skill.content },
      resources: await loadSkillResources(dirname(skill.absolutePath)),
    });
  }

  const executionFixture = item.kind === 'execution'
    ? await describeExecutionFixture(item.case)
    : null;
  return {
    protocol: PROTOCOL,
    harness_version: HARNESS_VERSION,
    suite_name: suite.name,
    suite_sha256: suiteHash,
    run_id: runId,
    kind: item.kind,
    case_id: item.case.id,
    variant: item.variant,
    repetition: item.repetition,
    prompt: item.case.prompt,
    repository: {
      root: item.kind === 'execution' ? null : ROOT,
      workspace_mode: item.kind === 'execution' ? 'disposable-write' : 'read-only',
    },
    execution_fixture: executionFixture,
    instruction_context: item.kind === 'trigger'
      ? {
          global: null,
          active_skills: [],
          suppressed_skills: [],
          available_skills: availableSkills,
          policy: 'Choose skills from metadata only. Do not open SKILL.md files before returning selected_skills.',
        }
      : item.kind === 'execution'
        ? {
            global: null,
            active_skills: skillContexts,
            suppressed_skills: [...catalog.keys()].filter(name => !activeNames.includes(name)),
            available_skills: [],
            policy: 'Use only the supplied active-skill instructions inside the disposable copied fixture. Do not read the hidden verifier or any real repository path.',
          }
        : {
          global: {
            path: 'AGENTS.md',
            sha256: sha256(globalInstructions),
            content: globalInstructions,
          },
          active_skills: skillContexts,
          suppressed_skills: [...catalog.keys()].filter(name => !activeNames.includes(name)),
          available_skills: [],
          policy: 'Use only the supplied global and active-skill instructions. Do not auto-discover or read eval files. Repository source may be inspected read-only.',
        },
    response_contract: {
      required: item.kind === 'trigger'
        ? ['protocol', 'run_id', 'status', 'selected_skills', 'provenance']
        : item.kind === 'execution'
          ? ['protocol', 'run_id', 'status', 'answer', 'execution', 'provenance']
          : ['protocol', 'run_id', 'status', 'answer', 'provenance'],
      provenance: {
        kind: 'real-agent',
        runner: 'non-empty identifier',
        model: 'non-empty identifier',
        context_isolation: 'supplied-only',
      },
      note: 'Return one JSON object on stdout. Put diagnostic logs on stderr. Expected evaluation criteria are intentionally not supplied.',
    },
  };
}

async function describeExecutionFixture(evalCase) {
  const fixtureRoot = resolveInside(ROOT, evalCase.fixture.path, `${evalCase.id}.fixture.path`);
  const workspace = resolveInside(fixtureRoot, evalCase.fixture.workspace_subdir, `${evalCase.id}.fixture.workspace_subdir`);
  const verifier = resolveInside(fixtureRoot, evalCase.fixture.verifier, `${evalCase.id}.fixture.verifier`);
  return {
    name: evalCase.id,
    source_path: fixtureRoot,
    source_sha256: await hashDirectory(fixtureRoot),
    workspace_subdir: relative(fixtureRoot, workspace).replaceAll('\\', '/'),
    verifier_path: verifier,
  };
}

async function hashDirectory(root) {
  const parts = [];
  await walk(root, async path => {
    const content = await readFile(path);
    parts.push(`${relative(root, path).replaceAll('\\', '/')}\0${sha256(content)}\n`);
  });
  return sha256(parts.sort().join(''));
}

async function loadSkillResources(skillDir) {
  const resources = [];
  for (const folder of ['references', 'assets']) {
    const folderPath = join(skillDir, folder);
    await walk(folderPath, async path => {
      if (!TEXT_RESOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return;
      const content = await readFile(path, 'utf8');
      resources.push({ path: relativePath(path), sha256: sha256(content), content });
    });
  }
  return resources.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

async function walk(path, visit) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(child, visit);
    else if (entry.isFile()) await visit(child);
  }
}

async function invokeRunner({ executable, runnerArgs, request, timeoutMs }) {
  const started = Date.now();
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawnOwnedProcess(executable, runnerArgs, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      let detail = '';
      try { await terminateOwnedProcessTree(child); }
      catch (error) { detail = ` Process-tree cleanup also failed: ${error.message}`; }
      finish(new Error(`Runner timed out after ${timeoutMs} ms and its owned process tree was terminated.${detail}`));
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    child.on('error', error => {
      if (!timedOut) finish(new Error(`Cannot start runner ${executable}: ${error.message}`));
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', (code, signal) => {
      if (timedOut) return;
      if (code !== 0) {
        finish(new Error(`Runner exited with code ${code}${signal ? ` (${signal})` : ''}: ${stderr.trim() || 'no stderr'}`));
        return;
      }
      finish(null, { stdout, stderr, elapsedMs: Date.now() - started });
    });
    child.stdin.on('error', error => {
      if (!timedOut) finish(new Error(`Cannot write runner request: ${error.message}`));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function runBlindJudges({
  plan,
  runRecords,
  responseByRunId,
  suite,
  suiteHash,
  outputDir,
  catalog,
  executable,
  runnerArgs,
  timeoutMs,
  allowFixture,
  quiet,
}) {
  const recordsById = new Map(runRecords.map(record => [record.run_id, record]));
  const judgeRecords = [];
  const pairs = behaviorPairs(plan);
  for (const pair of pairs) {
    const baselineId = `behavior-${pair.case.id}-baseline-r${pair.repetition}`;
    const withSkillId = `behavior-${pair.case.id}-with_skill-r${pair.repetition}`;
    const baselineRecord = recordsById.get(baselineId);
    const withSkillRecord = recordsById.get(withSkillId);
    const baselineResponse = responseByRunId.get(baselineId);
    const withSkillResponse = responseByRunId.get(withSkillId);
    const judgeRunId = `judge-${pair.case.id}-r${pair.repetition}`;
    const judgeDir = join(outputDir, 'judges', judgeRunId);
    await mkdir(judgeDir, { recursive: true });

    if (!baselineRecord?.completed || !withSkillRecord?.completed || !baselineResponse || !withSkillResponse) {
      const skipped = {
        run_id: judgeRunId,
        case_id: pair.case.id,
        repetition: pair.repetition,
        completed: false,
        passed: false,
        invoked: false,
        error: 'Blind judge skipped because one or both behavior candidates did not complete.',
      };
      await writeJson(join(judgeDir, 'result.json'), skipped);
      judgeRecords.push(skipped);
      if (!quiet) printJudge(skipped);
      continue;
    }

    const baselineFirst = Number.parseInt(sha256(`${suiteHash}:${pair.case.id}:${pair.repetition}`).slice(0, 2), 16) % 2 === 0;
    const mapping = baselineFirst
      ? { A: 'baseline', B: 'with_skill' }
      : { A: 'with_skill', B: 'baseline' };
    const responseForVariant = { baseline: baselineResponse, with_skill: withSkillResponse };
    const request = buildBlindJudgeRequest({
      suite,
      suiteHash,
      evalCase: pair.case,
      repetition: pair.repetition,
      judgeRunId,
      candidates: {
        A: candidatePayload(responseForVariant[mapping.A]),
        B: candidatePayload(responseForVariant[mapping.B]),
      },
    });
    await writeJson(join(judgeDir, 'request.json'), request);

    let judgeRecord;
    try {
      const invocation = await invokeRunner({ executable, runnerArgs, request, timeoutMs });
      await writeFile(join(judgeDir, 'runner.stderr.log'), invocation.stderr, 'utf8');
      const response = parseJudgeResponse(invocation.stdout, request, allowFixture);
      await writeJson(join(judgeDir, 'response.json'), response);
      judgeRecord = gradeBlindJudge({
        evalCase: pair.case,
        repetition: pair.repetition,
        mapping,
        response,
        elapsedMs: invocation.elapsedMs,
      });
    } catch (error) {
      judgeRecord = {
        run_id: judgeRunId,
        case_id: pair.case.id,
        repetition: pair.repetition,
        completed: false,
        passed: false,
        invoked: true,
        error: error.message,
      };
    }
    await writeJson(join(judgeDir, 'result.json'), judgeRecord);
    judgeRecords.push(judgeRecord);
    if (!quiet) printJudge(judgeRecord);
  }
  return judgeRecords;
}

function buildBlindJudgeRequest({ suite, suiteHash, evalCase, repetition, judgeRunId, candidates }) {
  return {
    protocol: PROTOCOL,
    harness_version: HARNESS_VERSION,
    suite_name: suite.name,
    suite_sha256: suiteHash,
    run_id: judgeRunId,
    kind: 'judge',
    case_id: evalCase.id,
    repetition,
    repository: { root: null, workspace_mode: 'read-only' },
    instruction_context: {
      global: null,
      active_skills: [],
      suppressed_skills: [],
      available_skills: [],
      policy: 'Blind judge receives only the task, rubric, and anonymized candidate data.',
    },
    judge: {
      task: evalCase.prompt,
      rubric: normalizedCriteria(evalCase.criteria).judge,
      candidates,
      policy: 'Candidate labels are randomized. Judge only the supplied outputs against the same rubric. Do not infer which condition produced either candidate. Cite concrete evidence from each candidate.',
    },
    response_contract: {
      required: ['protocol', 'run_id', 'status', 'judgment', 'provenance'],
      note: 'Return one JSON object on stdout. Variant identity and active-skill context are intentionally withheld.',
    },
  };
}

function candidatePayload(response) {
  return {
    answer: response.answer,
    evidence: response.evidence || null,
  };
}

function parseJudgeResponse(stdout, request, allowFixture) {
  const response = parseJsonObject(stdout, 'Judge runner stdout');
  validateCommonResponse(response, request, allowFixture);
  const judgment = response.judgment;
  if (!judgment || typeof judgment !== 'object' || Array.isArray(judgment)) throw new Error('Judge response requires judgment.');
  if (!['A', 'B', 'tie'].includes(judgment.preferred)) throw new Error('judgment.preferred must be A, B, or tie.');
  if (typeof judgment.rationale !== 'string' || !judgment.rationale.trim()) throw new Error('judgment.rationale is required.');
  const expectedIds = request.judge.rubric.map(criterion => criterion.id).sort();
  for (const label of ['A', 'B']) {
    const candidate = judgment.candidates?.[label];
    if (!candidate || typeof candidate !== 'object') throw new Error(`judgment.candidates.${label} is required.`);
    if (typeof candidate.overall_pass !== 'boolean') throw new Error(`judgment.candidates.${label}.overall_pass must be boolean.`);
    if (!Array.isArray(candidate.criteria)) throw new Error(`judgment.candidates.${label}.criteria must be an array.`);
    const actualIds = candidate.criteria.map(criterion => criterion?.id).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`judgment.candidates.${label}.criteria must contain every rubric id exactly once.`);
    }
    for (const criterion of candidate.criteria) {
      if (typeof criterion.passed !== 'boolean') throw new Error(`Judge criterion ${label}/${criterion.id} passed must be boolean.`);
      if (typeof criterion.evidence !== 'string' || !criterion.evidence.trim()) throw new Error(`Judge criterion ${label}/${criterion.id} requires evidence.`);
    }
  }
  return response;
}

function gradeBlindJudge({ evalCase, repetition, mapping, response, elapsedMs }) {
  const byVariant = {};
  for (const [blindLabel, variant] of Object.entries(mapping)) {
    const judged = response.judgment.candidates[blindLabel];
    const semanticPass = judged.overall_pass && judged.criteria.every(criterion => criterion.passed);
    const prohibitionCriterion = judged.criteria.find(criterion => criterion.id === 'avoid-prohibited-behavior');
    byVariant[variant] = {
      blind_label: blindLabel,
      semantic_pass: semanticPass,
      judge_overall_pass: judged.overall_pass,
      judge_criteria_passed: judged.criteria.filter(criterion => criterion.passed).length,
      judge_criteria_total: judged.criteria.length,
      judge_evidence: judged.criteria,
      prohibited_behavior_pass: prohibitionCriterion?.passed === true,
      accepted: semanticPass,
    };
  }
  const preferredVariant = response.judgment.preferred === 'tie'
    ? 'tie'
    : mapping[response.judgment.preferred];
  return {
    run_id: response.run_id,
    case_id: evalCase.id,
    repetition,
    completed: true,
    invoked: true,
    passed: byVariant.with_skill.accepted,
    preferred_variant: preferredVariant,
    rationale: response.judgment.rationale,
    variants: byVariant,
    judge_provenance: response.provenance,
    metrics: observedMetrics(response.metrics, elapsedMs),
  };
}

function behaviorPairs(plan) {
  const pairs = new Map();
  for (const item of plan.filter(item => item.kind === 'behavior')) {
    const key = `${item.case.id}:r${item.repetition}`;
    if (!pairs.has(key)) pairs.set(key, { case: item.case, repetition: item.repetition });
  }
  return [...pairs.values()];
}

function countBehaviorPairs(plan) {
  return behaviorPairs(plan).length;
}

function parseRunnerResponse(stdout, request, catalog, allowFixture) {
  const response = parseJsonObject(stdout, 'Runner stdout');
  validateCommonResponse(response, request, allowFixture);
  if (request.kind === 'judge') throw new Error('Judge responses must use the blind-judge parser.');
  return validateTaskResponse(response, request, catalog);
}

function parseJsonObject(stdout, label) {
  let response;
  try { response = JSON.parse(stdout.trim()); }
  catch (error) { throw new Error(`${label} must be exactly one JSON object: ${error.message}`); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error(`${label} must be a JSON object.`);
  return response;
}

function validateCommonResponse(response, request, allowFixture) {
  if (response.protocol !== PROTOCOL) throw new Error(`Runner response protocol must be ${PROTOCOL}.`);
  if (response.run_id !== request.run_id) throw new Error('Runner response run_id does not match the request.');
  if (response.status !== 'completed') throw new Error('Runner response status must be completed.');
  if (!response.provenance || typeof response.provenance !== 'object') throw new Error('Runner response requires provenance.');
  for (const key of ['kind', 'runner', 'model', 'context_isolation']) {
    if (typeof response.provenance[key] !== 'string' || !response.provenance[key].trim()) throw new Error(`Runner provenance.${key} is required.`);
  }
  if (response.provenance.context_isolation !== 'supplied-only') {
    throw new Error('Runner must confirm provenance.context_isolation as supplied-only.');
  }
  if (response.provenance.kind === 'fixture' && !allowFixture) {
    throw new Error('Fixture runners are rejected for real evaluations; --allow-fixture is reserved for tooling tests.');
  }
  if (!['real-agent', 'fixture'].includes(response.provenance.kind)) throw new Error('provenance.kind must be real-agent or fixture.');
  if (response.metrics != null && (typeof response.metrics !== 'object' || Array.isArray(response.metrics))) {
    throw new Error('metrics must be an object when provided.');
  }
}

function validateTaskResponse(response, request, catalog) {
  if ((request.kind === 'behavior' || request.kind === 'execution') && (typeof response.answer !== 'string' || !response.answer.trim())) {
    throw new Error(`${request.kind} responses require a non-empty answer.`);
  }
  if (request.kind === 'trigger') {
    if (!Array.isArray(response.selected_skills) || response.selected_skills.some(name => typeof name !== 'string')) {
      throw new Error('Trigger responses require selected_skills as a string array.');
    }
    const unknown = response.selected_skills.filter(name => !catalog.has(name));
    if (unknown.length) throw new Error(`Runner selected unknown skills: ${unknown.join(', ')}`);
  }
  if (request.kind === 'execution') {
    if (!response.execution || typeof response.execution !== 'object' || Array.isArray(response.execution)) {
      throw new Error('Execution responses require an execution object.');
    }
    if (!Array.isArray(response.execution.changed_files)) throw new Error('execution.changed_files must be an array.');
    for (const change of response.execution.changed_files) {
      if (!change || typeof change.path !== 'string' || !['added', 'modified', 'deleted'].includes(change.status)) {
        throw new Error('Every execution.changed_files item requires path and added/modified/deleted status.');
      }
    }
    if (!response.execution.verifier || typeof response.execution.verifier.ok !== 'boolean') {
      throw new Error('execution.verifier.ok must be boolean.');
    }
    if (!Array.isArray(response.execution.verifier.checks)) throw new Error('execution.verifier.checks must be an array.');
  }
  return response;
}

function gradeResponse(item, response, elapsedMs) {
  if (item.kind === 'behavior') {
    return {
      run_id: response.run_id,
      kind: item.kind,
      case_id: item.case.id,
      variant: item.variant,
      repetition: item.repetition,
      completed: true,
      passed: null,
      semantic_judgment: 'pending-blind-judge',
      provenance: response.provenance,
      metrics: observedMetrics(response.metrics, elapsedMs),
    };
  }

  if (item.kind === 'execution') {
    const changed = response.execution.changed_files.map(change => change.path.replaceAll('\\', '/'));
    const missingRequired = item.case.required_changes.filter(path => !changed.includes(path));
    const unexpectedChanges = changed.filter(path => !item.case.allowed_changes.includes(path));
    const changedText = response.execution.changed_files
      .map(change => typeof change.after_text === 'string' ? change.after_text : '')
      .join('\n')
      .normalize('NFKC').toLocaleLowerCase('en-US');
    const forbiddenContent = item.case.hard_forbidden_content.map(literal => ({
      literal,
      passed: !changedText.includes(literal.normalize('NFKC').toLocaleLowerCase('en-US')),
    }));
    const passed = response.execution.verifier.ok
      && missingRequired.length === 0
      && unexpectedChanges.length === 0
      && forbiddenContent.every(check => check.passed);
    return {
      run_id: response.run_id,
      kind: item.kind,
      case_id: item.case.id,
      variant: item.variant,
      repetition: item.repetition,
      completed: true,
      passed,
      verifier: response.execution.verifier,
      changed_files: response.execution.changed_files,
      missing_required_changes: missingRequired,
      unexpected_changes: unexpectedChanges,
      hard_forbidden_content_checks: forbiddenContent,
      provenance: response.provenance,
      metrics: observedMetrics(response.metrics, elapsedMs),
    };
  }

  const selected = [...new Set(response.selected_skills)];
  const missing = item.case.expected_skills.filter(name => !selected.includes(name));
  const forbidden = (item.case.forbidden_skills || []).filter(name => selected.includes(name));
  const extras = item.case.allow_additional_skills
    ? []
    : selected.filter(name => !item.case.expected_skills.includes(name));
  return {
    run_id: response.run_id,
    kind: item.kind,
    case_id: item.case.id,
    variant: item.variant,
    repetition: item.repetition,
    completed: true,
    passed: missing.length === 0 && forbidden.length === 0 && extras.length === 0,
    selected_skills: selected,
    expected_skills: item.case.expected_skills,
    missing_skills: missing,
    forbidden_selected: forbidden,
    unexpected_skills: extras,
    provenance: response.provenance,
    metrics: observedMetrics(response.metrics, elapsedMs),
  };
}

function observedMetrics(metrics = {}, elapsedMs) {
  return {
    harness_elapsed_ms: elapsedMs,
    runner_duration_ms: finiteOrNull(metrics.duration_ms),
    input_tokens: finiteOrNull(metrics.input_tokens),
    output_tokens: finiteOrNull(metrics.output_tokens),
  };
}

function makeReport({ suite, suitePath, suiteHash, outputDir, args, runRecords, judgeRecords }) {
  const completed = runRecords.filter(record => record.completed);
  const completedJudges = judgeRecords.filter(record => record.completed);
  const containsFixture = completed.some(record => record.provenance?.kind === 'fixture')
    || completedJudges.some(record => record.judge_provenance?.kind === 'fixture');
  const behavior = completed.filter(record => record.kind === 'behavior');
  const execution = completed.filter(record => record.kind === 'execution');
  const trigger = completed.filter(record => record.kind === 'trigger');
  const summarizeVariant = variant => {
    const records = behavior.filter(record => record.variant === variant);
    const judgments = completedJudges.map(record => record.variants[variant]);
    return {
      runs: records.length,
      judged_runs: judgments.length,
      accepted_runs: judgments.filter(judgment => judgment.accepted).length,
      semantic_passes: judgments.filter(judgment => judgment.semantic_pass).length,
      judge_criteria_passed: sum(judgments, 'judge_criteria_passed'),
      judge_criteria_total: sum(judgments, 'judge_criteria_total'),
      prohibited_behavior_passes: judgments.filter(judgment => judgment.prohibited_behavior_pass).length,
      observed_metrics: aggregateMetrics(records),
    };
  };
  const baseline = summarizeVariant('baseline');
  const withSkill = summarizeVariant('with_skill');
  const summarizeExecutionVariant = variant => {
    const records = execution.filter(record => record.variant === variant);
    return {
      runs: records.length,
      accepted_runs: records.filter(record => record.passed).length,
      verifier_passes: records.filter(record => record.verifier?.ok).length,
      changed_files: records.reduce((count, record) => count + (record.changed_files?.length || 0), 0),
      observed_metrics: aggregateMetrics(records),
    };
  };
  const executionBaseline = summarizeExecutionVariant('baseline');
  const executionWithSkill = summarizeExecutionVariant('with_skill');
  const summary = {
    planned_runs: runRecords.length,
    completed_runs: completed.length,
    planned_judges: judgeRecords.length,
    completed_judges: completedJudges.length,
    failed_executor_invocations: runRecords.length - completed.length,
    failed_judge_invocations: judgeRecords.filter(record => record.invoked && !record.completed).length,
    skipped_judges: judgeRecords.filter(record => !record.invoked).length,
    behavior: {
      baseline,
      with_skill: withSkill,
      observed_delta: {
        judge_criteria_passed: withSkill.judge_criteria_passed - baseline.judge_criteria_passed,
        accepted_runs: withSkill.accepted_runs - baseline.accepted_runs,
      },
    },
    execution: {
      baseline: executionBaseline,
      with_skill: executionWithSkill,
      observed_delta: {
        accepted_runs: executionWithSkill.accepted_runs - executionBaseline.accepted_runs,
        verifier_passes: executionWithSkill.verifier_passes - executionBaseline.verifier_passes,
      },
    },
    trigger: {
      runs: trigger.length,
      routing_contracts_passed: trigger.filter(record => record.passed).length,
      routing_contracts_total: trigger.length,
      observed_metrics: aggregateMetrics(trigger),
    },
  };
  summary.failed_runner_invocations = summary.failed_executor_invocations + summary.failed_judge_invocations;
  const behaviorWasPlanned = runRecords.some(record => record.kind === 'behavior');
  const executionWasPlanned = runRecords.some(record => record.kind === 'execution');
  summary.acceptance_contracts_passed = summary.failed_runner_invocations === 0
    && summary.skipped_judges === 0
    && (!behaviorWasPlanned || (completedJudges.length > 0 && completedJudges.every(record => record.variants.with_skill.accepted)))
    && (!executionWasPlanned || execution.filter(record => record.variant === 'with_skill').every(record => record.passed))
    && trigger.every(record => record.passed);

  return {
    schema_version: 1,
    kind: containsFixture ? 'agent-evaluation-tooling-fixture' : 'observed-real-agent-evaluation',
    protocol: PROTOCOL,
    harness_version: HARNESS_VERSION,
    generated_at: new Date().toISOString(),
    suite: { name: suite.name, path: relativePath(suitePath), sha256: suiteHash },
    runner_invocation: {
      executable: basename(args.runner),
      args: args.runnerArgs.map(redactArgument),
      repetitions_per_behavior_variant: args.runs ?? suite.runs_per_variant,
      repetitions_per_trigger_case: args.triggerRuns ?? suite.runs_per_trigger,
      repetitions_per_execution_variant: args.executionRuns ?? suite.runs_per_execution_variant,
    },
    judge_runner_invocation: {
      executable: basename(args.judgeRunner || args.runner),
      args: (args.judgeRunner ? args.judgeRunnerArgs : args.runnerArgs).map(redactArgument),
    },
    output: relativePath(outputDir),
    summary,
    runs: runRecords,
    judges: judgeRecords,
    disclaimer: containsFixture
      ? 'This report contains tooling-fixture observations, not a real-agent evaluation or model-quality score.'
      : 'These are observed blind-judge, deterministic execution-verifier, and routing-contract results from named external runners. They are not an overall model-quality score, and baseline failures are not harness failures.',
  };
}

function aggregateMetrics(records) {
  const keys = ['harness_elapsed_ms', 'runner_duration_ms', 'input_tokens', 'output_tokens'];
  return Object.fromEntries(keys.map(key => {
    const values = records.map(record => record.metrics?.[key]).filter(Number.isFinite);
    return [key, values.length ? {
      observations: values.length,
      mean: Number((values.reduce((sumValue, value) => sumValue + value, 0) / values.length).toFixed(2)),
      min: Math.min(...values),
      max: Math.max(...values),
    } : null];
  }));
}

function renderMarkdown(report) {
  const behaviorRows = report.judges
    .map(run => `| ${run.case_id} | ${run.repetition} | ${run.completed ? `${run.variants.baseline.judge_criteria_passed}/${run.variants.baseline.judge_criteria_total}` : 'judge unavailable'} | ${run.completed && run.variants.baseline.accepted ? 'yes' : 'no'} | ${run.completed ? `${run.variants.with_skill.judge_criteria_passed}/${run.variants.with_skill.judge_criteria_total}` : 'judge unavailable'} | ${run.completed && run.variants.with_skill.accepted ? 'yes' : 'no'} | ${run.completed ? run.preferred_variant : 'n/a'} |`)
    .join('\n');
  const triggerRows = report.runs
    .filter(run => run.kind === 'trigger')
    .map(run => `| ${run.case_id} | ${(run.selected_skills || []).join(', ') || '(none)'} | ${(run.expected_skills || []).join(', ') || '(none)'} | ${run.passed ? 'yes' : 'no'} |`)
    .join('\n');
  const executionRows = report.runs
    .filter(run => run.kind === 'execution')
    .map(run => `| ${run.case_id} | ${run.variant} | ${run.repetition} | ${run.completed ? (run.changed_files || []).map(file => file.path).join(', ') || '(none)' : 'runner error'} | ${run.completed && run.verifier?.ok ? 'yes' : 'no'} | ${run.passed ? 'yes' : 'no'} |`)
    .join('\n');
  const errors = [
    ...report.runs.filter(run => !run.completed).map(run => ({ source: 'executor', ...run })),
    ...report.judges.filter(run => !run.completed).map(run => ({ source: run.invoked ? 'judge' : 'judge-skipped', ...run })),
  ];
  return `# IdeaHub Agent Skill Evaluation

This report contains observed responses from named external runners. Plan outputs, including prohibited behavior, are judged in a fresh blind pass; disposable execution fixtures and routing are checked deterministically. This is not an overall model-quality score.

## Run identity

- Generated: ${report.generated_at}
- Suite SHA-256: \`${report.suite.sha256}\`
- Runner executable: \`${report.runner_invocation.executable}\`
- Completed executor invocations: ${report.summary.completed_runs}/${report.summary.planned_runs}
- Completed blind judges: ${report.summary.completed_judges}/${report.summary.planned_judges}

## Behavior A/B

- Baseline judged criteria: ${report.summary.behavior.baseline.judge_criteria_passed}/${report.summary.behavior.baseline.judge_criteria_total}
- With-skill judged criteria: ${report.summary.behavior.with_skill.judge_criteria_passed}/${report.summary.behavior.with_skill.judge_criteria_total}
- Observed judged-criterion delta: ${signed(report.summary.behavior.observed_delta.judge_criteria_passed)}

| Case | Repetition | Baseline criteria | Baseline accepted | With-skill criteria | With-skill accepted | Judge preference |
|---|---:|---:|---|---:|---|---|
${behaviorRows || '| (none) | | | | | | |'}

## Disposable execution A/B

- Baseline verifier passes: ${report.summary.execution.baseline.verifier_passes}/${report.summary.execution.baseline.runs}
- With-skill verifier passes: ${report.summary.execution.with_skill.verifier_passes}/${report.summary.execution.with_skill.runs}

| Case | Variant | Repetition | Changed files | Hidden verifier | Accepted |
|---|---|---:|---|---|---|
${executionRows || '| (none) | | | | | |'}

## Trigger routing

- Routing contracts matched: ${report.summary.trigger.routing_contracts_passed}/${report.summary.trigger.routing_contracts_total}

| Case | Selected skills | Expected skills | Contract matched |
|---|---|---|---|
${triggerRows || '| (none) | | | |'}

## Runner errors

${errors.length ? errors.map(run => `- ${run.source} \`${run.run_id}\`: ${run.error}`).join('\n') : '- None'}

## Interpretation boundary

${report.disclaimer}
`;
}

function printRun(record) {
  if (!record.completed) {
    console.error(`ERROR ${record.run_id}: ${record.error}`);
    return;
  }
  if (record.kind === 'behavior') {
    console.log(`DONE  ${record.run_id}; semantic and prohibited-behavior result pending blind judge`);
  } else if (record.kind === 'execution') {
    console.log(`${record.passed ? 'PASS' : 'MISS'}  ${record.run_id} verifier ${record.verifier?.ok ? 'passed' : 'failed'}; changed ${(record.changed_files || []).map(file => file.path).join(', ') || '(none)'}`);
  } else {
    console.log(`${record.passed ? 'PASS' : 'MISS'}  ${record.run_id} selected [${record.selected_skills.join(', ')}]`);
  }
}

function printJudge(record) {
  if (!record.completed) {
    console.error(`${record.invoked ? 'ERROR' : 'SKIP'} ${record.run_id}: ${record.error}`);
    return;
  }
  const treatment = record.variants.with_skill;
  console.log(`${treatment.accepted ? 'PASS' : 'MISS'}  ${record.run_id} blind judge ${treatment.judge_criteria_passed}/${treatment.judge_criteria_total}; preferred ${record.preferred_variant}`);
}

function emit(asJson, value) {
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else {
    for (const [key, item] of Object.entries(value)) {
      console.log(`${key}: ${typeof item === 'object' ? JSON.stringify(item) : item}`);
    }
  }
}

function positiveInteger(value, label, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`${label} must be an integer from 1 to ${max}.`);
  return number;
}

function requireOptionValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function requireAnyValue(argv, index, flag) {
  if (index >= argv.length) throw new Error(`${flag} requires a value.`);
  return argv[index];
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function sum(records, key) {
  return records.reduce((total, record) => total + (record[key] || 0), 0);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function relativePath(path) {
  return relative(ROOT, path).replaceAll('\\', '/');
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveInside(parent, childPath, label) {
  if (typeof childPath !== 'string' || !childPath.trim()) throw new Error(`${label} must be a non-empty path.`);
  const target = resolve(parent, childPath);
  if (!isWithin(parent, target)) throw new Error(`${label} escapes its allowed root.`);
  return target;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0);
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function redactArgument(value) {
  return /(?:key|token|secret|password)/i.test(value) ? '<redacted>' : value;
}

function signed(value) {
  return value >= 0 ? `+${value}` : String(value);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
