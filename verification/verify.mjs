import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const artifactRoot = path.join(repoRoot, 'artifacts');
const evidenceRoot = path.join(repoRoot, 'verification', 'evidence');
const sqlite = process.env.SQLITE3_PATH || 'sqlite3.exe';
const attachments = ['输入数据包.zip', 'reference.zip', '关键标准答案.xlsx', '任务规格转化.xlsx'];
const expectedReference = [
  'output/ab_attribution_review.db',
  'output/rebuild_ab_attribution.sql',
  'output/reports/attribution_window.csv',
  'output/reports/cohort_metrics.csv',
  'output/reports/sample_contamination.csv',
].sort();
const reportKeys = {
  'output/reports/attribution_window.csv': ['conversion_id'],
  'output/reports/cohort_metrics.csv': ['experiment_id', 'variant'],
  'output/reports/sample_contamination.csv': ['source_id'],
};
const tables = [
  'experiment_catalog', 'user_dimension', 'assignment_event', 'exposure_event', 'conversion_event',
  'valid_exposure', 'sample_contamination', 'attribution_window', 'cohort_metrics', 'report_meta',
];

const assert = (value, message) => { if (!value) throw new Error(message); };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));

function zipEntries(file) {
  const data = fs.readFileSync(file);
  let eocd = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65_557); index -= 1) {
    if (data.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  assert(eocd >= 0, `找不到ZIP目录：${file}`);
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    assert(data.readUInt32LE(offset) === 0x02014b50, `ZIP目录损坏：${file}`);
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (!name.endsWith('/')) {
      const compressed = data.subarray(start, start + compressedSize);
      const body = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      assert(body && body.length === uncompressedSize, `无法解压${name}`);
      entries.set(name, body);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extract(file, destination) {
  for (const [name, bytes] of zipEntries(file)) {
    const target = path.resolve(destination, ...name.split('/'));
    assert(target.startsWith(`${path.resolve(destination)}${path.sep}`), `非法ZIP路径：${name}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes);
  }
}

function workbookSheets(file) {
  const xml = zipEntries(file).get('xl/workbook.xml')?.toString('utf8') ?? '';
  return [...xml.matchAll(/<(?:[A-Za-z]+:)?sheet[^>]+name="([^"]+)"/gu)].map((match) => match[1]);
}

async function run(command, args, cwd) {
  const started = Date.now();
  return await new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { cwd, env: process.env, windowsHide: true }); }
    catch (error) { resolve({ code: 1, stdout: '', stderr: error.stack ?? error.message, elapsed_ms: Date.now() - started }); return; }
    let stdout = ''; let stderr = ''; let settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { if (!settled) { settled = true; resolve({ code: 1, stdout, stderr: `${stderr}${error.stack ?? error.message}`, elapsed_ms: Date.now() - started }); } });
    child.on('exit', (code) => { if (!settled) { settled = true; resolve({ code: code ?? 1, stdout, stderr, elapsed_ms: Date.now() - started }); } });
  });
}

async function query(database, sql) {
  const result = await run(sqlite, ['-batch', '-readonly', '-json', database, sql], repoRoot);
  assert(result.code === 0, `SQLite查询失败\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout || '[]');
}

async function runTask(inputRoot) {
  return await run('pwsh', ['-NoLogo', '-NoProfile', '-File', path.join(inputRoot, 'tools', 'run-task.ps1'), '-SqlitePath', sqlite], inputRoot);
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/u, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/u, '')); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.filter((values) => values.some((value) => value !== '')).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function normalizedRows(file, text) {
  const rows = parseCsv(text);
  const keys = reportKeys[file];
  return rows.toSorted((left, right) => keys.map((key) => String(left[key]).localeCompare(String(right[key]), 'en')).find((value) => value !== 0) ?? 0);
}

function files(root) {
  const result = [];
  function walk(current, prefix = '') {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else result.push(relative);
    }
  }
  walk(root); return result.sort();
}

function treeDigest(root, ignored = new Set()) {
  const lines = [];
  function walk(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored.has(relative.split('/')[0])) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else lines.push(`${relative}\0${sha256File(full)}`);
    }
  }
  walk(root); return sha256(Buffer.from(lines.join('\n')));
}

function classifyExecutable(name, bytes) {
  const lower = name.toLowerCase();
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes.subarray(1, 4).toString('ascii') === 'ELF') return 'linux_elf';
  if (/\.(?:sh|bash|so)(?:\.|$)/u.test(lower)) return 'posix_member';
  if (/^#!.*(?:ba|z|k)?sh/mu.test(bytes.subarray(0, 160).toString('utf8'))) return 'posix_shebang';
  return null;
}

async function prepare(label, mutate) {
  const root = path.join(os.tmpdir(), label);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  await extract(path.join(artifactRoot, '输入数据包.zip'), root);
  const inputRoot = path.join(root, 'input_data');
  const reference = zipEntries(path.join(artifactRoot, 'reference.zip'));
  const outputRoot = path.join(inputRoot, 'output');
  await fsp.mkdir(outputRoot, { recursive: true });
  await fsp.writeFile(path.join(outputRoot, 'rebuild_ab_attribution.sql'), reference.get('output/rebuild_ab_attribution.sql'));
  if (mutate) await mutate(inputRoot);
  return { root, inputRoot, outputRoot, reference };
}

