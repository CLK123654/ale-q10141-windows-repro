import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(repoRoot, 'artifacts');
const rebuilt = path.join(repoRoot, 'verification', 'rebuilt');
const sqlite = process.env.SQLITE3_PATH || 'sqlite3.exe';
const expectedFiles = [
  'ab_attribution_review.db',
  'rebuild_ab_attribution.sql',
  'reports/attribution_window.csv',
  'reports/cohort_metrics.csv',
  'reports/sample_contamination.csv',
].sort();
const sourceTables = ['experiment_catalog', 'user_dimension', 'assignment_event', 'exposure_event', 'conversion_event'];

const assert = (value, message) => { if (!value) throw new Error(message); };

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

async function run(command, args, cwd) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.stack ?? error.message}` }));
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function query(database, sql) {
  const result = await run(sqlite, ['-batch', '-readonly', '-json', database, sql], repoRoot);
  assert(result.code === 0, `SQLite查询失败\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout || '[]');
}

function files(root) {
  const output = [];
  function walk(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else output.push(relative);
    }
  }
  walk(root); return output.sort();
}

assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true', '只接受GitHub托管Windows运行');
const version = await run(sqlite, ['--version'], repoRoot);
assert(version.code === 0 && version.stdout.startsWith('3.51.2'), `需要SQLite3.51.2，当前为${version.stdout || version.stderr}`);

const room = path.join(os.tmpdir(), 'Q10141 Windows 业务交付');
await fsp.rm(room, { recursive: true, force: true });
await fsp.mkdir(room, { recursive: true });
await extract(path.join(artifacts, '输入数据包.zip'), room);
const inputRoot = path.join(room, 'input_data');
const outputRoot = path.join(inputRoot, 'output');
await fsp.mkdir(outputRoot, { recursive: true });
const solution = zipEntries(path.join(artifacts, 'reference.zip')).get('output/rebuild_ab_attribution.sql');
assert(solution, '缺少完成版归因SQL');
assert(!/\b(?:X[1-8]|C[1-4]|E100|E300)\b/u.test(solution.toString('utf8')), '完成版SQL含样例主键硬编码');
await fsp.writeFile(path.join(outputRoot, 'rebuild_ab_attribution.sql'), solution);

const processResult = await run('pwsh', ['-NoLogo', '-NoProfile', '-File', path.join(inputRoot, 'tools', 'run-task.ps1'), '-SqlitePath', sqlite], inputRoot);
assert(processResult.code === 0, `业务入口失败\n${processResult.stdout}\n${processResult.stderr}`);
assert(JSON.stringify(files(outputRoot)) === JSON.stringify(expectedFiles), `交付成员错误：${files(outputRoot).join(',')}`);

const sourceDb = path.join(inputRoot, 'database', 'ab_experiment.db');
const outputDb = path.join(outputRoot, 'ab_attribution_review.db');
for (const table of sourceTables) {
  const sourceSchema = await query(sourceDb, `PRAGMA table_info(${table});`);
  const outputSchema = await query(outputDb, `PRAGMA table_info(${table});`);
  assert(JSON.stringify(sourceSchema) === JSON.stringify(outputSchema), `${table}结构被改写`);
  const sourceRows = (await query(sourceDb, `SELECT * FROM ${table};`)).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const outputRows = (await query(outputDb, `SELECT * FROM ${table};`)).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  assert(JSON.stringify(sourceRows) === JSON.stringify(outputRows), `${table}数据被改写`);
}
const integrity = await query(outputDb, 'PRAGMA integrity_check;');
assert(Object.values(integrity[0] ?? {})[0] === 'ok', '数据库完整性检查失败');
const meta = await query(outputDb, 'SELECT key,value FROM report_meta ORDER BY key;');
assert(JSON.stringify(meta) === JSON.stringify([
  { key: 'conversion_window_hours', value: '24' },
  { key: 'report_end_utc', value: '2026-07-12T00:00:00Z' },
  { key: 'report_start_utc', value: '2026-07-10T00:00:00Z' },
]), `report_meta含非业务字段或与策略不符：${JSON.stringify(meta)}`);
const contamination = await query(outputDb, 'SELECT source_id,reason FROM sample_contamination ORDER BY source_id;');
assert(JSON.stringify(contamination) === JSON.stringify([
  { source_id: 'X3', reason: 'mutual_family_conflict' },
  { source_id: 'X5', reason: 'duplicate_exposure' },
  { source_id: 'X6', reason: 'user_disabled' },
  { source_id: 'X7', reason: 'bot_user' },
  { source_id: 'X8', reason: 'outside_experiment_window' },
]), '污染裁决与业务输入不符');
const attribution = await query(outputDb, 'SELECT conversion_id,matched_exposure_id,attribution_status,latency_minutes,value_cents FROM attribution_window ORDER BY conversion_id;');
assert(attribution.length === 4 && attribution[0].attribution_status === 'attributed' && attribution[2].attribution_status === 'blocked_by_contamination' && attribution[3].attribution_status === 'outside_24h_window', '逐转化归因与业务输入不符');

await fsp.rm(rebuilt, { recursive: true, force: true });
await fsp.mkdir(path.join(rebuilt, 'output'), { recursive: true });
await fsp.cp(outputRoot, path.join(rebuilt, 'output'), { recursive: true });
await fsp.writeFile(path.join(rebuilt, 'windows-reference-build.json'), `${JSON.stringify({
  schema_version: 1,
  result: 'PASS',
  generated_at_utc: new Date().toISOString(),
  git_commit_sha: process.env.GITHUB_SHA,
  workflow_run_id: process.env.GITHUB_RUN_ID,
  runner: { os: process.env.RUNNER_OS, image_os: process.env.ImageOS, image_version: process.env.ImageVersion },
  software: { sqlite: version.stdout.trim(), node: process.version },
  delivery_members: expectedFiles,
  source_tables_preserved: sourceTables,
  report_meta: meta,
  integrity_check: integrity,
} , null, 2)}\n`);
console.log('Windows业务交付已生成');
