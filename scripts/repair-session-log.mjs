/**
 * 修一份被自定义事件类型「写死」的会话日志。
 *
 * 症状（宿主原话）：
 *   session "…" contains event type "novelForge/state" (seq 22) unknown to this
 *   harness and not marked ignorable; refusing to interpret the log
 *
 * 原因：dsh-session-persistence 的读路径是
 *   if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw
 * 而 dsh-session 的 `append<T>()` 只接受仓内闭合的 T，`opts` 里没有 ignorable ——
 * **仓外插件没有任何合法途径**把自定义类型标成可忽略。所以正确做法是插件停写
 * （本插件已改成 no-op），而已经写进去的历史日志要用这个脚本补标记救回来。
 *
 * 修法刻意做得最小：
 *   · 只在**信封层**补一个 `"ignorable":true`，紧跟在 `"type"` 之后；
 *   · 其余字节一个都不动（不做 JSON.parse → stringify 的整行重排，
 *     那会改掉键序和转义，出问题时无法和原文对照）；
 *   · 帧结构原样保留：逐帧解压、逐帧改、逐帧重新压回去。
 *     行数不变（加个键不增行），所以每帧承担的行数和原来完全一致。
 *
 * 默认只报告不写盘；要真写必须显式 --apply，且会先备份。
 *
 * 用法：
 *   node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const DSH_APP = process.env.DSH_APP_ROOT ?? "D:\\Program software\\DSH NEXT\\resources\\app";
const KNOWN_FILE = path.join(
  DSH_APP, "node_modules", "@deepseek-ai", "dsh-session", "lib", "types", "known-event-types.js",
);
const MAGIC = 0xfd2fb528;

const { KNOWN_SESSION_EVENT_TYPES: KNOWN } = await import(pathToFileURL(KNOWN_FILE).href);
if (!(KNOWN instanceof Set) || KNOWN.size === 0) throw new Error(`读不出已知事件类型集合：${KNOWN_FILE}`);

// ── 帧遍历（与 read-session-log.mjs 同一套逻辑）─────────────────────────
function frameLength(buf, start) {
  const fhd = buf.readUInt8(start + 4);
  let off = start + 5;
  if ((fhd & 0x20) === 0) off += 1;                    // Window_Descriptor
  off += [0, 1, 2, 4][fhd & 3];                        // Dictionary_ID
  const fcsFlag = (fhd >> 6) & 3;
  const singleSegment = (fhd & 0x20) !== 0;
  off += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  while (off < buf.length) {
    const hdr = buf.readUIntLE(off, 3);
    const last = hdr & 1;
    const type = (hdr >> 1) & 3;
    const size = hdr >> 3;
    off += 3;
    if (type === 1) off += 1;                          // RLE：1 字节
    else off += size;
    if (last) break;
  }
  if ((fhd & 4) !== 0) off += 4;                       // Checksum
  return { length: off - start, bytes: buf.subarray(start, off) };
}

function readFrames(file) {
  const buf = fs.readFileSync(file);
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4 || buf.readUInt32LE(off) !== MAGIC) break;
    const { length, bytes } = frameLength(buf, off);
    frames.push(bytes);
    off += length;
  }
  return { frames, consumed: off, total: buf.length };
}

// ── 逐行修 ──────────────────────────────────────────────────────────────
// 信封一定以 {"type":"…", 开头（所有已观测事件都如此）。用它做定点插入，
// 而不是 JSON.parse → stringify 整行重排。
const HEAD = /^\{"type":"((?:[^"\\]|\\.)*)",/;

function repairText(text) {
  const lines = text.split("\n");
  const fixed = [];
  for (const line of lines) {
    if (line === "" || line.charCodeAt(0) !== 0x7b) continue;
    // 只认**事件**。每个文件第一行是头记录 `{"type":"session","version":4,...}`，
    // 它没有 seq、也不是事件，`session` 自然不在已知类型表里 ——
    // 不排掉它就会给会话头补一个 ignorable，那是改结构，不是修事件。
    if (!line.includes('"seq":')) continue;
    const head = HEAD.exec(line);
    if (!head) continue;
    const type = head[1];
    if (KNOWN.has(type)) continue;
    // 已经是好的就不动。
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.ignorable === true) continue;
    if (parsed.type !== type) continue;
    const insertAt = `{"type":"${type}",`.length;
    if (!line.startsWith(`{"type":"${type}",`)) continue;
    fixed.push({
      seq: parsed.seq,
      type,
      line: `{"type":"${type}","ignorable":true,` + line.slice(insertAt),
    });
  }
  return { fixed };
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
if (!file) {
  console.error("用法: node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply]");
  process.exit(2);
}

const { frames, consumed, total } = readFrames(file);
if (consumed !== total) {
  console.error(`✗ 只解出 ${consumed}/${total} 字节，帧没走完 —— 拒绝改一份自己都没读全的日志。`);
  process.exit(1);
}

const texts = frames.map((b) => zlib.zstdDecompressSync(b).toString("utf8"));
const before = texts.join("");
const eventCount = before.split("\n").filter((l) => l.includes('"seq":')).length;

// 逐帧改：行数不变，所以帧与帧的边界照旧。
let changed = 0;
const allFixed = [];
const newTexts = texts.map((text) => {
  const { fixed } = repairText(text);
  if (fixed.length === 0) return text;
  changed += fixed.length;
  allFixed.push(...fixed);
  let out = text;
  for (const f of fixed) {
    // 用原始行做一次唯一替换（该行在整帧里唯一）。
    const bad = f.line.replace('{"type":"' + f.type + '","ignorable":true,', '{"type":"' + f.type + '",');
    const idx = out.indexOf(bad);
    if (idx < 0) throw new Error(`找不到要改的那一行（seq=${f.seq}）—— 拒绝半改。`);
    out = out.slice(0, idx) + f.line + out.slice(idx + bad.length);
  }
  return out;
});

console.log(`文件：${file}`);
console.log(`帧数：${frames.length}；事件数：${eventCount}`);
if (changed === 0) {
  console.log("\n✅ 没有需要修的事件（未知类型要么不存在，要么已经带了 ignorable）。");
  process.exit(0);
}
// 把「到底修了哪些类型」摆出来。类型名本身就是证据：
// 如果这里冒出 novelForge/state 之外的东西，说明还有别的地方在写自定义事件。
const byType = new Map();
for (const f of allFixed) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
console.log(`\n要补 "ignorable":true 的事件：${changed} 个`);
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t} × ${n}`);
}

if (!apply) {
  console.log("\n（这是预演。加 --apply 才真写盘，写前会先备份。）");
  process.exit(0);
}

// ── 写盘 ────────────────────────────────────────────────────────────────
// "2026-10-10T16:47:23.456Z" → 去掉 -:T 后取到秒，别把小数点带进文件名。
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backup = `${file}.before-repair-${stamp}`;
fs.copyFileSync(file, backup);
console.log(`已备份：${backup}`);

const out = Buffer.concat(newTexts.map((t) => zlib.zstdCompressSync(Buffer.from(t, "utf8"))));
const tmp = `${file}.repairing`;
fs.writeFileSync(tmp, out);

// ── 自检：改完之后必须 (1) 读得全 (2) 没有不可忽略的未知类型 (3) 事件一个不少 ──
const after = readFrames(tmp);
if (after.consumed !== after.total) throw new Error("自检失败：改完之后帧读不全。");
const afterText = after.frames.map((b) => zlib.zstdDecompressSync(b).toString("utf8")).join("");
const afterEvents = afterText.split("\n").filter((l) => l.includes('"seq":')).length;
if (afterEvents !== eventCount) throw new Error(`自检失败：事件数从 ${eventCount} 变成 ${afterEvents}。`);

const seqBefore = [];
const seqAfter = [];
for (const l of before.split("\n")) {
  const m = /"seq":(\d+)/.exec(l);
  if (m) seqBefore.push(Number(m[1]));
}
for (const l of afterText.split("\n")) {
  const m = /"seq":(\d+)/.exec(l);
  if (m) seqAfter.push(Number(m[1]));
}
if (seqBefore.join(",") !== seqAfter.join(",")) throw new Error("自检失败：seq 序列变了。");

let remaining = 0;
for (const l of afterText.split("\n")) {
  if (l === "" || l.charCodeAt(0) !== 0x7b || !l.includes('"seq":')) continue;
  const head = HEAD.exec(l);
  if (!head || KNOWN.has(head[1])) continue;
  let o; try { o = JSON.parse(l); } catch { remaining++; continue; }
  if (o.ignorable !== true) remaining++;
}
if (remaining > 0) throw new Error(`自检失败：还剩 ${remaining} 个不可忽略的未知事件。`);

fs.renameSync(tmp, file);
console.log(`\n✅ 已修好：${changed} 个事件补上了 ignorable，事件数与 seq 序列都没变。`);
console.log(`   备份留在 ${path.basename(backup)}，确认没问题再删。`);
