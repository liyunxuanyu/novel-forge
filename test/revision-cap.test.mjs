/**
 * 改稿轮次上限。
 *
 * 这是「无人值守」真正会被绊倒的地方：技能手册写着「最多三轮」，但约定挡不住
 * 真模型。一个每轮都能挑出新毛病的稿子，会把自动链拖成死循环 —— 而死循环
 * 本身就是需要人工救火。这里把上限做进导演：到顶就停，且必须给出作者能答的话。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { chapterTools } from "../lib/tools-chapter.js";
import { warehouseTools } from "../lib/tools-warehouse.js";
import { directorTools } from "../lib/tools-director.js";
import { gateTools } from "../lib/tools-gates.js";
import { fanoutTools } from "../lib/tools-fanout.js";
import { MAX_REVISION_ROUNDS } from "../lib/chapter-state.js";
import { DEFAULT_POLICY } from "../lib/gates.js";
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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `cap-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "上限试炼";
const logger = { info() {}, warn() {}, error() {} };
const ctx = { logger, get: () => undefined };
const byName = new Map(
  [...warehouseTools(ctx, () => ws), ...chapterTools(ctx, () => ws), ...directorTools(ctx, () => ws), ...gateTools(ctx, () => ws), ...fanoutTools(ctx, () => ws)]
    .map((d) => [d.name, defineTool(d)]),
);
const call = (n, a) => byName.get(n).execute(a ?? {}, { signal: new AbortController().signal });
const next = () => call("forge_director_next", { title: BOOK });

console.log(`阶段十 · 改稿轮次上限测试（上限 ${MAX_REVISION_ROUNDS} 轮）\n沙盒: ${ws}\n`);

assert.equal((await call("forge_init_workspace", {})).ok, true);
assert.equal((await call("forge_create_book", {
  title: BOOK,
  coreIdea: "x", genreAndAudience: "x", keyAppeal: "x", differentiation: "x",
  protagonistDesire: "x", mainConflict: "x", explicitlyAvoid: "x",
})).ok, true);
for (const [artifact, body] of Object.entries({
  skeleton: "# 故事骨架\n\n## 第一部 追求\n要开口。\n\n## 索引\n\n- 人物 / 沈昭\n",
  worldbook: "## 人物｜沈昭\n\n剑客。\n",
  layout: "## 第 1 卷（第 1–3 章）｜雨落\n",
  "volume-plan": "## 卷一目标\n开口。\n",
})) {
  await call("forge_artifact_candidate", { title: BOOK, artifact, body });
  await call("forge_confirm_artifact", { title: BOOK, artifact });
}

/** 走完一轮「派审读 → 回写一条发现项」，把章留在待改。 */
async function oneBadRound(body, note, chapter = 1) {
  const imp = await call("forge_import_draft", { title: BOOK, chapter, body, origin: "改稿" });
  assert.equal(imp.ok, true, JSON.stringify(imp));
  const disp = await call("forge_dispatch_review", { title: BOOK, chapter });
  assert.equal(disp.ok, true, JSON.stringify(disp));
  const rec = await call("forge_record_findings", {
    title: BOOK, chapter, covered: ["结构"],
    findings: [{ quote: body.slice(0, 4), note }],
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.passed, false, "这一轮必须真的没通过");
  return disp.revisions;
}

await t("上限就是 3 轮，且是模块常量不是散落的魔数", async () => {
  assert.equal(MAX_REVISION_ROUNDS, 3);
});

await t("新节点在默认策略里是 stop", async () => {
  assert.equal(DEFAULT_POLICY.nodes["chapter.revise_exhausted"], "stop");
});

await t("未派审读（起草中）不受上限影响", async () => {
  await call("forge_outline_draft", { title: BOOK, chapter: 1, volume: 1, body: outlineFixture({ constraints: ["〔硬〕沈昭必须开口。"] }) });
  await call("forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 });
  await call("forge_assemble_materials", { title: BOOK, chapter: 1, volume: 1 });
  await call("forge_import_draft", { title: BOOK, chapter: 1, body: "第一版。", origin: "AI 起草" });
  const n = await next();
  assert.equal(n.node, "chapter.review", JSON.stringify(n));
  assert.equal(n.proceed, true, "第一轮审读不该被上限挡住");
});

let rounds = 0;
await t("改到上限以内：仍然是自动放行，不多问一句", async () => {
  rounds = await oneBadRound("第一版。", "太平");
  assert.equal(rounds, 1);
  const n = await next();
  assert.equal(n.node, "chapter.revise", JSON.stringify(n));
  assert.equal(n.proceed, true, "还有余量就继续自动改");

  rounds = await oneBadRound("第二版，还是太平。", "还是太平");
  assert.equal(rounds, 2);
  const n2 = await next();
  assert.equal(n2.node, "chapter.revise", JSON.stringify(n2));
  assert.equal(n2.proceed, true);
});

await t(`改满 ${MAX_REVISION_ROUNDS} 轮：停下来问作者，不再自动派第 4 轮`, async () => {
  rounds = await oneBadRound("第三版，依旧。", "依旧");
  assert.equal(rounds, MAX_REVISION_ROUNDS);
  const n = await next();
  assert.equal(n.node, "chapter.revise_exhausted", `实际 ${n.node}（rule=${n.rule}）`);
  assert.equal(n.proceed, false, "到顶必须停，不能再自动改第四轮");
  assert.ok(n.question && n.question.length > 0, "停下来必须给出作者能答的话");
  assert.ok(Array.isArray(n.options) && n.options.length >= 2, `要有可选项，实际 ${JSON.stringify(n.options)}`);
});

await t("到顶后连派子代理都会被挡：施工单这条路也堵死", async () => {
  const run = await call("forge_director_run", { title: BOOK, context: { draftText: "第三版，依旧。" } });
  assert.equal(run.ok, false, "stop 闸门上不该再派子代理");
  assert.match(String(run.detail ?? ""), /stop|问作者/);
  const chk = await call("forge_gate_check", { title: BOOK, node: "chapter.revise_exhausted" });
  assert.notEqual(chk.proceed, true, `到顶节点的闸门检查不得放行：${JSON.stringify(chk)}`);
});

await t("到顶不会卡死：作者放行后本章能定稿，导演继续往下", async () => {
  // 作者选择「带现状定稿」：先导一版定稿稿（待改 → 待审），再走一轮零发现项
  const imp = await call("forge_import_draft", { title: BOOK, chapter: 1, body: "作者拍板的定稿稿。", origin: "作者手改" });
  assert.equal(imp.ok, true, JSON.stringify(imp));
  const disp = await call("forge_dispatch_review", { title: BOOK, chapter: 1 });
  assert.equal(disp.ok, true, "作者拍板后仍可回到正常审读：" + JSON.stringify(disp));
  const rec = await call("forge_record_findings", {
    title: BOOK, chapter: 1, covered: ["结构", "文风"], findings: [],
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const n = await next();
  assert.equal(n.node, "chapter.settle", `实际 ${n.node}`);
  const st = await call("forge_settle_chapter", { title: BOOK, chapter: 1, chapterTitle: "第1章", body: "第三版，依旧。" });
  assert.equal(st.ok, true, JSON.stringify(st));
  const after = await next();
  assert.notEqual(after.node, "chapter.revise_exhausted", "定稿后不该再卡在上限闸门");
  assert.equal(after.chapter, 2, "导演应当指向第 2 章");
});

await t("上限只对到顶的那一章生效，下一章从头自动改", async () => {
  const n = await next();
  assert.equal(n.node, "chapter.outline_confirm", JSON.stringify(n));
  await call("forge_outline_draft", { title: BOOK, chapter: 2, volume: 1, body: outlineFixture({ constraints: ["〔硬〕沈昭必须开口。"] }) });
  await call("forge_confirm_outline", { title: BOOK, chapter: 2, volume: 1 });
  await call("forge_assemble_materials", { title: BOOK, chapter: 2, volume: 1 });
  await call("forge_import_draft", { title: BOOK, chapter: 2, body: "第二章初稿。", origin: "AI 起草" });
  const d2 = await call("forge_dispatch_review", { title: BOOK, chapter: 2 });
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.equal(d2.revisions, 1, `新一轮要从 1 数起，不是接着上一章的轮次（实际 ${d2.revisions}）`);
});

// ── 作者答复要能执行 ────────────────────────────────────────────────────
// 闸门以前只会停：给三个选项，作者挑一个，然后没有任何东西记下这个选择，
// 导演下一次问还是同一句。作者选「再改一轮」，链条照样死在原地——
// 一个能问却不能执行答复的闸门，把「无人值守」变成「每章改配置」。
await t("写错的选项被拒，不会静默什么都不做", async () => {
  const bad = await call("forge_gate_decide", {
    title: BOOK, chapter: 2, node: "chapter.revise_exhausted", choice: "再改三轮吧",
  });
  assert.equal(bad.ok, false, `乱写的选项不该被接受：${JSON.stringify(bad)}`);
  assert.equal(bad.stage, "unknown-choice");
  assert.match(String(bad.detail ?? ""), /再改一轮并放宽标准/, "拒绝时要把合法选项列出来");
});

await t("把第 2 章也推到上限：闸门同样会停", async () => {
  // 上面那条测试把第 2 章留在了「审读中」（派了审读、还没回写），先落地这一轮。
  const seed = await call("forge_record_findings", {
    title: BOOK, chapter: 2, covered: ["结构"],
    findings: [{ quote: "第二章初稿。", note: "初稿太平" }],
  });
  assert.equal(seed.ok, true, JSON.stringify(seed));
  await oneBadRound("第二章第二版。", "还是太平", 2);
  await oneBadRound("第二章第三版。", "依旧", 2);
  const n = await next();
  assert.equal(n.node, "chapter.revise_exhausted", `实际 ${n.node}（rule=${n.rule}）`);
  assert.equal(n.proceed, false);
});

await t("作者选「再改一轮并放宽标准」：导演重新放行改稿，而不是继续卡着", async () => {
  const dec = await call("forge_gate_decide", {
    title: BOOK, chapter: 2, node: "chapter.revise_exhausted",
    choice: "再改一轮并放宽标准", note: "作者看过：剩下的都是措辞，值得再走一轮。",
  });
  assert.equal(dec.ok, true, JSON.stringify(dec));
  assert.equal(dec.grantedExtraRounds, 1, "这一项应当放开 1 轮");
  assert.equal(dec.reviseWaiver, 1);
  assert.equal(dec.stage, "待改", "答复不改阶段");

  const n = await next();
  assert.equal(n.node, "chapter.revise", `作者放行后应当重新派改稿，实际 ${n.node}（rule=${n.rule}）`);
  assert.equal(n.proceed, true);
});

await t("放开的是轮数不是闸门：这一轮改完再到顶，还会再问一次", async () => {
  await oneBadRound("第二章第四版。", "第四轮还是不行", 2);
  const n = await next();
  assert.equal(n.node, "chapter.revise_exhausted", `放开 1 轮之后应当重新到顶，实际 ${n.node}（rule=${n.rule}）`);
  assert.equal(n.proceed, false, "不能一路自动改下去");
});

await t("答复落进真源：状态里有作者的选择原文", async () => {
  const st = await call("forge_chapter_status", { title: BOOK, chapter: 2 });
  assert.equal(st.ok, true, JSON.stringify(st));
  const raw = JSON.parse(await fs.readFile(path.join(ws, "草稿", BOOK, "ch0002", "状态.json"), "utf8"));
  assert.equal(raw.gateDecision.node, "chapter.revise_exhausted");
  assert.equal(raw.gateDecision.choice, "再改一轮并放宽标准");
  assert.match(String(raw.gateDecision.note ?? ""), /剩下的都是措辞/);
  assert.equal(raw.reviseWaiver.extraRounds, 1);
  assert.equal(raw.reviseWaiver.standard, "放宽");
});

await fs.rm(ws, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}