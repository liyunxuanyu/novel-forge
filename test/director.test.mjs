/** 阶段五测试：自动导演的决策层。全程不调模型，所以能完全测试。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as d from "../lib/director.js";
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
const ws = path.join(projectRoot, ".test-sandbox", `dir-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

console.log(`阶段五 · 导演决策层测试\n沙盒: ${ws}\n`);

// ── 分卷布局解析 ─────────────────────────────────────────────────────────
await t("分卷布局：认「第 N 卷｜标题」", () => {
  const v = d.parseVolumeLayout("## 第一卷｜雨落\n\n## 第二卷｜风起\n");
  assert.deepEqual(v.map((x) => x.volume), [1, 2]);
  assert.deepEqual(v.map((x) => x.title), ["雨落", "风起"]);
});
await t("分卷布局：认「第 N 卷（第 X–Y 章）」", () => {
  const v = d.parseVolumeLayout("## 第 2 卷（第 21–40 章）｜风起\n");
  assert.equal(v[0].volume, 2);
  assert.equal(v[0].from, 21);
  assert.equal(v[0].to, 40);
  assert.equal(v[0].title, "风起");
});
await t("分卷布局：章节号写在标题里也能认", () => {
  const v = d.parseVolumeLayout("### 第 3 卷 第五章 起（第 41-60 章）\n");
  assert.equal(v[0].volume, 3);
  assert.equal(v[0].from, 41);
  assert.equal(v[0].to, 60);
});
await t("分卷布局：认不出就返回空，不瞎猜", () => {
  assert.deepEqual(d.parseVolumeLayout("随便一段文字，没有卷"), []);
  assert.deepEqual(d.parseVolumeLayout(""), []);
});
await t("章归卷：有范围就按范围", () => {
  const v = d.parseVolumeLayout("## 第 1 卷（第 1–10 章）｜甲\n## 第 2 卷（第 11–20 章）｜乙\n");
  assert.equal(d.volumeOfChapter(5, v), 1);
  assert.equal(d.volumeOfChapter(15, v), 2);
  assert.equal(d.volumeEnd(2, v), 20);
});
await t("章归卷：没范围就按每卷 20 章推", () => {
  assert.equal(d.volumeOfChapter(1, []), 1);
  assert.equal(d.volumeOfChapter(20, []), 1);
  assert.equal(d.volumeOfChapter(21, []), 2);
  assert.equal(d.volumeEnd(2, []), 40);
});

// ── 前置：建书铺真源 ─────────────────────────────────────────────────────
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

// ── 标准 1：状态从 Git 推导 ─────────────────────────────────────────────
await t("没有骨架时，导演指向 design.skeleton", async () => {
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.node, "design.skeleton");
  assert.equal(a.proceed, false, "骨架是 stop 级门禁，必须人工");
  assert.ok(a.gate.decisions.length > 0);
});

await t("有骨架没分卷时，指向 design.volume_layout", async () => {
  await writeInBook("大纲/故事骨架.md", "# 故事骨架\n\n- 起：雨夜初遇\n- 承：被迫开口\n");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.node, "design.volume_layout");
  assert.equal(a.proceed, false);
});

await t("骨架与布局齐了，才轮到开第一章", async () => {
  await writeInBook("大纲/分卷布局.md", "## 第 1 卷（第 1–3 章）｜雨落\n");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.node, "chapter.outline_confirm");
  assert.equal(a.step, "outline");
  assert.equal(a.chapter, 1);
  assert.equal(a.proceed, true, "章细纲是 auto 级，能无人值守");
  assert.equal(a.volume, 1);
});

// ── 标准 1b：完全确定性 ──────────────────────────────────────────────────
await t("同一状态推导两次结论完全一致", async () => {
  const a = await d.nextAction(ws, BOOK);
  const b = await d.nextAction(ws, BOOK);
  assert.equal(a.node, b.node);
  assert.equal(a.step, b.step);
  assert.equal(a.chapter, b.chapter);
  assert.equal(a.rule, b.rule);
});
await t("重载模块后推导结论不变（模拟会话重启）", async () => {
  const mod2 = await import(`../lib/director.js?cb=${Date.now()}`);
  const a = await d.nextAction(ws, BOOK);
  const b = await mod2.nextAction(ws, BOOK);
  assert.equal(a.node, b.node);
  assert.equal(a.step, b.step);
});

// ── 标准 1c：沿着章节阶梯一路推进 ───────────────────────────────────────
await t("细纲落了就该备料", async () => {
  await cs.advance(ws, BOOK, "ch0001", 1, "draft_outline");
  await cs.advance(ws, BOOK, "ch0001", 1, "confirm_outline");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.step, "materials");
  assert.equal(a.node, "chapter.materials");
  assert.equal(a.proceed, true);
});
await t("备料完了该起草", async () => {
  await cs.advance(ws, BOOK, "ch0001", 1, "assemble_materials");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.step, "draft");
  assert.equal(a.proceed, true);
});
await t("起草完了该审读", async () => {
  await cs.advance(ws, BOOK, "ch0001", 1, "build_draft_task");
  await cs.advance(ws, BOOK, "ch0001", 1, "import_draft");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.step, "review");
  assert.equal(a.proceed, true);
});
await t("审读有问题该改稿", async () => {
  await cs.advance(ws, BOOK, "ch0001", 1, "dispatch_review");
  await cs.recordFindings(ws, BOOK, "ch0001", 1, { covered: ["人物"], findings: [{ quote: "x", note: "人设跑了" }] });
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.step, "revise");
  assert.equal(a.proceed, true, "改稿是 auto 级，可以无人值守循环");
});
await t("审读通过后该定稿——但定稿是 stop 级门禁", async () => {
  await cs.advance(ws, BOOK, "ch0001", 1, "import_draft");
  await cs.advance(ws, BOOK, "ch0001", 1, "dispatch_review");
  await cs.recordFindings(ws, BOOK, "ch0001", 1, { covered: ["全量审读"], findings: [] });
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.step, "settle");
  assert.equal(a.node, "chapter.settle");
  assert.equal(a.proceed, false, "定稿必须作者拍板");
  assert.ok(a.gate.decisions[0].options.includes("定稿入档"));
});
await t("标准 3：撞上 stop 门禁时给出的是「问什么」，不是「做什么」", async () => {
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.proceed, false);
  assert.equal(a.gate.decisions.length > 0, true);
  assert.ok(a.gate.decisions[0].question.length > 0);
  assert.ok(a.gate.decisions[0].options.length >= 2);
  assert.match(a.reason, /作者拍板/);
});

// ── 定稿后进入下一章 ─────────────────────────────────────────────────────
await t("第一章定稿后，导演指向第二章的细纲", async () => {
  await writeInBook("定稿/卷01/ch0001-雨夜.md", "# 第一章 雨夜\n\n雨下到第四日。\n");
  await wh.commitPaths(ws, [`书仓/${BOOK}/定稿/卷01/ch0001-雨夜.md`], "ch: ch0001 雨夜");
  await cs.advance(ws, BOOK, "ch0001", 1, "settle");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.chapter, 2);
  assert.equal(a.step, "outline");
  assert.equal(a.proceed, true);
});

// ── 质量债拦住整卷定稿 ───────────────────────────────────────────────────
async function finishChapter(n) {
  const k = `ch${String(n).padStart(4, "0")}`;
  await cs.advance(ws, BOOK, k, 1, "draft_outline");
  await cs.advance(ws, BOOK, k, 1, "confirm_outline");
  await cs.advance(ws, BOOK, k, 1, "assemble_materials");
  await cs.advance(ws, BOOK, k, 1, "build_draft_task");
  await cs.advance(ws, BOOK, k, 1, "import_draft");
  await cs.advance(ws, BOOK, k, 1, "dispatch_review");
  await cs.recordFindings(ws, BOOK, k, 1, { covered: ["全量审读"], findings: [] });
  const rel = `定稿/卷01/${k}-正文.md`;
  const abs = path.join(bookBase, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `# 第 ${n} 章\n\n雨还在下。\n`, "utf8");
  await wh.commitPaths(ws, [`书仓/${BOOK}/${rel}`], `ch: ${k}`);
  await cs.advance(ws, BOOK, k, 1, "settle");
}

await t("布局是一到三章，所以写完三章才算本卷写完", async () => {
  const st = await d.deriveState(ws, BOOK);
  assert.equal(st.volumes[0].from, 1);
  assert.equal(st.volumes[0].to, 3);
  await finishChapter(2);
  let a = await d.nextAction(ws, BOOK);
  assert.notEqual(a.node, "volume.settle", "只写完两章不该算整卷写完");
  await finishChapter(3);
  a = await d.nextAction(ws, BOOK);
  assert.equal(a.rule, "volume-settle", `实际 ${a.rule}/${a.node}`);
});

await t("本卷写完但有未清债时，先挡在质量债闸门", async () => {
  await g.recordFinding(ws, BOOK, { chapter: "ch0003", severity: "s3", quote: "他抬头", note: "动作重复" });
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.node, "debt.settle", `实际 ${a.node}/${a.rule}`);
  assert.equal(a.proceed, false);
  assert.ok(a.gate.decisions[0].options.includes("明确豁免并记录理由"));
});

await t("债清空后指向整卷定稿（仍是 stop 级）", async () => {
  const list = await g.listDebts(ws, BOOK, { status: "未处理" });
  for (const e of list.entries) await g.waiveDebt(ws, BOOK, e.id, "确认可接受");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.node, "volume.settle");
  assert.equal(a.kind, "volume");
  assert.equal(a.proceed, false);
  assert.ok(a.gate.decisions[0].options.includes("先处理质量债"));
});

await t("没结算这一卷时，导演会一直提请整卷定稿（不会自己跳过）", async () => {
  for (let i = 0; i < 2; i++) {
    const a = await d.nextAction(ws, BOOK);
    assert.equal(a.node, "volume.settle", `第 ${i + 1} 次推导不该跳过卷结算`);
  }
});

await t("结算卷一：落真源 + vol: 提交", async () => {
  const r = await d.markVolumeSettled(ws, BOOK, 1, "本卷三章全部定稿。");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(existsSync(d.volumeSettlePath(ws, BOOK, 1)));
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "vol: 卷01 结算");
});
await t("同一卷不能重复结算", async () => {
  const r = await d.markVolumeSettled(ws, BOOK, 1);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "already-settled");
});

await t("布局没覆盖到下一章时停下来补布局，不瞎猜卷号", async () => {
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.chapter, 4);
  assert.equal(a.volume, null, "第 4 章不在布局范围内，卷号应当是 null 而不是猜一个");
  assert.equal(a.node, "design.volume_layout");
  assert.equal(a.rule, "layout-gap");
  assert.equal(a.proceed, false);
});

await t("布局补上第 4 章之后，导演继续往下走", async () => {
  await writeInBook("大纲/分卷布局.md", "## 第 1 卷（第 1–3 章）｜雨落\n## 第 2 卷（第 4–6 章）｜风起\n");
  const a = await d.nextAction(ws, BOOK);
  assert.equal(a.volume, 2);
  assert.equal(a.step, "outline");
  assert.equal(a.proceed, true);
});

// ── 标准 2：fan-out ──────────────────────────────────────────────────────
await t("细纲阶段可以 fan-out：后续步骤无依赖，能一起排上", () => {
  const plan = d.parallelPlan({ kind: "chapter", step: "outline", node: "chapter.outline_confirm" });
  assert.equal(plan.canFanOut, true);
  assert.deepEqual(plan.steps, ["outline", "materials", "draft", "review"]);
});
await t("定稿阶段不能 fan-out：下一步有强依赖", () => {
  const plan = d.parallelPlan({ kind: "chapter", step: "settle", node: "chapter.settle" });
  assert.equal(plan.canFanOut, false);
  assert.deepEqual(plan.steps, ["settle"]);
});
await t("设计阶段可以 fan-out", () => {
  assert.equal(d.parallelPlan({ kind: "design", node: "design.skeleton" }).canFanOut, true);
});

// ── 降级 ─────────────────────────────────────────────────────────────────
await t("不存在的书给出明确报错，不是空动作", async () => {
  const a = await d.nextAction(ws, "没有这本书");
  assert.equal(a.ok, false);
  assert.equal(a.stage, "no-book");
});

await fs.rm(path.join(projectRoot, ".test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, ".test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
