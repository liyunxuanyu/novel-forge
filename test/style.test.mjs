/** 阶段八测试：写法库 + 扫榜。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as st from "../lib/style.js";
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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `sty-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

const CH1 = [
  "雨下了三天。",
  "他站在门口，没进去。",
  "守门人认得他，假装不认得。",
  "他把伞收了。",
].join("\n");

console.log(`阶段八 · 写法库与扫榜测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: {
    核心创意: "雨夜剑客靠沉默传递信息",
    题材与目标读者: "都市悬疑",
    核心看点: "信息不对称",
    差异化方向: "反爽文",
    主角核心欲望: "洗清嫌疑",
    主要冲突: "沉默带来的误判",
    "明确不要什么": "不要系统流，不要金手指，不要无脑后宫",
  },
});
const bookBase = wh.bookPaths(ws, BOOK).base;

// ── n-gram 重叠 ──────────────────────────────────────────────────────────
await t("中文没有空格，n-gram 仍能跨标点对上", () => {
  const hits = st.distinctiveOverlap("系统流、升级流的作品不要照搬这种沉默铺陈", "不要系统流，不要金手指");
  assert.ok(hits.includes("系统流"), `实际 ${JSON.stringify(hits)}`);
});
await t("重叠里丢掉被更长命中包含的碎片", () => {
  const hits = st.distinctiveOverlap("不要系统流", "不要系统流");
  assert.equal(hits.length, 1);
  assert.equal(hits[0], "不要系统流");
});
await t("目标为空时不产生任何重叠", () => {
  assert.deepEqual(st.distinctiveOverlap("系统流", ""), []);
  assert.deepEqual(st.distinctiveOverlap("系统流", undefined), []);
});
await t("片段按长度从长到短，最多三个", () => {
  const hits = st.distinctiveOverlap("都市悬疑节奏反爽文系统流", "都市悬疑反爽文系统流");
  assert.ok(hits.length <= 3);
  assert.equal(hits[0].length, Math.max(...hits.map((h) => h.length)), "最长的排最前");
});

// ── 标准 3：扫榜 ─────────────────────────────────────────────────────────
const ctx = {
  dontWant: "不要系统流，不要金手指，不要无脑后宫",
  genre: "都市悬疑",
  core: "雨夜剑客靠沉默传递信息",
};

await t("标准 3：撞上「明确不要什么」→ 别用", () => {
  const r = st.judgeMechanism({ name: "沉默铺陈", notAppliesWhen: "系统流、升级流的作品不要照搬这种沉默铺陈", appliesWhen: "偏文学的叙事" }, ctx);
  assert.equal(r.verdict, "别用", JSON.stringify(r));
  assert.match(r.reason, /系统流/);
});
await t("适用条件对上题材 → 可用", () => {
  const r = st.judgeMechanism({ name: "都市节奏", notAppliesWhen: "欢脱喜剧不要用", appliesWhen: "都市悬疑里的追索节奏" }, ctx);
  assert.equal(r.verdict, "可用", JSON.stringify(r));
});
await t("适用条件对不上 → 要改着用，且不假装很确定", () => {
  const r = st.judgeMechanism({ name: "仙侠氛围", notAppliesWhen: "现实题材慎用", appliesWhen: "仙侠世界的门派更替" }, ctx);
  assert.equal(r.verdict, "要改着用");
  assert.match(r.reason, /试一章/);
});
await t("判定顺序：先看不适用条件，再看适用条件", () => {
  // 这条机制两个条件都能撞上——必须按不适用优先判成「别用」
  const r = st.judgeMechanism({ name: "两头都撞", notAppliesWhen: "都市悬疑里的系统流别用", appliesWhen: "都市悬疑常用" }, ctx);
  assert.equal(r.verdict, "别用", "适用条件说能用不算数，不适用条件说别用才算数");
});
await t("一批机制逐条判定并统计", () => {
  const s = st.scanMechanisms([
    { id: "m1", name: "甲", notAppliesWhen: "系统流不要用", appliesWhen: "都市悬疑" },
    { id: "m2", name: "乙", notAppliesWhen: "仙侠慎用", appliesWhen: "都市悬疑" },
    { id: "m3", name: "丙", notAppliesWhen: "欢脱喜剧慎用", appliesWhen: "仙侠" },
  ], ctx);
  assert.equal(s.total, 3);
  assert.equal(s.tally["别用"], 1);
  assert.equal(s.tally["可用"], 1);
  assert.equal(s.tally["要改着用"], 1);
  assert.equal(s.rows.find((r) => r.id === "m1").verdict, "别用");
});
await t("占位词「留白」要还原成空值，不能当成作者填过的内容", () => {
  const c = st.bookContext("# 构想快照\n\n## 题材与目标读者\n\n留白\n\n## 明确不要什么\n\n不要系统流\n\n## 核心创意\n\n留白\n");
  assert.equal(c.genre, "", "没填的字段是「留白」，不是内容");
  assert.equal(c.core, "");
  assert.equal(c.dontWant, "不要系统流", "真填了的内容照常取");
});

await t("从构想快照里取出扫榜要用的三段", async () => {
  const c = st.bookContext(await fs.readFile(wh.bookPaths(ws, BOOK).concept, "utf8"));
  assert.match(c.dontWant, /系统流/);
  assert.match(c.genre, /都市悬疑/);
  assert.match(c.core, /沉默/);
});

// ── 标准 2：写法条目可核证 ───────────────────────────────────────────────
const entry = (over = {}) => ({
  kind: "留白", statement: "重要的事不解释，让读者自己拼",
  why: "本书卖点就是信息不对称，说破就没了",
  evidence: { chapter: 1, lineStart: 2, quote: "他站在门口，没进去。" },
  ...over,
});

await t("还没定稿章节时，沉淀写法被挡", async () => {
  const r = await st.addStyleEntries(ws, BOOK, [entry()]);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-finalized");
  assert.match(r.detail, /不能凭空写/);
});

async function landChapter() {
  const rel = path.join(wh.bookPaths(ws, BOOK).base, "定稿", "卷01", "ch0001-雨夜.md");
  await fs.mkdir(path.dirname(rel), { recursive: true });
  await fs.writeFile(rel, CH1, "utf8");
  const c = await wh.commitPaths(ws, [`书仓/${BOOK}/定稿/卷01/ch0001-雨夜.md`], "ch: 第0001章 雨夜");
  assert.equal(c.ok, true, JSON.stringify(c));
}

await landChapter();

await t("出处核不上 → 整批不落盘", async () => {
  const r = await st.addStyleEntries(ws, BOOK, [
    entry({ statement: "好的那条" }),
    entry({ statement: "编的那条", evidence: { chapter: 1, lineStart: 2, quote: "他大步走了进去。" } }),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "evidence-rejected");
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].detail, /第 1 章第 2 行实际是/, "要把原文实际内容摆出来");
  assert.equal(existsSync(path.join(bookBase, "设定", "写法")), false);
});
await t("整批核过才落真源，并产生 design: 提交", async () => {
  const r = await st.addStyleEntries(ws, BOOK, [
    entry(),
    entry({ kind: "对话", statement: "对话不写神态，让语气自己交代", why: "本书没有内心戏", evidence: { chapter: 1, lineStart: 3, quote: "守门人认得他，假装不认得。" } }),
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ids, ["w001", "w002"]);
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "design: 沉淀写法库");
});
await t("缺 why 被拒：写法不能只有偏好没有理由", async () => {
  const r = await st.addStyleEntries(ws, BOOK, [entry({ why: "" })]);
  assert.equal(r.ok, false);
  assert.match(r.rejected[0].detail, /why/);
});
await t("不认识的写法类别被拒", () => {
  assert.equal(st.validateStyleEntry(entry({ kind: "随便" })).ok, false);
});
await t("核验器逐种情形都给清楚理由", () => {
  const chs = new Map([[1, { chapter: 1, lines: CH1.split("\n") }]]);
  assert.equal(st.verifyStyleEvidence(chs, { chapter: 1, lineStart: 1, quote: "雨下了三天。" }).ok, true);
  assert.equal(st.verifyStyleEvidence(chs, { chapter: 9, lineStart: 1, quote: "x" }).reason, "no-chapter");
  assert.equal(st.verifyStyleEvidence(chs, { chapter: 1, lineStart: 99, quote: "x" }).reason, "out-of-range");
  assert.equal(st.verifyStyleEvidence(chs, { chapter: 1, lineStart: 0, quote: "x" }).reason, "bad-locator");
  assert.equal(st.verifyStyleEvidence(chs, { chapter: 1, lineStart: 1, quote: "  " }).reason, "no-quote");
});

// ── 列出与注入 ───────────────────────────────────────────────────────────
await t("列出写法条目，带出处", async () => {
  const r = await st.listStyleEntries(ws, BOOK);
  assert.equal(r.count, 2);
  assert.equal(r.entries[0].kind, "留白");
  assert.equal(r.entries[0].chapter, 1);
  assert.equal(r.entries[0].lineStart, 2);
});
await t("标准 1：写法库渲染成起草任务包里的一段", async () => {
  const r = await st.listStyleEntries(ws, BOOK);
  const brief = st.renderStyleBrief(r.entries);
  assert.match(brief, /本书写法/);
  assert.match(brief, /### 留白/);
  assert.match(brief, /第 1 章第 2 行/, "出处要跟着走，起草子代理才知道这不是凭空规定");
});
await t("没有写法条目时如实说没有，不编一段通用文风", () => {
  const brief = st.renderStyleBrief([]);
  assert.match(brief, /还没有沉淀写法条目/);
  assert.match(brief, /不要凭想象/);
});
await t("不存在的书被拒", async () => {
  const r = await st.listStyleEntries(ws, "../逃逸");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate-title");
});

await fs.rm(path.join(projectRoot, "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, "..", ".forge-test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
