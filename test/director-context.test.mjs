/**
 * 施工单自动取材测试。
 *
 * 这一层的存在理由只有一个：导演链要真的自动。如果每一步都得调用方先把卷纲、
 * 契约、伏笔一段段粘进 context，那它就不是自动导演，是人工搬运；而且搬漏一段
 * 子代理会拿着「（调用方未提供）」写出看起来正常的废稿。
 *
 * 所以下面每一条都在问同一件事：**书仓里有的东西，它自己取到了吗。**
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as wh from "../lib/warehouse.js";
import { autoFillContext, givenOnly } from "../lib/director-context.js";
import { buildTaskSpec } from "../lib/director.js";
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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `dctx-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

console.log(`导演施工单 · 自动取材测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: {
    核心创意: "雨夜才能开口的剑客", 题材与目标读者: "玄幻", 核心看点: "沉默的代价",
    差异化方向: "写沟通", 主角核心欲望: "说完一句话", 主要冲突: "开口即暴露",
    "明确不要什么": "不要系统流",
  },
});

const bookBase = wh.bookPaths(ws, BOOK).base;
async function writeInBook(rel, content) {
  const abs = path.join(bookBase, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}
async function writeDraftArea(rel, content) {
  const abs = path.join(ws, "草稿", BOOK, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

const VOLUME_PLAN = "# 卷一规划\n\n卷末必须让沈昭说出第一个字。\n";
const CONTRACT = "# 作品契约\n\n红线：不许出现系统提示音。\n";
const LEDGER = "# 伏笔台账\n\n- 断剑：埋于序章，待收于第七章\n";
const OUTLINE = "# 第一章细纲\n\n〔硬〕他必须在雨里对仇人开口。\n";

await writeInBook("大纲/卷01/卷纲.md", VOLUME_PLAN);
await writeInBook("契约/作品契约.md", CONTRACT);
await writeInBook("卷账/伏笔台账.md", LEDGER);
await writeInBook("大纲/卷01/ch0001-细纲.md", OUTLINE);
await writeInBook("大纲/卷01/ch0002-细纲.md", "# 第二章细纲\n\n〔软〕他得学会闭嘴。\n");
await writeInBook("定稿/卷01/0001-开口.md", "雨下到第三日，他第一次张嘴。\n");
await writeInBook("设定/人物/沈昭.md", "# 沈昭\n\n只在雨天能说话。\n");

const act = (over = {}) => ({ kind: "chapter", step: "outline", chapter: 1, volume: 1, book: BOOK, ...over });

// ── 基本取材 ────────────────────────────────────────────────────────────
await t("细纲步骤：卷纲、契约、伏笔全部自己从真源取到", async () => {
  const ctx = await autoFillContext(ws, BOOK, act(), {});
  assert.match(ctx.volumePlan ?? "", /卷末必须让沈昭说出第一个字/, "卷纲没取到");
  assert.match(ctx.contract ?? "", /不许出现系统提示音/, "契约没取到");
  assert.match(ctx.foreshadow ?? "", /断剑/, "伏笔台账没取到");
});

await t("取到的是真源原文，不是硬编码——改了真源，取到的跟着变", async () => {
  const before = await autoFillContext(ws, BOOK, act(), {});
  await writeInBook("大纲/卷01/卷纲.md", "# 卷一规划\n\n改过了：卷末让沈昭闭嘴。\n");
  const after = await autoFillContext(ws, BOOK, act(), {});
  assert.match(before.volumePlan, /说出第一个字/);
  assert.match(after.volumePlan, /让沈昭闭嘴/);
  assert.notEqual(before.volumePlan, after.volumePlan);
  await writeInBook("大纲/卷01/卷纲.md", VOLUME_PLAN); // 复原，后面还要用
});

await t("第一章没有上一章，prevChapter 不塞——留给施工单去说「这是全书第一章」", async () => {
  const ctx = await autoFillContext(ws, BOOK, act({ chapter: 1 }), {});
  assert.equal(ctx.prevChapter, undefined);
  const spec = buildTaskSpec(act({ chapter: 1 }), ctx);
  assert.match(spec.prompt, /本章是全书第一章/);
});

await t("第二章有上一章，prevChapter 取到上一章定稿原文", async () => {
  const ctx = await autoFillContext(ws, BOOK, act({ chapter: 2 }), {});
  assert.match(ctx.prevChapter ?? "", /他第一次张嘴/);
});

// ── 调用方优先 ──────────────────────────────────────────────────────────
await t("调用方显式给的值优先，不被真源顶掉", async () => {
  const ctx = await autoFillContext(ws, BOOK, act(), { volumePlan: "调用方指定的卷纲", contract: "调用方指定的契约" });
  assert.equal(ctx.volumePlan, "调用方指定的卷纲");
  assert.equal(ctx.contract, "调用方指定的契约");
  assert.match(ctx.foreshadow, /断剑/, "没给的那段仍然要自己取");
});

await t("空串和纯空白不算「给过」——否则自动取材被顶掉，还是没内容", async () => {
  assert.deepEqual(givenOnly({ a: "", b: "   ", c: null, d: undefined, e: [], f: "有" }), { f: "有" });
  const ctx = await autoFillContext(ws, BOOK, act(), { contract: "   " });
  assert.match(ctx.contract, /不许出现系统提示音/);
});

// ── 起草任务包 ──────────────────────────────────────────────────────────
await t("起草步骤：taskText 自己组出来，且含本章细纲", async () => {
  await writeDraftArea("ch0001/状态.json", JSON.stringify({ schema: 1, chapter: "ch0001", volume: 1, stage: "细纲已确认", draftTask: { targetWords: 1234 }, draft: { version: 0 } }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "draft" }), {});
  assert.match(ctx.taskText ?? "", /起草任务/);
  assert.match(ctx.taskText, /他必须在雨里对仇人开口/, "任务包里没有细纲");
  assert.match(ctx.taskText, /约 1234 字/, "没照状态里的目标字数走");
});

// 下面几条都要「当前那一稿」在盘上，先写出来。
await writeDraftArea("ch0001/稿件/v1.md", "雨下了三天。\n他站在门口，没进去。\n");

await t("改稿步骤：上一轮的发现项自己从流程状态里取到（自动链就断在这一跳）", async () => {
  await writeDraftArea("ch0001/状态.json", JSON.stringify({
    schema: 1, chapter: "ch0001", volume: 1, stage: "待改",
    draft: { version: 1, latest: "稿件/v1.md" },
    // itemsRound 必须与 revisions 相等，才说明这份清单是**当前这一轮**的。
    // 不相等就是上一轮留下的，用了会让改稿者去修已经修过的地方。
    review: { revisions: 1, itemsRound: 1, findings: 1, items: [{ dimension: "人物", quote: "没进去", note: "太软" }] },
  }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "revise" }), {});
  assert.deepEqual(
    ctx.findings,
    [{ dimension: "人物", severity: null, quote: "没进去", note: "太软", id: null }],
    "改稿步骤拿不到上一轮的发现项，这一步就永远 missing-input，自动链退化成人工搬运",
  );
  const spec = buildTaskSpec(act({ step: "revise" }), ctx);
  assert.equal(spec.ok, true, spec.detail);
  assert.match(spec.prompt, /没进去/);
});

await t("过期的发现项不许进改稿——那是上一轮对着旧稿写的", async () => {
  // 真机上第 1 章就断在这儿：review.items 里是**两版之前**那一轮的 5 条
  // （引文来自 v7/v8），而这一轮审读把结论写进了台账。改稿者拿到旧清单，
  // 去修早就修过的地方。
  await writeDraftArea("ch0001/状态.json", JSON.stringify({
    schema: 1, chapter: "ch0001", volume: 1, stage: "待改",
    draft: { version: 1, latest: "稿件/v1.md" },
    review: { revisions: 9, itemsRound: 7, findings: 1, items: [{ dimension: "人物", quote: "旧稿里的话", note: "早就改掉了" }] },
  }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "revise" }), {});
  assert.equal(ctx.findings, undefined, "轮次对不上的清单必须丢掉");
  const spec = buildTaskSpec(act({ step: "revise" }), ctx);
  assert.equal(spec.ok, false);
  assert.equal(spec.stage, "missing-input");
});

await t("状态里没有发现项时，改稿步骤如实失败，不拿空数组硬跑", async () => {
  await writeDraftArea("ch0001/状态.json", JSON.stringify({
    schema: 1, chapter: "ch0001", volume: 1, stage: "待改", draft: { version: 1, latest: "稿件/v1.md" },
  }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "revise" }), {});
  assert.equal(ctx.findings, undefined);
  const spec = buildTaskSpec(act({ step: "revise" }), ctx);
  assert.equal(spec.ok, false);
  assert.equal(spec.stage, "missing-input");
});

await t("起草步骤：把目标字数一并交回调用方，且只算不写（干跑不动状态）", async () => {
  const statePath = path.join(ws, "草稿", BOOK, "ch0001/状态.json");
  await writeDraftArea("ch0001/状态.json", JSON.stringify({
    schema: 1, chapter: "ch0001", volume: 1, stage: "已备料", draft: { version: 0 },
  }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "draft" }), {});
  assert.equal(
    ctx.__draftTask?.targetWords, 3000,
    "没把目标字数交回调用方，导演就落不了库，导入时 checkChapterLength 拿不到 target —— 闸门静默失效",
  );
  const after = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(after.draftTask, undefined, "autoFillContext 是取材，不该写状态");
});

// ── 审读/改稿取当前稿 ────────────────────────────────────────────────────

await t("审读步骤：draftText 从流程状态里取当前那一稿", async () => {
  await writeDraftArea("ch0001/状态.json", JSON.stringify({ schema: 1, chapter: "ch0001", volume: 1, stage: "待审", draft: { version: 1, latest: "稿件/v1.md" } }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "review" }), {});
  assert.match(ctx.draftText ?? "", /他站在门口，没进去/);
});

await t("改稿步骤同样取到当前稿，并带上契约红线", async () => {
  const ctx = await autoFillContext(ws, BOOK, act({ step: "revise" }), { findings: [{ quote: "没进去", note: "太软" }] });
  assert.match(ctx.draftText ?? "", /没进去/);
  assert.match(ctx.contract ?? "", /不许出现系统提示音/);
  assert.deepEqual(ctx.findings, [{ quote: "没进去", note: "太软" }], "调用方给的发现项被弄丢了");
});

await t("状态里没有稿时，不编一份空的 draftText 出来", async () => {
  await writeDraftArea("ch0003/状态.json", JSON.stringify({ schema: 1, chapter: "ch0003", volume: 1, stage: "细纲已确认", draft: { version: 0 } }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "review", chapter: 3 }), {});
  assert.equal(ctx.draftText, undefined);
});

await t("状态指向的稿子被删了，也不塞空串冒充正文", async () => {
  await writeDraftArea("ch0004/状态.json", JSON.stringify({ schema: 1, chapter: "ch0004", volume: 1, stage: "待审", draft: { version: 1, latest: "稿件/v1.md" } }));
  const ctx = await autoFillContext(ws, BOOK, act({ step: "review", chapter: 4 }), {});
  assert.equal(ctx.draftText, undefined);
});

// ── 不该取材的步骤别乱塞 ────────────────────────────────────────────────
await t("纯工具步骤（备料）原样返回，不塞一堆材料", async () => {
  const ctx = await autoFillContext(ws, BOOK, act({ step: "materials" }), { keep: "我" });
  assert.deepEqual(ctx, { keep: "我" });
});

await t("非章节步骤（设计工件）原样返回", async () => {
  const ctx = await autoFillContext(ws, BOOK, { kind: "design", step: "skeleton", book: BOOK }, { keep: "我" });
  assert.deepEqual(ctx, { keep: "我" });
});

await t("没有书、没有真源时不抛异常，只是取不到", async () => {
  const ctx = await autoFillContext(ws, "这本书不存在", act({ chapter: 9 }), {});
  assert.equal(ctx.volumePlan, undefined);
  assert.equal(ctx.draftText, undefined);
});

await t("autoFillContext 不改调用方传进来的那个对象", async () => {
  const supplied = { outlineBrief: "本章目标" };
  const ctx = await autoFillContext(ws, BOOK, act(), supplied);
  assert.deepEqual(supplied, { outlineBrief: "本章目标" });
  assert.notEqual(ctx, supplied);
  assert.match(ctx.volumePlan, /说出第一个字/);
});

await t("施工单真的自包含了：细纲 prompt 里嵌着卷纲、契约、伏笔原文", async () => {
  const ctx = await autoFillContext(ws, BOOK, act(), {});
  const spec = buildTaskSpec(act(), ctx);
  assert.equal(spec.ok, true);
  assert.equal(spec.needsModel, true);
  assert.match(spec.prompt, /卷末必须让沈昭说出第一个字/);
  assert.match(spec.prompt, /不许出现系统提示音/);
  assert.match(spec.prompt, /断剑/);
  assert.doesNotMatch(spec.prompt, /调用方未提供/, "还有段落没取到");
});

// ── 细纲只给该给的人 ────────────────────────────────────────────────────
// 起草细纲的人不该先拿到细纲（那是他该提的方案）；改稿的人必须拿到，
// 否则发现项说要改、细纲说不能改，他手里没有能对照的那一半。
await t("改稿步骤自己取到本章细纲，并把它嵌进 prompt", async () => {
  const ctx = await autoFillContext(ws, BOOK, act({ step: "revise", chapter: 1 }), {
    draftText: "旧稿", findings: [{ quote: "x", note: "y" }],
  });
  assert.ok(typeof ctx.outlineBrief === "string" && ctx.outlineBrief.trim() !== "",
    "改稿步骤没取到细纲——它就只能照办发现项，撞了〔硬〕也不知道");
  const spec = buildTaskSpec(act({ step: "revise", chapter: 1 }), ctx);
  assert.equal(spec.ok, true);
  assert.match(spec.prompt, /本章细纲（含〔硬〕约束）/);
  assert.ok(spec.prompt.includes(ctx.outlineBrief), "细纲正文必须整段进 prompt");
  assert.doesNotMatch(spec.prompt, /调用方未提供细纲/);
});

await t("细纲起草步骤仍然拿不到细纲：那是他该提的方案", async () => {
  const ctx = await autoFillContext(ws, BOOK, act({ step: "outline" }), {});
  assert.equal(ctx.outlineBrief, undefined,
    "把细纲喂给起草细纲的人，等于替他先把本章目标定好");
});

await t("调用方明确给过细纲时不覆盖", async () => {
  const ctx = await autoFillContext(ws, BOOK, act({ step: "revise" }), {
    draftText: "旧稿", findings: [{ quote: "x", note: "y" }], outlineBrief: "我自己写的目标",
  });
  assert.equal(ctx.outlineBrief, "我自己写的目标");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}