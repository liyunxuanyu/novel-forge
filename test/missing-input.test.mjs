/**
 * 输入侧闸门：拿不到真源内容就不许派子代理。
 *
 * 上一轮堵的是输出侧（子代理交白卷）。这一侧当时是敞的：
 * context 缺字段时 prompt 里写的是「（调用方未提供正文）」，然后照发不误。
 *
 * 后果不是报错，是安静地交差：
 *   · 审读步骤拿不到正文 → 子代理回一句「没问题」→ 空审通过 → 章节出厂
 *   · 改稿步骤拿不到发现项 → 自由发挥一版 → 没人发现
 *   · 起草步骤拿不到任务包 → 凭空捏一章
 * 三条路的共同点：日志上一片正常，书仓里多了一卷没人真读过的字。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildTaskSpec, STEP_SPECS } from "../lib/director.js";
import { warehouseTools } from "../lib/tools-warehouse.js";
import { fanoutTools } from "../lib/tools-fanout.js";
import { chapterTools } from "../lib/tools-chapter.js";
import { directorTools } from "../lib/tools-director.js";
import { fakeExec } from "./helpers/fake-parent.mjs";

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
const sandboxParent = path.join(projectRoot, "..", ".forge-test-sandbox");
await fs.mkdir(sandboxParent, { recursive: true });
const ws = path.join(sandboxParent, `in-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "输入闸门";

let dispatched = 0;
const engine = {
  calls: [],
  start({ script }) {
    dispatched++;
    engine.calls.push(script);
    const value = { done: ["子代理随便回一句"], failed: [] };
    return { id: `r${dispatched}`, result: Promise.resolve({ stopReason: "completed", value, agentsStarted: 1 }), cancel() {}, dispose() {} };
  },
};
const logger = { info() {}, warn() {}, error() {} };
const ctx = { logger, get: (n) => (n === "workflowEngine" ? engine : undefined) };
const map = new Map(
  [...warehouseTools(ctx, () => ws), ...fanoutTools(ctx, () => ws), ...chapterTools(ctx, () => ws), ...directorTools(ctx, () => ws)]
    .map((d) => [d.name, defineTool(d)]),
);
const call = (n, a) => map.get(n).execute(a ?? {}, fakeExec());

console.log(`阶段十 · 输入侧闸门测试\n沙盒: ${ws}\n`);

// ── 纯函数层：buildTaskSpec 是唯一收口处 ─────────────────────────────────
const ACT = { book: BOOK, chapter: 3, volume: 1, node: "chapter.review", kind: "chapter" };
const FULL = {
  outlineBrief: "沈昭在雨里第一次开口。",
  volumePlan: "卷一：开口。",
  prevChapter: "雨下了三天。",
  contract: "不许凭空虚构设定。",
  foreshadow: "（无）",
  taskText: "材料包全文",
  draftText: "沈昭张口。",
  findings: [{ quote: "沈昭张口。", note: "节奏偏慢" }],
  dimensions: ["节奏"],
};

await t("四类步骤各自声明了必需输入", async () => {
  assert.deepEqual(STEP_SPECS.outline.requires, ["volumePlan", "contract"]);
  assert.deepEqual(STEP_SPECS.draft.requires, ["taskText"]);
  assert.deepEqual(STEP_SPECS.review.requires, ["draftText"]);
  assert.deepEqual(STEP_SPECS.revise.requires, ["draftText", "findings"]);
});

await t("纯工具步骤不声明输入：materials / settle 缺啥都放行", async () => {
  for (const step of ["materials", "settle"]) {
    const r = buildTaskSpec({ ...ACT, step });
    assert.equal(r.ok, true, step);
    assert.equal(r.needsModel, false, step);
  }
});

await t("输入齐了：放行，且 prompt 真的带上了正文", async () => {
  const r = buildTaskSpec({ ...ACT, step: "review" }, FULL);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.prompt, /沈昭张口。/);
  assert.equal(r.role, "审读子代理");
});

await t("审读缺正文：直接拒，且不产出任何 prompt", async () => {
  const { draftText, ...rest } = FULL;
  const r = buildTaskSpec({ ...ACT, step: "review" }, rest);
  assert.equal(r.ok, false, "没正文就派审读，等于让子代理凭空说没问题");
  assert.equal(r.stage, "missing-input", JSON.stringify(r));
  assert.match(r.detail, /draftText/);
  assert.equal(r.prompt, undefined, "拒了就不该再拼一份带占位符的 prompt 出去");
});

await t("起草缺任务包：拒", async () => {
  const r = buildTaskSpec({ ...ACT, step: "draft" }, { ...FULL, taskText: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "missing-input");
  assert.match(r.detail, /taskText/);
});

await t("细纲缺卷纲或契约：拒", async () => {
  for (const k of ["volumePlan", "contract"]) {
    const r = buildTaskSpec({ ...ACT, step: "outline" }, { ...FULL, [k]: undefined });
    assert.equal(r.ok, false, k);
    assert.match(r.detail, new RegExp(k), k);
  }
});

await t("改稿缺发现项：空数组也算缺", async () => {
  for (const v of [[], undefined, null]) {
    const r = buildTaskSpec({ ...ACT, step: "revise" }, { ...FULL, findings: v });
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.match(r.detail, /findings/);
  }
});

await t("只有空格的字符串算缺，不是漏", async () => {
  const r = buildTaskSpec({ ...ACT, step: "review" }, { ...FULL, draftText: "   \n  " });
  assert.equal(r.ok, false, "一段空白不等于正文");
  assert.match(r.detail, /draftText/);
});

await t("缺好几个时一次全点名，不挤牙膏", async () => {
  const r = buildTaskSpec({ ...ACT, step: "revise" }, {});
  assert.equal(r.ok, false);
  assert.match(r.detail, /draftText、findings/);
});

await t("本章目标仍可省：细纲起草者是提方案的人，不该替它把活先干了", async () => {
  const { outlineBrief, prevChapter, ...rest } = FULL;
  const r = buildTaskSpec({ ...ACT, step: "outline" }, rest);
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ── 真导演路径：闸门拦得住吗 ─────────────────────────────────────────────
await call("forge_init_workspace", {});
await call("forge_create_book", {
  title: BOOK, coreIdea: "x", genreAndAudience: "x", keyAppeal: "x", differentiation: "x",
  protagonistDesire: "x", mainConflict: "x", explicitlyAvoid: "x",
});
for (const [artifact, body] of Object.entries({
  skeleton: "# 故事骨架\n\n## 第一部 追求\n要开口。\n\n## 索引\n\n- 人物 / 沈昭\n",
  worldbook: "## 人物｜沈昭\n\n剑客。\n",
  layout: "## 第 1 卷（第 1–1 章）｜雨落\n",
  "volume-plan": "## 卷一目标\n开口。\n",
})) {
  await call("forge_artifact_candidate", { title: BOOK, artifact, body });
  await call("forge_confirm_artifact", { title: BOOK, artifact });
}
await call("forge_outline_draft", { title: BOOK, chapter: 1, volume: 1, body: "〔硬〕沈昭必须开口。\n" });
await call("forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 });
await call("forge_assemble_materials", { title: BOOK, chapter: 1, volume: 1 });
await call("forge_draft_task", { title: BOOK, chapter: 1, volume: 1, targetWords: 2000 });
await call("forge_import_draft", { title: BOOK, chapter: 1, body: "沈昭张口。" });
await call("forge_dispatch_review", { title: BOOK, chapter: 1 });

await t("端到端：正文在草稿区时，导演自己取得到，不必调用方手喂", async () => {
  const next = await call("forge_director_next", { title: BOOK });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.node, "chapter.review", `导演应当停在审读，实际 ${next.node}`);

  // 正文就在草稿区躺着（上面 import 过），而且流程状态里记着它在哪。
  // 要求调用方再复制一遍，等于把「自动导演」降级成「人工搬运」，
  // 而且搬漏一次子代理就会拿着「（调用方未提供）」去审一篇不存在的稿子。
  dispatched = 0;
  const ok = await call("forge_director_run", { title: BOOK, context: { dimensions: ["节奏"] } });
  assert.equal(ok.ok, true, "正文就在草稿区，导演该自己取到：" + JSON.stringify(ok));
  assert.equal(dispatched, 1, "取到正文后应当真的派出子代理");
});

await t("端到端：正文其实读不到时，这一轮根本派不出去", async () => {
  // 状态还指着那一稿，但文件已经不在了。这时必须拦住：
  // 拿一份空正文去审，审读子代理会煞有介事地审一篇不存在的稿子。
  const draftFile = path.join(ws, "草稿", BOOK, "ch0001", "稿件", "v1.md");
  assert.equal(existsSync(draftFile), true, "前置条件：这一稿本来在");
  await fs.rm(draftFile);

  dispatched = 0;
  const r = await call("forge_director_run", { title: BOOK, context: { dimensions: ["节奏"] } });
  assert.equal(r.ok, false, "正文读不到却派出去了：" + JSON.stringify(r));
  assert.equal(r.stage, "missing-input", JSON.stringify(r));
  assert.equal(dispatched, 0, `一个子代理都不该启动，实际启动了 ${dispatched} 个`);
});

await t("同一轮补上正文就派得出去：闸门不是死路", async () => {
  dispatched = 0;
  const r = await call("forge_director_run", { title: BOOK, context: { draftText: "沈昭张口，声音比雨还轻。" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(dispatched, 1, "闸门放行后应当真的派出子代理");
});

await t("被拦住的那一章仍然停在审读中，不会自己往前爬", async () => {
  const st = await call("forge_chapter_status", { title: BOOK, chapter: 1 });
  assert.equal(st.chapters[0].stage, "审读中", st.chapters[0].stage);
});

await fs.rm(ws, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
