#!/usr/bin/env node

/**
 * Deterministic structural lint for IdeaHub project skills.
 *
 * This checks file shape, frontmatter, local references, eval fixtures, and
 * explicit static contracts. It does not run an agent and must never be
 * presented as a model-quality benchmark.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CONFIG = join(ROOT, '.agents', 'evals', 'agent-skills-lint.json');
const ALLOWED_FRONTMATTER = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const result = await lintAgentSkills({
  root: ROOT,
  configPath: resolve(ROOT, args.config || DEFAULT_CONFIG),
});

if (args.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  printHuman(result);
}

process.exitCode = result.ok ? 0 : 1;

export async function lintAgentSkills({ root, configPath }) {
  const errors = [];
  const warnings = [];
  const checked = { skills: 0, evalFiles: 0, references: 0, contracts: 0 };
  const config = await readJson(configPath, errors, 'lint config');
  if (!config) return finish(errors, warnings, checked, configPath);

  validateConfig(config, errors);
  const skillRoot = safeResolve(root, config.skill_root || '.agents/skills', errors, 'skill_root');
  if (!skillRoot) return finish(errors, warnings, checked, configPath);

  let entries = [];
  try {
    entries = (await readdir(skillRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  } catch (error) {
    errors.push(`Cannot read skill root ${displayPath(root, skillRoot)}: ${error.message}`);
    return finish(errors, warnings, checked, configPath);
  }

  const expected = new Set(config.required_skills || []);
  for (const requiredName of expected) {
    if (!entries.some(entry => entry.name === requiredName)) {
      errors.push(`Missing required skill directory: ${requiredName}`);
    }
  }

  for (const entry of entries) {
    const skillDir = join(skillRoot, entry.name);
    const skillFile = join(skillDir, 'SKILL.md');
    const content = await readText(skillFile, errors, `${entry.name}/SKILL.md`);
    if (content == null) continue;
    checked.skills += 1;

    const parsed = parseFrontmatter(content, errors, displayPath(root, skillFile));
    if (parsed) validateFrontmatter(parsed.frontmatter, entry.name, errors);
    checked.references += await validateMarkdownLinks(content, skillFile, skillDir, root, errors);

    const evalPath = join(skillDir, 'evals', 'evals.json');
    const evals = await readJson(evalPath, errors, `${entry.name} behavior evals`);
    if (evals) {
      checked.evalFiles += 1;
      validateBehaviorEvals(evals, entry.name, skillDir, root, errors);
    }
  }

  for (const contract of config.contracts || []) {
    checked.contracts += 1;
    await validateStaticContract(contract, root, errors);
  }

  for (const forbiddenPath of config.must_not_exist || []) {
    const target = safeResolve(root, forbiddenPath, errors, `must_not_exist:${forbiddenPath}`);
    if (target && await exists(target)) errors.push(`Forbidden legacy path still exists: ${forbiddenPath}`);
  }

  return finish(errors, warnings, checked, configPath);
}

function parseArgs(argv) {
  const parsed = { config: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--config') parsed.config = requireValue(argv, ++i, '--config');
    else throw new Error(`Unknown option: ${arg}. Run with --help.`);
  }
  return parsed;
}

function printHelp() {
  console.log(`IdeaHub agent-skill structural lint

Usage:
  node scripts/lint-agent-skills.mjs [options]

Options:
  --config <path>  Static contract JSON (default: .agents/evals/agent-skills-lint.json)
  --json           Emit a machine-readable result
  -h, --help       Show this help

This command validates deterministic structure and policy markers only. It does
not execute an agent, compare models, or report a model-quality score.`);
}

function printHuman(result) {
  console.log('IdeaHub agent-skill structural lint');
  console.log(`Checked ${result.checked.skills} skills, ${result.checked.evalFiles} eval files, ${result.checked.references} local references, and ${result.checked.contracts} static contracts.`);
  for (const warning of result.warnings) console.warn(`WARN  ${warning}`);
  for (const error of result.errors) console.error(`FAIL  ${error}`);
  if (result.ok) console.log('PASS  Deterministic structure and static contracts are valid.');
  console.log('NOTE  No agent behavior or model quality was measured.');
}

function finish(errors, warnings, checked, configPath) {
  return {
    schema_version: 1,
    kind: 'agent-skill-structural-lint',
    ok: errors.length === 0,
    checked,
    config: configPath,
    errors,
    warnings,
    disclaimer: 'Deterministic structure only; no agent behavior or model quality was measured.',
  };
}

function validateConfig(config, errors) {
  if (config.schema_version !== 1) errors.push('Lint config schema_version must be 1.');
  if (!Array.isArray(config.required_skills) || !config.required_skills.length) {
    errors.push('Lint config required_skills must be a non-empty array.');
  }
  if (!Array.isArray(config.contracts)) errors.push('Lint config contracts must be an array.');
  for (const [index, contract] of (config.contracts || []).entries()) {
    if (!contract?.id || typeof contract.id !== 'string') errors.push(`contracts[${index}] requires a string id.`);
    if (!Array.isArray(contract?.files) || !contract.files.length) errors.push(`Contract ${contract?.id || index} requires files.`);
    for (const key of ['must_include', 'must_not_include']) {
      if (contract?.[key] != null && !isStringArray(contract[key])) {
        errors.push(`Contract ${contract?.id || index} ${key} must be an array of strings.`);
      }
    }
  }
}

function parseFrontmatter(content, errors, label) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    errors.push(`${label}: missing YAML frontmatter.`);
    return null;
  }
  const normalized = content.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    errors.push(`${label}: unterminated YAML frontmatter.`);
    return null;
  }

  const lines = normalized.slice(4, end).split('\n');
  const frontmatter = {};
  let blockKey = null;
  let blockMode = null;
  let blockLines = [];
  let mapKey = null;

  const flushBlock = () => {
    if (!blockKey) return;
    frontmatter[blockKey] = blockMode === '>'
      ? blockLines.map(line => line.trim()).join(' ').trim()
      : blockLines.join('\n').trim();
    blockKey = null;
    blockMode = null;
    blockLines = [];
  };

  for (const line of lines) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      if (blockKey) blockLines.push('');
      continue;
    }
    if (/^\s+/.test(line)) {
      if (blockKey) {
        blockLines.push(line.replace(/^ {2}/, ''));
        continue;
      }
      if (mapKey === 'metadata') {
        const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
        if (!match) errors.push(`${label}: unsupported metadata line: ${line.trim()}`);
        else frontmatter.metadata[match[1]] = parseScalar(match[2]);
        continue;
      }
      errors.push(`${label}: unsupported indented frontmatter line: ${line.trim()}`);
      continue;
    }

    flushBlock();
    mapKey = null;
    const match = /^([A-Za-z0-9-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      errors.push(`${label}: invalid frontmatter line: ${line}`);
      continue;
    }
    const [, key, raw = ''] = match;
    if (Object.hasOwn(frontmatter, key)) errors.push(`${label}: duplicate frontmatter key ${key}.`);
    if (raw === '>' || raw === '|') {
      blockKey = key;
      blockMode = raw;
    } else if (key === 'metadata' && raw === '') {
      frontmatter.metadata = {};
      mapKey = key;
    } else frontmatter[key] = parseScalar(raw);
  }
  flushBlock();
  return { frontmatter, body: normalized.slice(end + 5) };
}

function validateFrontmatter(frontmatter, directoryName, errors) {
  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_FRONTMATTER.has(key)) errors.push(`${directoryName}: unexpected frontmatter key ${key}.`);
  }
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== 'string' || !name) errors.push(`${directoryName}: name must be a non-empty string.`);
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push(`${directoryName}: name must use lowercase kebab-case.`);
    if (name.length > 64) errors.push(`${directoryName}: name exceeds 64 characters.`);
    if (name !== directoryName) errors.push(`${directoryName}: frontmatter name must match its directory.`);
  }
  if (typeof description !== 'string' || !description.trim()) errors.push(`${directoryName}: description must be non-empty.`);
  else {
    if (description.length > 1024) errors.push(`${directoryName}: description exceeds 1024 characters.`);
    if (/[<>]/.test(description)) errors.push(`${directoryName}: description cannot contain angle brackets.`);
  }
  if (frontmatter.compatibility != null) {
    if (typeof frontmatter.compatibility !== 'string' || !frontmatter.compatibility.trim()) errors.push(`${directoryName}: compatibility must be a non-empty string when present.`);
    else if (frontmatter.compatibility.length > 500) errors.push(`${directoryName}: compatibility exceeds 500 characters.`);
  }
  if (frontmatter.metadata != null) {
    if (!frontmatter.metadata || typeof frontmatter.metadata !== 'object' || Array.isArray(frontmatter.metadata)) {
      errors.push(`${directoryName}: metadata must be a string-to-string map.`);
    } else if (Object.values(frontmatter.metadata).some(value => typeof value !== 'string')) {
      errors.push(`${directoryName}: every metadata value must be a string.`);
    }
  }
}

async function validateMarkdownLinks(content, skillFile, skillDir, root, errors) {
  const matches = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)];
  let checked = 0;
  for (const match of matches) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    if (isAbsolute(target)) {
      errors.push(`${displayPath(root, skillFile)}: local link must be relative: ${target}`);
      continue;
    }
    const clean = target.split('#')[0];
    const resolved = resolve(dirname(skillFile), clean);
    if (!isWithin(skillDir, resolved)) {
      errors.push(`${displayPath(root, skillFile)}: local link escapes the skill directory: ${target}`);
      continue;
    }
    checked += 1;
    if (!await exists(resolved)) errors.push(`${displayPath(root, skillFile)}: missing local reference ${target}`);
  }
  return checked;
}

function validateBehaviorEvals(document, skillName, skillDir, root, errors) {
  if (document.skill_name !== skillName) errors.push(`${skillName}: evals.skill_name must match the skill directory.`);
  if (!Array.isArray(document.evals) || document.evals.length < 2) {
    errors.push(`${skillName}: evals/evals.json must contain at least two cases.`);
    return;
  }
  const ids = new Set();
  for (const [index, item] of document.evals.entries()) {
    const label = `${skillName}: evals[${index}]`;
    if (!Number.isInteger(item.id) || ids.has(item.id)) errors.push(`${label} requires a unique integer id.`);
    ids.add(item.id);
    for (const field of ['prompt', 'expected_output']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) errors.push(`${label}.${field} must be non-empty.`);
    }
    if (!Array.isArray(item.files)) errors.push(`${label}.files must be an array.`);
    if (!isStringArray(item.expectations) || !item.expectations.length) errors.push(`${label}.expectations must be a non-empty string array.`);
    for (const file of item.files || []) {
      const resolved = resolve(skillDir, file);
      if (!isWithin(skillDir, resolved)) errors.push(`${label}: input file escapes skill directory: ${file}`);
      else if (!existsSyncHint(resolved)) errors.push(`${label}: missing input file ${displayPath(root, resolved)}`);
    }
  }
}

async function validateStaticContract(contract, root, errors) {
  const chunks = [];
  for (const path of contract.files || []) {
    const resolved = safeResolve(root, path, errors, `${contract.id}:${path}`);
    if (!resolved) continue;
    const content = await readText(resolved, errors, `${contract.id}:${path}`);
    if (content != null) chunks.push(`\n<file path="${path}">\n${content}\n</file>`);
  }
  const haystack = chunks.join('\n').replace(/\r\n/g, '\n');
  for (const needle of contract.must_include || []) {
    if (!haystack.includes(needle)) errors.push(`${contract.id}: required text not found: ${JSON.stringify(needle)}`);
  }
  for (const needle of contract.must_not_include || []) {
    if (haystack.includes(needle)) errors.push(`${contract.id}: forbidden text found: ${JSON.stringify(needle)}`);
  }
}

async function readJson(path, errors, label) {
  const content = await readText(path, errors, label);
  if (content == null) return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    errors.push(`${label}: invalid JSON: ${error.message}`);
    return null;
  }
}

async function readText(path, errors, label) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    errors.push(`Cannot read ${label}: ${error.message}`);
    return null;
  }
}

function safeResolve(root, path, errors, label) {
  if (typeof path !== 'string' || !path.trim()) {
    errors.push(`${label} must be a non-empty path.`);
    return null;
  }
  const target = resolve(root, path);
  if (!isWithin(root, target)) {
    errors.push(`${label} escapes repository root.`);
    return null;
  }
  return target;
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// This synchronous hint is only used for optional eval fixture paths. The
// project currently has none; asynchronous existence is covered elsewhere.
function existsSyncHint(path) {
  return existsSync(path);
}

function parseScalar(raw) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function displayPath(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}
