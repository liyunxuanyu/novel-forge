/** 阶段五测试：导演工具层。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { directorTools } from "../lib/tools-director.js";
import * as wh from "../lib/warehouse.js";
import * as cs from "../lib/chapter-state.js";
import * as g from "../lib/gates.js";

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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `dtool-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

const byName = new Map();
for (const def of directorTools({ logger: { info() {}, warn() {}, error() {} } }, () => ws)) {
  byName.set(def.name, defineTool(def));
}
const call = (n, a) => byName.get(n).execute(a ?? {}, { signal: new AbortController().signal });

console.log(`阶段五 · 导演工具层测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: { 核心创意: "x", 题材与目标读者: "x", 核心看点: "x", 差异化方向: "x", 主角核心欲望: "x", 主要冲突: "x", "明确不要什么": "x" },
});
const bookBase = wh.bookPaths(ws, BOOK).base;
async function writeInBook(rel, content) {
  const abs = path.join(bookBase, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  await wh.commitPaths(ws, [path.relative(ws, abs).replace(/\\/g, "/")], `design: 更新 ${rel}`);
}

await t("刚建书：导演指向骨架，且渲染出来带得上", async () => {
  const r = await call("forge_director_next", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.node, "design.skeleton");
  assert.equal(r.proceed, false);
  const text = byName.get("forge_director_next").output.render({}, r)[0].text;
  assert.match(text, /必须作者拍板/);
  assert.match(text, /故事骨架走向哪一版/);
});

await t("stop 门禁上不许派子代理——必须先问作者", async () => {
  const r = await call("forge_director_plan", { title: BOOK, context: {} });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "gate-stopped");
  assert.match(r.detail, /story|骨架|拍板|问作者/);
});

await writeInBook("大纲/故事骨架.md", "# 故事骨架\n");
await writeInBook("大纲/分卷布局.md", "## 第 1 卷（第 1–2 章）｜雨落\n");

await t("auto 节点放行，并说明可并行排开的步骤", async () => {
  const r = await call("forge_director_next", { title: BOOK });
  assert.equal(r.proceed, true);
  assert.equal(r.chapter, 1);
  assert.equal(r.canFanOut, true);
  assert.deepEqual(r.fanOutSteps, ["outline", "materials", "draft", "review"]);
});

await t("细纲步骤生成自包含任务文本，真源内容真的进去了", async () => {
  const r = await call("forge_director_plan", {
    title: BOOK,
    context: {
      outlineBrief: "沈昭必须在雨中对仇人说出第一个字",
      volumePlan: "卷一目标：沈昭开口。",
      prevChapter: "（全书第一章）",
      contract: "不要系统流",
      foreshadow: "断剑：第 7 章收",
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.needsModel, true);
  assert.equal(r.role, "章细纲起草子代理");
  assert.ok(r.prompt.includes("沈昭必须在雨中对仇人说出第一个字"));
  assert.ok(r.prompt.includes("不要系统流"));
  assert.ok(r.prompt.includes("断剑"));
  assert.ok(r.prompt.includes("〔硬〕"), "必须要求标约束分级");
  assert.ok(r.outputHint.includes("〔硬〕"));
});

await t("任务文本不含绝对路径", async () => {
  const r = await call("forge_director_plan", { title: BOOK, context: { outlineBrief: "开口", volumePlan: "卷一目标：沈昭开口。", contract: "不要系统流" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.prompt.includes(projectRoot), false);
  assert.equal(r.prompt.includes("D:\\"), false);
});

await cs.advance(ws, BOOK, "ch0001", 1, "draft_outline");
await cs.advance(ws, BOOK, "ch0001", 1, "confirm_outline");

await t("备料是纯工具步骤，明说不需要子代理", async () => {
  const r = await call("forge_director_plan", { title: BOOK, context: {} });
  assert.equal(r.ok, true);
  assert.equal(r.needsModel, false);
  assert.equal(r.role, undefined);
  assert.match(r.outputHint, /forge_assemble_materials/);
});

await cs.advance(ws, BOOK, "ch0001", 1, "assemble_materials");

await t("起草步骤派起草子代理，任务包原文嵌进去", async () => {
  const r = await call("forge_director_plan", { title: BOOK, context: { taskText: "【本章任务】雨夜开口〔硬〕" } });
  assert.equal(r.role, "正文起草子代理");
  assert.ok(r.prompt.includes("【本章任务】雨夜开口〔硬〕"));
  assert.ok(r.prompt.includes("只输出正文"));
});

await cs.advance(ws, BOOK, "ch0001", 1, "build_draft_task");
await cs.advance(ws, BOOK, "ch0001", 1, "import_draft");

await t("审读步骤把维度列全，并要求逐字引文", async () => {
  const r = await call("forge_director_plan", { title: BOOK, context: { draftText: "雨下到第四日。" } });
  assert.equal(r.role, "审读子代理");
  assert.ok(r.prompt.includes("雨下到第四日。"));
  assert.ok(r.prompt.includes("逐字摘自正文"));
  assert.ok(r.prompt.includes("s1") && r.prompt.includes("s4"));
  assert.ok(r.prompt.includes("不要为了凑数编问题"));
});

await cs.advance(ws, BOOK, "ch0001", 1, "dispatch_review");
await cs.recordFindings(ws, BOOK, "ch0001", 1, { covered: ["人物"], findings: [{ quote: "举火把的人", note: "没交代是谁" }] });

await t("改稿步骤把发现项逐条列出来，并带上细纲里的〔硬〕约束", async () => {
  const r = await call("forge_director_plan", {
    title: BOOK,
    context: {
      draftText: "旧稿",
      findings: [{ quote: "举火把的人", note: "没交代是谁", dimension: "情节与因果", severity: "s2" }],
      outlineBrief: "〔硬〕不写他在数什么。",
    },
  });
  assert.equal(r.role, "改稿子代理");
  assert.ok(r.prompt.includes("举火把的人"));
  assert.ok(r.prompt.includes("没交代是谁"));
  assert.ok(r.prompt.includes("整篇正文"), "改稿必须交整稿不是 diff");
  // 改稿者必须看得到〔硬〕，并且被告知〔硬〕优先于发现项。
  assert.ok(r.prompt.includes("〔硬〕不写他在数什么。"), "细纲必须进 prompt，否则改稿者没有否决发现项的依据");
  assert.ok(r.prompt.includes("细纲里的〔硬〕约束优先于发现项"), "必须明说〔硬〕优先，不能只把细纲摆在旁边");
});

await cs.advance(ws, BOOK, "ch0001", 1, "import_draft");
await cs.advance(ws, BOOK, "ch0001", 1, "dispatch_review");
await cs.recordFindings(ws, BOOK, "ch0001", 1, { covered: ["全量审读"], findings: [] });

await t("定稿是 stop 门禁：施工单照样被拒", async () => {
  const n = await call("forge_director_next", { title: BOOK });
  assert.equal(n.node, "chapter.settle");
  assert.equal(n.proceed, false);
  const p = await call("forge_director_plan", { title: BOOK, context: {} });
  assert.equal(p.ok, false);
  assert.equal(p.stage, "gate-stopped");
});

async function finishChapter(n) {
  const k = `ch${String(n).padStart(4, "0")}`;
  const rel = `定稿/卷01/${k}-正文.md`;
  const abs = path.join(bookBase, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `# 第 ${n} 章\n`, "utf8");
  await wh.commitPaths(ws, [`书仓/${BOOK}/${rel}`], `ch: ${k}`);
  await cs.advance(ws, BOOK, k, 1, "settle");
}

await t("第 1 章定稿入档，导演推进到第 2 章", async () => {
  await writeInBook("定稿/卷01/ch0001-雨夜.md", "# 第一章 雨夜\n");
  await wh.commitPaths(ws, [`书仓/${BOOK}/定稿/卷01/ch0001-雨夜.md`], "ch: ch0001 雨夜");
  await cs.advance(ws, BOOK, "ch0001", 1, "settle");
  const r = await call("forge_director_next", { title: BOOK });
  assert.equal(r.chapter, 2);
  assert.equal(r.proceed, true);
});

await t("整卷写完：有未清债先挡质量债闸门", async () => {
  await finishChapter(2);
  await g.recordFinding(ws, BOOK, { chapter: "ch0002", severity: "s4", quote: "他的心中充满了", note: "AI 味" });
  const r = await call("forge_director_next", { title: BOOK });
  assert.equal(r.node, "debt.settle");
  assert.equal(r.proceed, false);
  assert.ok(r.options.includes("明确豁免并记录理由"));
});

await t("豁免后指向整卷定稿，仍是人工闸门", async () => {
  const list = await g.listDebts(ws, BOOK, { status: "未处理" });
  for (const e of list.entries) await g.waiveDebt(ws, BOOK, e.id, "确认可接受");
  const r = await call("forge_director_next", { title: BOOK });
  assert.equal(r.node, "volume.settle");
  assert.equal(r.proceed, false);
  assert.equal(r.openDebts, 0);
});

await t("卷结算落盘并推进到下一章", async () => {
  const r = await call("forge_settle_volume", { title: BOOK, volume: 1, summary: "两章写完，沈昭终于开口。" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.commit);
  assert.match(r.nextStep, /design\.volume_layout/, "布局只写到第 2 章，卷结算后该停在布局缺口上");
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "vol: 卷01 结算");
});

await t("同一卷不能重复结算", async () => {
  const r = await call("forge_settle_volume", { title: BOOK, volume: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "already-settled");
});

await t("卷号非法被拒", async () => {
  const r = await call("forge_settle_volume", { title: BOOK, volume: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "bad-volume");
});

await t("布局没覆盖到第 3 章时停下来补布局", async () => {
  const r = await call("forge_director_next", { title: BOOK });
  assert.equal(r.chapter, 3);
  assert.equal(r.node, "design.volume_layout");
  assert.equal(r.proceed, false);
});

await t("补上布局后导演继续，并且可并行", async () => {
  await writeInBook("大纲/分卷布局.md", "## 第 1 卷（第 1–2 章）｜雨落\n## 第 2 卷（第 3–5 章）｜风起\n");
  const r = await call("forge_director_next", { title: BOOK });
  assert.equal(r.chapter, 3);
  assert.equal(r.volume, 2);
  assert.equal(r.proceed, true);
});

await t("不存在的书给出明确报错", async () => {
  const r = await call("forge_director_next", { title: "查无此书" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-book");
});

await fs.rm(path.join(projectRoot, "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.ok(true));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
