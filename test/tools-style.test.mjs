/** 阶段八测试：写法与检测工具层。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { styleTools } from "../lib/tools-style.js";
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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `styl-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";
const CH1 = ["雨下了三天。", "他站在门口，没进去。", "守门人认得他，假装不认得。"].join("\n");

const ctx = { logger: { info() {} }, get: () => undefined };
const m = new Map();
for (const d of styleTools(ctx, () => ws)) m.set(d.name, defineTool(d));
const call = (n, a) => m.get(n).execute(a ?? {}, { signal: new AbortController().signal });
const text = (n, r) => m.get(n).output.render({}, r)[0].text;

console.log(`阶段八 · 写法工具层测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: {
    核心创意: "雨夜剑客靠沉默传递信息", 题材与目标读者: "都市悬疑", 核心看点: "信息不对称",
    差异化方向: "反爽文", 主角核心欲望: "洗清嫌疑", 主要冲突: "沉默带来的误判",
    "明确不要什么": "不要系统流，不要金手指",
  },
});
const bookBase = wh.bookPaths(ws, BOOK).base;

const entry = (over = {}) => ({
  kind: "留白", statement: "重要的事不解释", why: "本书卖点就是信息不对称",
  evidence: { chapter: 1, lineStart: 2, quote: "他站在门口，没进去。" }, ...over,
});

// ── 写法库 ───────────────────────────────────────────────────────────────
await t("没有定稿就沉淀不了写法，并说清为什么", async () => {
  const r = await call("forge_style_add", { title: BOOK, entries: [entry()] });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-finalized");
  assert.match(text("forge_style_add", r), /不能凭空写/);
});
await t("书名非法被拒", async () => {
  const r = await call("forge_style_list", { title: "../逃逸" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate-title");
});

const rel1 = path.join(bookBase, "定稿", "卷01", "ch0001-雨夜.md");
await fs.mkdir(path.dirname(rel1), { recursive: true });
await fs.writeFile(rel1, CH1, "utf8");
await wh.commitPaths(ws, [`书仓/${BOOK}/定稿/卷01/ch0001-雨夜.md`], "ch: 第0001章 雨夜");

await t("出处编造 → 整批不落盘，并把原文实际内容摆出来", async () => {
  const r = await call("forge_style_add", { title: BOOK, entries: [entry({ statement: "编的", evidence: { chapter: 1, lineStart: 2, quote: "他走了进去。" } })] });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "evidence-rejected");
  assert.match(text("forge_style_add", r), /他站在门口，没进去。/, "报错要带原文，便于自己判断");
  assert.equal(existsSync(path.join(bookBase, "设定", "写法")), false);
});
await t("核过才落，并回报提交号", async () => {
  const r = await call("forge_style_add", { title: BOOK, entries: [entry()] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.ids.length, 1);
  assert.match(r.commit, /^[0-9a-f]{7,}/);
  assert.match(text("forge_style_add", r), /随起草任务包一起注入/);
});
await t("空的条目数组被拒", async () => {
  const r = await call("forge_style_add", { title: BOOK, entries: [] });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-batch");
});
await t("标准 1：列出时同时给出可直接注入的简报", async () => {
  const r = await call("forge_style_list", { title: BOOK });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.match(r.brief, /本书写法/);
  assert.match(text("forge_style_list", r), /第 1 章第 2 行/);
});
await t("标准 1：写法库确实进了起草材料包的风络段", async () => {
  const { assembleMaterials } = await import("../lib/materials.js");
  const pack = await assembleMaterials(ws, BOOK, 1, "雨夜", { volume: 1 });
  const styleSeg = pack.segments.find((s) => s.id === "style");
  assert.ok(styleSeg, "材料包必须有风格基准段");
  const joined = JSON.stringify(styleSeg);
  assert.match(joined, /写法/, "写法库要作为风格基准的候选来源出现");
});
await t("一条都没有时如实说没有，不编通用文风", async () => {
  const other = "空书";
  await wh.createBook(ws, { title: other, concept: {
    核心创意: "x", 题材与目标读者: "y", 核心看点: "z", 差异化方向: "a",
    主角核心欲望: "b", 主要冲突: "c", "明确不要什么": "d" } });
  const r = await call("forge_style_list", { title: other });
  assert.equal(r.count, 0);
  assert.match(text("forge_style_list", r), /不要凭想象/);
});

// ── 扫榜 ─────────────────────────────────────────────────────────────────
await t("没有机制时明确说先跑拆书，不假装扫过", async () => {
  const r = await call("forge_scan_mechanisms", { title: BOOK });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-mechanisms");
  assert.match(r.detail, /拆书管道/);
});
await t("没有构想快照时拒绝扫榜", async () => {
  await wh.createBook(ws, { title: "无构想", concept: {
    核心创意: "", 题材与目标读者: "", 核心看点: "z", 差异化方向: "a",
    主角核心欲望: "b", 主要冲突: "c", "明确不要什么": "" } });
  const r = await call("forge_scan_mechanisms", { title: "无构想" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-concept");
});

await fs.rm(path.join(projectRoot, "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, "..", ".forge-test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
