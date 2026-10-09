/**
 * 阶段十测试：派出审读这一步，以及章号校验不抛异常。
 *
 * 它是被离线全链测出来的两个真问题：
 *  1. 状态机里 dispatch_review（待审 → 审读中）此前没有任何工具能触发，
 *     于是 record_findings 永远被挡在门外，一章都走不到定稿。
 *  2. 九个章节工具在章号非法时直接抛异常。链条跑到一半甩异常，
 *     等于需要人来救火——而这条链条的目标恰恰是无人值守。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { chapterTools } from "../lib/tools-chapter.js";
import { warehouseTools } from "../lib/tools-warehouse.js";
import * as wh from "../lib/warehouse.js";

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
const ws = path.join(projectRoot, ".test-sandbox", `rev-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "审读试炼";
const logger = { info() {}, warn() {}, error() {} };
const byName = new Map([...warehouseTools({ logger }, () => ws), ...chapterTools({ logger }, () => ws)].map((d) => [d.name, defineTool(d)]));
const call = (n, a) => byName.get(n).execute(a ?? {}, { signal: new AbortController().signal });

console.log(`阶段十 · 派出审读与章号校验测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: { 核心创意: "x", 题材与目标读者: "x", 核心看点: "x", 差异化方向: "x", 主角核心欲望: "x", 主要冲突: "x", 明确不要什么: "x" },
});

await t("还没稿子就不许派审读", async () => {
  assert.equal((await call("forge_outline_draft", { title: BOOK, chapter: 1, volume: 1, body: "〔硬〕x\n" })).ok, true);
  assert.equal((await call("forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 })).ok, true);
  assert.equal((await call("forge_assemble_materials", { title: BOOK, chapter: 1, volume: 1 })).ok, true);
  const r = await call("forge_dispatch_review", { title: BOOK, chapter: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-draft", JSON.stringify(r));
});

await t("有稿才能派：待审 → 审读中", async () => {
  assert.equal((await call("forge_import_draft", { title: BOOK, chapter: 1, body: "雨停了。", origin: "AI 起草" })).ok, true);
  const r = await call("forge_dispatch_review", { title: BOOK, chapter: 1, dimensions: ["结构", "文风"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.nextStage, "审读中");
  assert.equal(r.revisions, 1);
});

await t("派完之后才允许回写发现项（这是断链的那一环）", async () => {
  const r = await call("forge_record_findings", { title: BOOK, chapter: 1, covered: ["结构"], findings: [{ quote: "雨停了。", note: "太平" }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.passed, false);
});

await t("同一稿不能重复派审读", async () => {
  const r = await call("forge_dispatch_review", { title: BOOK, chapter: 1 });
  assert.equal(r.ok, false, "还在审读中，不该被派第二次");
  assert.equal(r.stage, "transition", JSON.stringify(r));
});

await t("改完再派是新的一轮，轮次是正整数", async () => {
  assert.equal((await call("forge_import_draft", { title: BOOK, chapter: 1, body: "雨停得很急。", origin: "改稿" })).ok, true);
  const r = await call("forge_dispatch_review", { title: BOOK, chapter: 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Number.isInteger(r.revisions) && r.revisions >= 1, `轮次要是正整数，实际 ${r.revisions}`);
});

await t("缺覆盖维度时零发现项过不去（宿主 schema 就拦下）", async () => {
  let threw = null;
  try {
    await call("forge_record_findings", { title: BOOK, chapter: 1, findings: [] });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "缺 covered 就该被拦下");
  assert.match(String(threw.message ?? threw), /covered/);
});

await t("补上这一章真的能一路走到定稿", async () => {
  const good = await call("forge_record_findings", { title: BOOK, chapter: 1, covered: ["结构", "对话"], findings: [] });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.passed, true);
  const st = await call("forge_settle_chapter", { title: BOOK, chapter: 1, chapterTitle: "第1章 试炼", body: "雨停得很急。" });
  assert.equal(st.ok, true, JSON.stringify(st));
  const book = await call("forge_book_status", { title: BOOK });
  assert.equal(book.status.finalizedChapterCount, 1, "断链补上之后，一章能走完整个流程");
});

await t("章号非法返回结构化错误，不抛异常（九个章节工具统一）", async () => {
  const names = [
    "forge_chapter_status", "forge_outline_draft", "forge_confirm_outline", "forge_assemble_materials",
    "forge_draft_task", "forge_import_draft", "forge_dispatch_review", "forge_record_findings", "forge_settle_chapter",
  ];
  for (const n of names) {
    const r = await call(n, { title: BOOK, chapter: 0, body: "x", chapterTitle: "x", covered: [], volume: 1 });
    assert.equal(r.ok, false, `${n} 对非法章号应当返回 ok:false，实际 ${JSON.stringify(r)}`);
    assert.equal(r.stage, "validate-chapter", `${n} 的错误分类不对：${JSON.stringify(r)}`);
  }
});

await t("负数与小数章号同样被挡", async () => {
  assert.equal((await call("forge_dispatch_review", { title: BOOK, chapter: -1 })).stage, "validate-chapter");
  // 1.5 在宿主 schema 就被整数校验挡下，根本到不了 execute
  let threw = null;
  try { await call("forge_dispatch_review", { title: BOOK, chapter: 1.5 }); } catch (e) { threw = e; }
  assert.ok(threw, "小数章号该被宿主 schema 挡住");
  assert.match(String(threw?.message ?? threw), /integer/);
});

await t("空书名仍然被挡", async () => {
  const r = await call("forge_dispatch_review", { title: "   ", chapter: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate-title", JSON.stringify(r));
});

await fs.rm(ws, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
