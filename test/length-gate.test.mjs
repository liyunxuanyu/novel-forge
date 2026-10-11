/**
 * 篇幅闸门。
 *
 * 目标字数以前只是任务包里的一句提示。真模型交回 300 字的截断稿（上下文截断、
 * 偷懒、或者干脆写崩了），没人拦，照样定稿出厂——整卷字斟句酌的空壳，
 * 而且日志上一片正常。
 *
 * 分寸：导入只提醒，定稿才拦。导入拦会把链条卡死等作者，那本身就是需要人工救火。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { chapterTools } from "../lib/tools-chapter.js";
import { warehouseTools } from "../lib/tools-warehouse.js";
import { fanoutTools } from "../lib/tools-fanout.js";
import { MIN_LENGTH_RATIO, countWords, checkChapterLength } from "../lib/chapter-state.js";
import { outlineFixture } from "./helpers/outline-fixture.mjs";

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message ?? error}`);
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `len-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "篇幅试炼";
const logger = { info() {}, warn() {}, error() {} };
const ctx = { logger, get: () => undefined };
const map = new Map(
  [...warehouseTools(ctx, () => ws), ...fanoutTools(ctx, () => ws), ...chapterTools(ctx, () => ws)].map((d) => [d.name, defineTool(d)]),
);
const call = (n, a) => map.get(n).execute(a ?? {}, { signal: new AbortController().signal });

/**
 * 宿主判的是「无损 JSON」：undefined / 函数 / NaN 任何一样都会让整次调用
 * 变成 invalid output。注意**不能**用 JSON.stringify 来查 —— 它会把
 * undefined 的键直接吞掉，于是断言消息里看着一切正常。
 */
function assertLossless(value, label = "返回值") {
  const walk = (x, p) => {
    if (x === undefined) throw new Error(`${label} 在 ${p} 有 undefined —— 宿主会判成 invalid output`);
    if (typeof x === "function") throw new Error(`${label} 在 ${p} 有函数`);
    if (typeof x === "number" && !Number.isFinite(x)) throw new Error(`${label} 在 ${p} 有非有限数 ${x}`);
    if (x !== null && typeof x === "object") for (const k of Object.keys(x)) walk(x[k], `${p}.${k}`);
  };
  walk(value, "$");
}

console.log(`阶段十 · 篇幅闸门测试（下限 ${MIN_LENGTH_RATIO}）\n沙盒: ${ws}\n`);

await t("纯函数：没定目标就放行，定了目标才判", async () => {
  assert.equal(checkChapterLength(10, undefined).ok, true);
  assert.equal(checkChapterLength(10, 0).ok, true);
  assert.equal(checkChapterLength(1500, 3000).ok, true, "正好一半应当放行");
  assert.equal(checkChapterLength(1499, 3000).ok, false);
});

await t("纯函数：字数口径不计空白", async () => {
  assert.equal(countWords(" 雨\n下\t到  "), 3);
});

assert.equal((await call("forge_init_workspace", {})).ok, true);
await call("forge_create_book", {
  title: BOOK, coreIdea: "x", genreAndAudience: "x", keyAppeal: "x", differentiation: "x",
  protagonistDesire: "x", mainConflict: "x", explicitlyAvoid: "x",
});
for (const [artifact, body] of Object.entries({
  skeleton: "# 故事骨架\n\n## 第一部 追求\n要开口。\n\n## 索引\n\n- 人物 / 沈昭\n",
  worldbook: "## 人物｜沈昭\n\n剑客。\n",
  layout: "## 第 1 卷（第 1–3 章）｜雨落\n",
  "volume-plan": "## 卷一目标\n开口。\n",
})) {
  await call("forge_artifact_candidate", { title: BOOK, artifact, body });
  await call("forge_confirm_artifact", { title: BOOK, artifact });
}

