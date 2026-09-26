/**
 * 找出样式表里「已经没有任何页面会用到」的规则（2026-09-26，清理样式债第一批）：
 *   node scripts/css-dead-rules.mjs            只报告
 *   node scripts/css-dead-rules.mjs --apply    按报告删除
 *
 * 判定故意从严，宁可漏删也不误删：
 *   · 一个类名在前端源码、HTML、vendor 库、服务端代码和内容里都找不到（按完整词匹配），才算「没人用」。
 *   · 前端里拼出来的类名（`tag-${kind}`、'is-' + x、`${x}-on`）按前缀 / 后缀整组算「有人用」。
 *   · 一个选择器只要在最外层（不在 :not() / :is() / :has() / 属性选择器里）带着「没人用」的类，就不可能匹配到任何元素。
 *   · 一条规则的所有选择器都匹配不到才删整条；只有部分匹配不到时，只从列表里去掉那几个选择器。
 *   · @keyframes / @font-face 不动；规则体里还有嵌套块的不动。
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { PROJECT_ROOT } from './lib/web-build.mjs';

const APPLY = process.argv.includes('--apply');
const FILES = ['web/styles.css', 'web/soft.css', 'web/account.css', 'web/motion.css', 'web/login.css'];
const CORPUS_DIRS = [['web/src', ['.js', '.mjs']], ['web/vendor', ['.js', '.mjs']], ['server', ['.mjs', '.js', '.json', '.html', '.md', '.sql']]];
const CORPUS_FILES = ['web/index.html', 'web/login.html', 'web/接入说明.html'];

async function walk(dir, exts, out = []) {
  for (const e of await readdir(join(PROJECT_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules') await walk(rel, exts, out); }
    else if (exts.includes(extname(e.name))) out.push(rel);
  }
  return out;
}

/* ---------- 语料：所有可能用到类名的地方 ---------- */
const files = [...CORPUS_FILES];
for (const [dir, exts] of CORPUS_DIRS) files.push(...await walk(dir, exts));
const corpus = (await Promise.all(files.map(f => readFile(join(PROJECT_ROOT, f), 'utf8').catch(() => '')))).join('\n');
const words = new Set(corpus.match(/[A-Za-z_][\w-]*/g));
const prefixes = new Set([
  ...[...corpus.matchAll(/([A-Za-z][\w-]*-)\$\{/g)].map(m => m[1]),
  ...[...corpus.matchAll(/['"`]([A-Za-z][\w-]*-)['"`]\s*\+/g)].map(m => m[1]),
]);
const suffixes = new Set([...corpus.matchAll(/\}(-[A-Za-z][\w-]*)/g)].map(m => m[1]));
const used = cls => words.has(cls) || [...prefixes].some(p => cls.startsWith(p)) || [...suffixes].some(s => cls.endsWith(s));

/* ---------- 极简 CSS 扫描：跳过注释和字符串，按花括号找规则块 ---------- */
function skipString(css, i) {
  const q = css[i];
  for (i++; i < css.length; i++) {
    if (css[i] === '\\') { i++; continue; }
    if (css[i] === q) return i + 1;
  }
  return i;
}
function matchBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'") { i = skipString(css, i) - 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
const GROUPING = /^@(media|supports|container|layer|document)\b/i;
function parse(css, from, to, out) {
  let i = from;
  while (i < to) {
    const c = css[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i + 2) + 2; continue; }
    // 读前导（选择器或 at 规则）直到 { 或 ;
    let j = i, paren = 0;
    for (; j < to; j++) {
      const d = css[j];
      if (d === '/' && css[j + 1] === '*') { j = css.indexOf('*/', j + 2) + 1; continue; }
      if (d === '"' || d === "'") { j = skipString(css, j) - 1; continue; }
      if (d === '(') paren++; else if (d === ')') paren--;
      else if (paren === 0 && (d === '{' || d === ';')) break;
    }
    if (j >= to) break;
    if (css[j] === ';') { i = j + 1; continue; }
    const end = matchBrace(css, j);
    const prelude = css.slice(i, j).trim();
    if (prelude.startsWith('@')) {
      if (GROUPING.test(prelude)) parse(css, j + 1, end, out);
    } else {
      const body = css.slice(j + 1, end);
      if (!body.includes('{')) out.push({ start: i, open: j, end, prelude });
    }
    i = end + 1;
  }
  return out;
}

function splitSelectors(sel) {
  const out = []; let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
/** 最外层的类名：去掉注释、括号里的内容和属性选择器 */
function outerClasses(sel) {
  let s = sel.replace(/\/\*[\s\S]*?\*\//g, '');
  let prev;
  do { prev = s; s = s.replace(/\([^()]*\)/g, '').replace(/\[[^\[\]]*\]/g, ''); } while (s !== prev);
  return [...s.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]);
}

let totalRules = 0, totalSelectors = 0, totalBytes = 0;
const deadClasses = new Map();
for (const file of FILES) {
  const path = join(PROJECT_ROOT, file);
  let css = await readFile(path, 'utf8');
  const rules = parse(css, 0, css.length, []);
  const edits = [];
  for (const r of rules) {
    const sels = splitSelectors(r.prelude);
    const dead = sels.map(sel => outerClasses(sel).find(c => !used(c)) || null);
    if (!dead.some(Boolean)) continue;
    for (const d of dead) if (d) deadClasses.set(d, (deadClasses.get(d) || 0) + 1);
    if (dead.every(Boolean)) {
      edits.push({ from: r.start, to: r.end + 1, text: '', kind: 'rule', prelude: r.prelude });
      totalRules++; totalBytes += r.end + 1 - r.start;
    } else {
      const keep = sels.filter((_, k) => !dead[k]).map(x => x.trim());
      edits.push({ from: r.start, to: r.open, text: keep.join(',') + ' ', kind: 'selectors', prelude: r.prelude });
      totalSelectors += dead.filter(Boolean).length;
    }
  }
  console.log(`${file}: 整条删 ${edits.filter(e => e.kind === 'rule').length} 条，去掉部分选择器 ${edits.filter(e => e.kind === 'selectors').length} 处`);
  if (APPLY && edits.length) {
    for (const e of edits.sort((a, b) => b.from - a.from)) css = css.slice(0, e.from) + e.text + css.slice(e.to);
    // 删掉整条规则后留下的空 @media 块和多余空行
    let prev;
    do { prev = css; css = css.replace(/@media[^{]*\{\s*\}/g, ''); } while (css !== prev);
    css = css.replace(/\n{3,}/g, '\n\n');
    await writeFile(path, css);
  }
}
console.log(`\n合计：整条删 ${totalRules} 条规则（约 ${(totalBytes / 1024).toFixed(1)} KB），另去掉 ${totalSelectors} 个失效选择器`);
console.log(`没人用的类名 ${deadClasses.size} 个：`);
console.log([...deadClasses.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}(${n})`).join('  '));
if (!APPLY) console.log('\n（只报告。确认后加 --apply 真删）');
