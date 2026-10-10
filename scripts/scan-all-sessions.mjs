/**
 * 扫一遍**全部**会话日志，找出「宿主读不进去」的那些。
 *
 * 起因：本插件曾经往会话日志里写自定义事件类型 `novelForge/state`，
 * 而 dsh-session-persistence 的读路径是：
 *
 *   if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw
 *
 * —— 一旦撞上，**整个会话**都拒绝被解释，作者直接打不开。
 * 当时只查了自己正在用的那一个会话，没有查其它会话有没有同样的伤。
 *
 * 这个脚本做的就是宿主在加载时做的那一次判定，逐文件复现：
 * 出现「不在已知集合里、且没有 ignorable:true」的事件，就是一颗地雷。
 *
 * 已知集合直接读仓里的权威定义，不自己维护一份 —— 自己抄一份必然过期：
 *   node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js
 *
 * 用法：
 *   node scripts/scan-all-sessions.mjs [--root <sessions 目录>] [--quiet]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { readSessionLog } from "./read-session-log.mjs";

const DSH_APP = process.env.DSH_APP_ROOT ?? "D:\\Program software\\DSH NEXT\\resources\\app";
const KNOWN_FILE = path.join(
  DSH_APP, "node_modules", "@deepseek-ai", "dsh-session", "lib", "types", "known-event-types.js",
);

async function loadKnownTypes() {
  const url = pathToFileURL(KNOWN_FILE).href;
  const mod = await import(url);
  const set = mod.KNOWN_SESSION_EVENT_TYPES;
  if (!(set instanceof Set) || set.size === 0) {
    throw new Error(`读不出已知事件类型集合：${KNOWN_FILE}`);
  }
  return set;
}

/** 找出所有 session.v4.jsonl.zstd。 */
function findLogs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name === "session.v4.jsonl.zstd") out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 只抽 type 与 ignorable，不做整行 JSON.parse。
 * 284 MB 的日志全量解析会慢得多，而 type 正则就够。
 *
 * 两个坑，都踩过：
 *  1. 每个文件**第一行是头记录** `{"type":"session","version":4,...}`，
 *     它没有 seq。不加区分会得到「1570 份日志全都有未知类型 session」这种假警报。
 *     事件行一律带 seq，用它区分。
 *  2. `ignorable` 必须是**信封层**的字段。用正则全行搜 `"ignorable":true`
 *     会把嵌在 data 里的同名键也算进来，把真正读不进去的日志报成「能读」——
 *     方向刚好反了，比不报更危险。所以未知类型的行老老实实 JSON.parse 再看顶层。
 *     已知类型直接跳过，解析量因此很小。
 */
function scanText(text, known) {
  const bad = new Map();     // type → 次数（未知且不可忽略）
  const ignorableUnknown = new Map();
  const all = new Map();
  let events = 0;
  for (const line of text.split("\n")) {
    if (line === "" || line.charCodeAt(0) !== 0x7b) continue;   // 只看以 { 开头的整行
    if (!line.includes('"seq":')) continue;                     // 头记录没有 seq，跳过
    const m = /"type":"((?:[^"\\]|\\.)*)"/.exec(line);
    if (!m) continue;
    events++;
    const type = m[1];
    all.set(type, (all.get(type) ?? 0) + 1);
    if (known.has(type)) continue;
    let envelopeIgnorable = false;
    try { envelopeIgnorable = JSON.parse(line).ignorable === true; } catch { /* 半行，当不可忽略 */ }
    if (envelopeIgnorable) {
      ignorableUnknown.set(type, (ignorableUnknown.get(type) ?? 0) + 1);
    } else {
      bad.set(type, (bad.get(type) ?? 0) + 1);
    }
  }
  return { bad, ignorableUnknown, all, events };
}

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg >= 0 ? args[rootArg + 1] : path.join(os.homedir(), ".dsh", "sessions");
const quiet = args.includes("--quiet");

const known = await loadKnownTypes();
const logs = findLogs(root);
console.log(`已知事件类型 ${known.size} 种；找到 ${logs.length} 份会话日志`);
console.log(`根目录：${root}\n`);

const poisoned = [];
const unknownButIgnorable = new Map();
const ignorableHits = new Map();     // type → [{file, n}]
const globalTypes = new Map();
let scanned = 0;
let failed = 0;

for (const file of logs) {
  let r;
  try {
    const { text, consumed, total } = readSessionLog(file);
    // 帧没走完就是扫描器本身的问题 —— 宁可报出来，也不能拿半份日志下结论。
    if (consumed !== total) {
      failed++;
      console.log(`⚠ 只解出 ${consumed}/${total} 字节（帧没走完）：${file}`);
      continue;
    }
    r = scanText(text, known);
  } catch (error) {
    failed++;
    console.log(`⚠ 读取失败：${file}\n  ${error?.message ?? error}`);
    continue;
  }
  scanned++;
  for (const [t, n] of r.all) globalTypes.set(t, (globalTypes.get(t) ?? 0) + n);
  for (const [t, n] of r.ignorableUnknown) {
    unknownButIgnorable.set(t, (unknownButIgnorable.get(t) ?? 0) + n);
    const hits = ignorableHits.get(t) ?? [];
    hits.push({ file, n });
    ignorableHits.set(t, hits);
  }
  if (r.bad.size > 0) {
    poisoned.push({ file, bad: [...r.bad.entries()], events: r.events });
  }
}

console.log(`扫完 ${scanned} 份，读取失败 ${failed} 份\n`);

console.log("=".repeat(70));
if (poisoned.length === 0) {
  console.log("✅ 没有「读不进去」的会话：未知类型都带了 ignorable，或者压根没有未知类型。");
} else {
  console.log(`❌ ${poisoned.length} 份会话含「未知且不可忽略」的事件 —— 宿主会拒绝解释整个日志：`);
  for (const p of poisoned) {
    console.log(`\n  ${p.file}`);
    console.log(`    共 ${p.events} 个事件`);
    for (const [t, n] of p.bad) console.log(`    ✗ ${t} × ${n}`);
  }
}
console.log("=".repeat(70));

if (unknownButIgnorable.size > 0) {
  console.log("\n未知但**带了** ignorable 的类型（能读进去，但都是本插件早先写下的残留，应尽快停写）：");
  for (const [t, n] of [...unknownButIgnorable].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t} × ${n}`);
    for (const h of ignorableHits.get(t) ?? []) {
      console.log(`      ${h.n} 个 ← ${path.basename(path.dirname(h.file))}`);
    }
  }
}

if (!quiet) {
  console.log("\n全局事件类型分布（前 25）：");
  for (const [t, n] of [...globalTypes].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    const mark = known.has(t) ? "  " : "⚠ ";
    console.log(`  ${mark}${t} × ${n}`);
  }
}

process.exit(poisoned.length === 0 && failed === 0 ? 0 : 1);
