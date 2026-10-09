/**
 * 细纲约束分级闸门。
 *
 * 提示词里一遍遍交代要标〔硬〕〔软〕〔自由〕，但真模型会漏。漏标的细纲照样落真源，
 * 然后整章照着一份没有约束的骨架写下去 —— 整卷白写，而且要到审读才发现。
 * 所以这道门要挡在落真源之前，而不是靠提示词自觉。
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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `mk-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "分级试炼";
const logger = { info() {}, warn() {}, error() {} };
const byName = new Map([...warehouseTools({ logger }, () => ws), ...chapterTools({ logger }, () => ws)].map((d) => [d.name, defineTool(d)]));
const call = (n, a) => byName.get(n).execute(a ?? {}, { signal: new AbortController().signal });

console.log(`阶段十 · 细纲约束分级闸门测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: { 核心创意: "x", 题材与目标读者: "x", 核心看点: "x", 差异化方向: "x", 主角核心欲望: "x", 主要冲突: "x", 明确不要什么: "x" },
});

async function tryConfirm(chapter, body) {
  await call("forge_outline_draft", { title: BOOK, chapter, volume: 1, body });
  return call("forge_confirm_outline", { title: BOOK, chapter, volume: 1 });
}

await t("完全没有分级标记：确认被挡，真源一个字都没写", async () => {
  const r = await tryConfirm(1, "# 第 1 章\n\n沈昭在雨里站了很久，最后走了。\n");
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.stage, "outline-unmarked", JSON.stringify(r));
  const dir = path.join(ws, "书仓", BOOK, "大纲", "卷01");
  let files = [];
  try { files = await fs.readdir(dir); } catch { files = []; }
  assert.deepEqual(files, [], `被挡之后不该留下真源文件，实际有 ${JSON.stringify(files)}`);
});

await t("正文里顺口提到「硬要求」不算数，必须标在行首", async () => {
  const r = await tryConfirm(1, "# 第 1 章\n\n这段是硬要求：沈昭必须开口。\n");
  assert.equal(r.ok, false, "叙述里的说法不算分级标记");
  assert.equal(r.stage, "outline-unmarked", JSON.stringify(r));
});

await t("列表符号和序号前面标也算行首", async () => {
  const r = await tryConfirm(1, "# 第 1 章\n\n- 〔硬〕沈昭必须开口。\n- 〔软〕保留雨声。\n");
  assert.equal(r.ok, true, JSON.stringify(r));
});

await t("只标一级也认，并回报认出了哪几级", async () => {
  const r = await tryConfirm(2, "〔自由〕收尾自定。\n");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.marks, ["自由"], `应当只认出自由级，实际 ${JSON.stringify(r.marks)}`);
});

await t("被挡之后改正文就能过：候选可以糙，确认不能糙", async () => {
  const r = await tryConfirm(3, "# 第 3 章\n\n沈昭推开了门。\n\n〔硬〕门必须关上。\n");
  assert.equal(r.ok, true, "补上分级后应当放行：" + JSON.stringify(r));
  assert.deepEqual(r.marks, ["硬"], JSON.stringify(r.marks));
});

await t("空白正文仍报空，不是报缺分级", async () => {
  await call("forge_outline_draft", { title: BOOK, chapter: 4, volume: 1, body: "   \n" });
  const r = await call("forge_confirm_outline", { title: BOOK, chapter: 4, volume: 1 });
  assert.equal(r.stage, "empty-draft", JSON.stringify(r));
});

await t("状态没被推进，而且改正文后同章仍能确认，不是死路", async () => {
  await call("forge_outline_draft", { title: BOOK, chapter: 5, volume: 1, body: "没有分级。\n" });
  const bad = await call("forge_confirm_outline", { title: BOOK, chapter: 5, volume: 1 });
  assert.equal(bad.ok, false);
  const outlineFile = path.join(ws, "书仓", BOOK, "大纲", "卷01", "ch0005-细纲.md");
  await assert.rejects(() => fs.access(outlineFile), "被挡的章不该有真源细纲文件");
  await call("forge_outline_draft", { title: BOOK, chapter: 5, volume: 1, body: "〔硬〕这次标了。\n" });
  const good = await call("forge_confirm_outline", { title: BOOK, chapter: 5, volume: 1 });
  assert.equal(good.ok, true, JSON.stringify(good));
});

await t("确认过的细纲正文里带着分级标记进真源", async () => {
  const file = path.join(ws, "书仓", BOOK, "大纲", "卷01", "ch0001-细纲.md");
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /〔硬〕/, "落真源的正文必须带着分级标记");
});

await fs.rm(ws, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