async function compareReference(outputRoot, reference) {
  const actualPaths = files(outputRoot).map((name) => `output/${name}`);
  assert(JSON.stringify(actualPaths) === JSON.stringify(expectedReference), `输出成员与Reference不一致：${actualPaths.join(',')}`);
  const actualSql = fs.readFileSync(path.join(outputRoot, 'rebuild_ab_attribution.sql'), 'utf8').replaceAll('\r\n', '\n');
  const expectedSql = reference.get('output/rebuild_ab_attribution.sql').toString('utf8').replaceAll('\r\n', '\n');
  assert(actualSql === expectedSql, '完成版SQL与Reference不一致');
  const semantic = crypto.createHash('sha256');
  semantic.update(actualSql);
  for (const file of expectedReference.filter((name) => name.endsWith('.csv'))) {
    const actualRows = normalizedRows(file, fs.readFileSync(path.join(path.dirname(outputRoot), ...file.split('/')), 'utf8'));
    const expectedRows = normalizedRows(file, reference.get(file).toString('utf8'));
    assert(JSON.stringify(actualRows) === JSON.stringify(expectedRows), `${file}与Reference业务字段不一致`);
    semantic.update(JSON.stringify(actualRows));
  }
  const referenceDb = path.join(outputRoot, '.reference-ab-attribution.db');
  await fsp.writeFile(referenceDb, reference.get('output/ab_attribution_review.db'));
  try {
    for (const table of tables) {
      const schemaA = await query(path.join(outputRoot, 'ab_attribution_review.db'), `PRAGMA table_info(${table});`);
      const schemaB = await query(referenceDb, `PRAGMA table_info(${table});`);
      assert(JSON.stringify(schemaA) === JSON.stringify(schemaB), `${table}结构与Reference不一致`);
      const rowsA = (await query(path.join(outputRoot, 'ab_attribution_review.db'), `SELECT * FROM ${table};`)).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
      const rowsB = (await query(referenceDb, `SELECT * FROM ${table};`)).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
      assert(JSON.stringify(rowsA) === JSON.stringify(rowsB), `${table}数据与Reference不一致`);
      semantic.update(JSON.stringify(rowsA));
    }
    const integrityA = await query(path.join(outputRoot, 'ab_attribution_review.db'), 'PRAGMA integrity_check;');
    const integrityB = await query(referenceDb, 'PRAGMA integrity_check;');
    assert(JSON.stringify(integrityA) === JSON.stringify(integrityB) && Object.values(integrityA[0] ?? {})[0] === 'ok', '数据库完整性检查失败');
  } finally { await fsp.rm(referenceDb, { force: true }); }
  return semantic.digest('hex');
}

await fsp.rm(evidenceRoot, { recursive: true, force: true });
await fsp.mkdir(evidenceRoot, { recursive: true });
assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true', '只接受GitHub托管Windows运行');
const sqliteVersion = await run(sqlite, ['--version'], repoRoot);
assert(sqliteVersion.code === 0 && sqliteVersion.stdout.startsWith('3.51.2'), `需要SQLite3.51.2，当前为${sqliteVersion.stdout || sqliteVersion.stderr}`);

const attachmentSha256 = Object.fromEntries(attachments.map((name) => [name, sha256File(path.join(artifactRoot, name))]));
const inputMembers = zipEntries(path.join(artifactRoot, '输入数据包.zip'));
const executableScan = [...inputMembers].map(([name, bytes]) => ({ name, classification: classifyExecutable(name, bytes) })).filter((item) => item.classification);
assert(executableScan.length === 0, `输入包含平台专用成员：${JSON.stringify(executableScan)}`);
assert(JSON.stringify([...zipEntries(path.join(artifactRoot, 'reference.zip')).keys()].sort()) === JSON.stringify(expectedReference), 'Reference成员错误');
assert(JSON.stringify(workbookSheets(path.join(artifactRoot, '关键标准答案.xlsx'))) === JSON.stringify(['交付物答案清单', '固定字段答案', '固定集合答案', '固定数值答案', '允许变体答案']), '关键标准答案Sheet错误');
assert(JSON.stringify(workbookSheets(path.join(artifactRoot, '任务规格转化.xlsx'))) === JSON.stringify(['任务规格转化']), '任务规格Sheet错误');
const solution = zipEntries(path.join(artifactRoot, 'reference.zip')).get('output/rebuild_ab_attribution.sql').toString('utf8');
assert(!/\b(?:X[1-8]|C[1-4]|E100|E300)\b/u.test(solution), '完成版SQL含样例主键硬编码');