await t("目标字数确实被记进章节状态", async () => {
  await call("forge_outline_draft", { title: BOOK, chapter: 1, volume: 1, body: outlineFixture({ constraints: ["〔硬〕沈昭必须开口。"] }) });
  await call("forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 });
  await call("forge_assemble_materials", { title: BOOK, chapter: 1, volume: 1 });
  const r = await call("forge_draft_task", { title: BOOK, chapter: 1, chapterTitle: "雨夜", targetWords: 2000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.targetWords, 2000);
});

await t("导入短稿：放行，但如实标出 short", async () => {
  const r = await call("forge_import_draft", { title: BOOK, chapter: 1, body: "沈昭张口。" });
  assert.equal(r.ok, true, "导入阶段不该拦，拦了就把链条卡死等作者");
  assert.equal(r.words, 5);
  assert.equal(r.short, true, JSON.stringify(r));
  assert.match(String(r.note ?? ""), /只有 5 字，目标 2000 字/);
});

await t("导入足量稿：不标 short，且返回值必须是无损 JSON", async () => {
  const body = "雨".repeat(1200);
  const r = await call("forge_import_draft", { title: BOOK, chapter: 1, body });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.short, false, JSON.stringify(r));
  // 这里以前写的是 `assert.equal(r.note, undefined)` —— 它把 bug 当成了规格。
  // 实现里当时是 `note: len.ok ? undefined : len.detail`，真机上宿主判的是
  // 无损 JSON，于是**稿子够长的成功路径**整次调用变成 invalid output，
  // 而稿子太短的那条失败路径反而正常。测试却因为断言的就是 undefined，
  // 一直绿着。正确的规格是「note 这个键压根不出现」。
  assert.ok(!("note" in r), `够长的稿子不该带 note 这个键，实际 ${JSON.stringify(r)}`);
  assertLossless(r, "forge_import_draft 足量稿");
});

await t("导入短稿：带 note，且同样是无损 JSON", async () => {
  const r = await call("forge_import_draft", { title: BOOK, chapter: 1, body: "沈昭张口。" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.short, true, JSON.stringify(r));
  assert.match(String(r.note), /只有 5 字，目标 2000 字/);
  assertLossless(r, "forge_import_draft 短稿");
});

async function toPending() {
  await call("forge_import_draft", { title: BOOK, chapter: 1, body: "雨".repeat(1200) });
  await call("forge_dispatch_review", { title: BOOK, chapter: 1 });
  await call("forge_record_findings", { title: BOOK, chapter: 1, covered: ["结构", "文风"], findings: [] });
}
await toPending();

await t("审读通过后定稿：足量正文照常入档", async () => {
  const r = await call("forge_settle_chapter", { title: BOOK, chapter: 1, chapterTitle: "雨夜" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bookStatus.finalizedChapterCount, 1);
});

await t("定稿空壳被拦：书仓里一个定稿文件都没多出来", async () => {
  await call("forge_outline_draft", { title: BOOK, chapter: 2, volume: 1, body: outlineFixture({ constraints: ["〔硬〕沈昭必须开口。"] }) });
  await call("forge_confirm_outline", { title: BOOK, chapter: 2, volume: 1 });
  await call("forge_assemble_materials", { title: BOOK, chapter: 2, volume: 1 });
  await call("forge_draft_task", { title: BOOK, chapter: 2, volume: 1, targetWords: 2000 });
  await call("forge_import_draft", { title: BOOK, chapter: 2, body: "雨".repeat(1200) });
  await call("forge_dispatch_review", { title: BOOK, chapter: 2 });
  await call("forge_record_findings", { title: BOOK, chapter: 2, covered: ["结构"], findings: [] });

  const bad = await call("forge_settle_chapter", { title: BOOK, chapter: 2, chapterTitle: "空壳", body: "沈昭张口。" });
  assert.equal(bad.ok, false, "空壳不该出厂：" + JSON.stringify(bad));
  assert.equal(bad.stage, "too-short", JSON.stringify(bad));
  assert.match(String(bad.detail), /只有 5 字/);
  const file = path.join(ws, "书仓", BOOK, "定稿", "卷01", "ch0002-空壳.md");
  await assert.rejects(() => fs.access(file), "被拦就不该留下定稿文件");
  const st = await call("forge_book_status", { title: BOOK });
  assert.equal(st.status.finalizedChapterCount, 1, `被拦的章不该计入已定稿，实际 ${st.status?.finalizedChapterCount}`);
});

await t("allowShort 放行：短章、番外是合法体裁，不做陷阱", async () => {
  const ok = await call("forge_settle_chapter", { title: BOOK, chapter: 2, chapterTitle: "空壳", body: "沈昭张口。", allowShort: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.bookStatus.finalizedChapterCount, 2);
});

await t("被拦之后改正文就能过：不是死路", async () => {
  await call("forge_outline_draft", { title: BOOK, chapter: 3, volume: 1, body: outlineFixture({ constraints: ["〔硬〕沈昭必须开口。"] }) });
  await call("forge_confirm_outline", { title: BOOK, chapter: 3, volume: 1 });
  await call("forge_assemble_materials", { title: BOOK, chapter: 3, volume: 1 });
  await call("forge_draft_task", { title: BOOK, chapter: 3, volume: 1, targetWords: 2000 });
  await call("forge_import_draft", { title: BOOK, chapter: 3, body: "雨".repeat(1200) });
  await call("forge_dispatch_review", { title: BOOK, chapter: 3 });
  await call("forge_record_findings", { title: BOOK, chapter: 3, covered: ["结构"], findings: [] });
  const good = await call("forge_settle_chapter", { title: BOOK, chapter: 3, chapterTitle: "雨夜三" });
  assert.equal(good.ok, true, JSON.stringify(good));
});

await fs.rm(ws, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}