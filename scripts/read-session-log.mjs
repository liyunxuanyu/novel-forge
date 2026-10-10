// 会话日志读取器：DSH 的 session.v4.jsonl.zstd 是**多帧拼接**的 zstd 流，
// 不是单个 frame。node:zlib 的 zstdDecompressSync 只解第一帧（那帧通常只有
// 210 字节的 session 头），所以直接调它看到的事件类型分布是假的。
//
// 这里按 zstd 帧结构手动走帧：magic(4) + FHD(1) + [WindowDesc] + [DictID] +
// [FrameContentSize] + blocks + [Checksum]，逐帧解压再拼起来。
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = 0xfd2fb528;

/** 走一帧，返回 { length, bytes }。 */
function frameLength(buf, start) {
  let p = start;
  if (buf.readUInt32LE(p) !== MAGIC) throw new Error(`偏移 ${p} 不是 zstd 帧头`);
  p += 4;
  const fhd = buf[p];
  p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1;
  const dictIdFlag = fhd & 3;
  if (!singleSegment) p += 1; // Window_Descriptor
  p += [0, 1, 2, 4][dictIdFlag]; // Dictionary_ID
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  p += fcsSize;
  // blocks
  for (;;) {
    const hdr = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = hdr & 1;
    const type = (hdr >> 1) & 3;
    const size = hdr >> 3;
    if (type === 1) p += 1; // RLE：1 字节
    else p += size; // Raw / Compressed 都是 size 字节
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return { length: p - start, bytes: buf.subarray(start, p) };
}

export function readSessionLog(file) {
  const buf = readFileSync(file);
  const chunks = [];
  let off = 0;
  let frames = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) break;
    if (buf.readUInt32LE(off) !== MAGIC) break;
    const { length, bytes } = frameLength(buf, off);
    chunks.push(zstdDecompressSync(bytes).toString("utf8"));
    off += length;
    frames++;
  }
  return { text: chunks.join(""), frames, consumed: off, total: buf.length };
}

export function parseEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行，跳过 */ }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("read-session-log.mjs")) {
  const file = process.argv[2];
  if (!file) { console.error("用法: <file.mjs> <session.v4.jsonl.zstd>"); process.exit(2); }
  const { text, frames, consumed, total } = readSessionLog(file);
  const events = parseEvents(text);
  const counts = new Map();
  for (const e of events) counts.set(e?.type ?? "(无 type)", (counts.get(e?.type ?? "(无 type)") ?? 0) + 1);
  console.log(`文件: ${file}`);
  console.log(`帧数 ${frames}｜消费 ${consumed}/${total} 字节｜事件 ${events.length} 条`);
  console.log("");
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));
  const poison = events.filter((e) => e?.type === "novelForge/state");
  console.log("");
  if (poison.length === 0) console.log("novelForge/state：未出现 ✅");
  else {
    console.log(`novelForge/state：${poison.length} 条 ❌`);
    for (const p of poison) {
      const when = p.time ? new Date(p.time).toISOString() : "(无 time)";
      console.log(`  seq=${p.seq} time=${when} ignorable=${String(p.ignorable)} keys=${Object.keys(p.data ?? {}).join(",")}`);
    }
  }
  // 任何不在已知词汇表里、又没标 ignorable 的事件都是「会话杀手」，一并报出来。
  // 首行是 session 头记录（没有 seq），不是事件，跳过。
  const KNOWN = /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)+$/;
  const suspicious = events.filter((e) => e?.type && e.seq !== undefined && !KNOWN.test(e.type) && e.ignorable !== true);
  if (suspicious.length > 0) {
    console.log("");
    console.log("⚠ 未知类型且未标 ignorable（会让整份日志读不回来）：");
    for (const s of suspicious) console.log(`  seq=${s.seq} type=${s.type}`);
  }
}