const cleanRuns = [];
for (const label of ['Q10141 第一次 中文 空目录', 'Q10141 第二次 中文 空格目录']) {
  const room = await prepare(label);
  const before = treeDigest(room.inputRoot, new Set(['output']));
  const result = await runTask(room.inputRoot);
  assert(result.code === 0, `${label}运行失败\n${result.stdout}\n${result.stderr}`);
  const after = treeDigest(room.inputRoot, new Set(['output']));
  assert(before === after, `${label}修改了输入`);
  const semantic = await compareReference(room.outputRoot, room.reference);
  cleanRuns.push({ directory_label: label, exit_code: result.code, input_digest_before: before, input_digest_after: after, semantic_digest: semantic, elapsed_ms: result.elapsed_ms, reference_match: true });
}
assert(cleanRuns[0].semantic_digest === cleanRuns[1].semantic_digest, '两个干净目录的结构化结果不一致');

const crlf = await prepare('Q10141 CRLF 布局合同', async (inputRoot) => {
  const file = path.join(inputRoot, 'rules', 'report_layout.csv');
  const value = await fsp.readFile(file, 'utf8');
  await fsp.writeFile(file, value.replace(/\r?\n/gu, '\r\n'));
});
let result = await runTask(crlf.inputRoot);
assert(result.code === 0, `CRLF布局合同运行失败\n${result.stdout}\n${result.stderr}`);
const crlfDigest = await compareReference(crlf.outputRoot, crlf.reference);
assert(crlfDigest === cleanRuns[0].semantic_digest, 'CRLF布局合同改变业务结果');

const mutation = await prepare('Q10141 转化窗口变化', async (inputRoot) => {
  const file = path.join(inputRoot, 'rules', 'attribution_policy.json');
  const value = JSON.parse(await fsp.readFile(file, 'utf8'));
  value.conversion_window_hours = 30;
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
});
result = await runTask(mutation.inputRoot);
assert(result.code === 0, `转化窗口变化运行失败\n${result.stdout}\n${result.stderr}`);
const c4 = (await query(path.join(mutation.outputRoot, 'ab_attribution_review.db'), "SELECT matched_exposure_id,attribution_status,latency_minutes,value_cents FROM attribution_window WHERE conversion_id='C4';"))[0];
const treatment = (await query(path.join(mutation.outputRoot, 'ab_attribution_review.db'), "SELECT valid_exposures,attributed_conversions,revenue_cents,conversion_rate_pct FROM cohort_metrics WHERE experiment_id='E100' AND variant='treatment';"))[0];
assert(c4.matched_exposure_id === 'X1' && c4.attribution_status === 'attributed' && c4.latency_minutes === 1650 && c4.value_cents === 500, '转化窗口变化没有改变C4归因');
assert(treatment.valid_exposures === 1 && treatment.attributed_conversions === 2 && treatment.revenue_cents === 1500 && treatment.conversion_rate_pct === '200.00', '转化窗口变化没有联动分组指标');

const negative = await prepare('Q10141 缺失归因策略', async (inputRoot) => {
  await fsp.rm(path.join(inputRoot, 'rules', 'attribution_policy.json'));
});
result = await runTask(negative.inputRoot);
const derivedAbsent = !fs.existsSync(path.join(negative.outputRoot, 'ab_attribution_review.db')) && !fs.existsSync(path.join(negative.outputRoot, 'reports'));
assert(result.code !== 0 && derivedAbsent, '归因策略缺失时没有失败关闭');

const evidence = {
  schema_version: 1,
  task_asset_id: 'sqlite_experiment_attribution_decision',
  result: 'PASS',
  generated_at_utc: new Date().toISOString(),
  git_commit_sha: process.env.GITHUB_SHA,
  workflow_run_id: process.env.GITHUB_RUN_ID,
  runner: { os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH, image_os: process.env.ImageOS, image_version: process.env.ImageVersion, node: process.version, actual_windows_run: true, powershell_hosted_workflow: true },
  software: { sqlite: sqliteVersion.stdout.trim(), powershell: process.env.PSModulePath ? 'pwsh-hosted' : 'unknown' },
  attachment_sha256: attachmentSha256,
  archive_checks: { input_members: [...inputMembers.keys()].sort(), reference_members: expectedReference, prohibited_platform_members: executableScan },
  workbook_checks: { answer_sheet_names: workbookSheets(path.join(artifactRoot, '关键标准答案.xlsx')), specification_sheet_names: workbookSheets(path.join(artifactRoot, '任务规格转化.xlsx')) },
  clean_runs: cleanRuns,
  crlf_case: { changed_input: 'rules/report_layout.csv行尾改为CRLF', exit_code: 0, semantic_digest: crlfDigest, reference_match: true },
  positive_mutation: { changed_rule: 'conversion_window_hours从24改为30', exit_code: 0, c4, e100_treatment: treatment },
  invalid_input: { removed_input: 'rules/attribution_policy.json', exit_code: result.code, derived_outputs_absent: derivedAbsent },
  network: { installation_network_access: '仅SQLite下载安装阶段', formal_run_network_access: 'none' },
};
await fsp.writeFile(path.join(evidenceRoot, 'windows-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
