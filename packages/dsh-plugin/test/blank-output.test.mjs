/**
 * 空白输出当失败。
 *
 * 审读子代理交白卷时，如果这一轮被当成成功，调用方就会拿着自报的 covered
 * 去凑一次「零发现项空审通过」——章节照样定稿，整卷照样出厂，
 * 而且日志上一片正常。这种失败比报错危险得多：它不报警。
 *
 * 这里把这条缝钉死：空串、全空白、null 一律算这一轮没跑成。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { directorTools } from "../lib/tools-director.js";
import { chapterTools } from "../lib/tools-chapter.js";
import { warehouseTools } from "../lib/tools-warehouse.js";
import { fanoutTools } from "../lib/tools-fanout.js";
import { fakeExec } from "./helpers/fake-parent.mjs";
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
const ws = path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox", `blank-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const logger = { info() {}, warn() {}, error() {} };

/** 按剧本交值的假引擎：nextValue 由每条用例自己摆好。 */
function engineReturning(values) {
  const queue = [...values];
  return {
    start(spec) {
      const value = queue.length > 1 ? queue.shift() : queue[0];
      return {
        id: "r",
        result: Promise.resolve({ stopReason: "completed", value, agentsStarted: 1 }),
        async dispose() {},
      };
    },
  };
}
function runWith(values) {
  const ctx = { logger, get: (n) => (n === "workflowEngine" ? engineReturning(values) : undefined) };
  const tools = directorTools(ctx, () => ws);
  const run = tools.find((d) => d.name === "forge_director_run");
  return defineTool(run).execute({ title: BOOK, context: { draftText: "沈昭张口。", volumePlan: "卷一：开口", contract: "不许虚构设定。" } }, fakeExec());
}

console.log(`阶段十 · 空白输出闸门测试\n沙盒: ${ws}\n`);

// 导演跑一轮之前要先有书（它会查书仓），所以先把一本空书建起来。
const BOOK = "空白试炼";
const baseCtx = { logger, get: () => undefined };
const setup = new Map([...warehouseTools(baseCtx, () => ws), ...chapterTools(baseCtx, () => ws)].map((d) => [d.name, defineTool(d)]));
const setupCall = (n, a) => setup.get(n).execute(a ?? {}, fakeExec());
assert.equal((await setupCall("forge_init_workspace", {})).ok, true);
assert.equal((await setupCall("forge_create_book", {
  title: BOOK, coreIdea: "x", genreAndAudience: "x", keyAppeal: "x", differentiation: "x",
  protagonistDesire: "x", mainConflict: "x", explicitlyAvoid: "x",
})).ok, true);

// 骨架是 stop 闸门，不确认就派不出去子代理。先把四件设计工件落真源。
const fanoutBase = new Map(fanoutTools(baseCtx, () => ws).map((d) => [d.name, defineTool(d)]));
const fanoutCall = (n, a) => fanoutBase.get(n).execute(a ?? {}, fakeExec());
for (const [artifact, body] of Object.entries({
  skeleton: "# 故事骨架\n\n## 第一部 追求\n要开口。\n\n## 索引\n\n- 人物 / 沈昭\n",
  worldbook: "## 人物｜沈昭\n\n剑客。\n",
  layout: "## 第 1 卷（第 1–3 章）｜雨落\n",
  "volume-plan": "## 卷一目标\n开口。\n",
})) {
  await fanoutCall("forge_artifact_candidate", { title: BOOK, artifact, body });
  await fanoutCall("forge_confirm_artifact", { title: BOOK, artifact });
}

await t("子代理交空串：这一轮算没跑成，不算成功", async () => {
  const r = await runWith([{ done: [""], failed: [] }]);
  assert.equal(r.ok, false, `空串不该算成功：${JSON.stringify(r)}`);
  assert.equal(r.stage, "empty-run", JSON.stringify(r));
  assert.equal(r.degraded, true);
  assert.deepEqual(r.done, []);
});

await t("全空白、只有空格与换行：同样算没跑成", async () => {
  for (const junk of ["   ", "\n\n\t ", "　　"]) {
    const r = await runWith([{ done: [junk], failed: [] }]);
    assert.equal(r.ok, false, `${JSON.stringify(junk)} 不该算成功`);
    assert.equal(r.stage, "empty-run", JSON.stringify(r));
  }
});

await t("null 与 undefined：算没跑成", async () => {
  for (const junk of [null, undefined]) {
    const r = await runWith([{ done: [junk], failed: [] }]);
    assert.equal(r.ok, false, `${String(junk)} 不该算成功`);
    assert.equal(r.stage, "empty-run", JSON.stringify(r));
  }
});

await t("真正有内容的照样放行，原文一字不改", async () => {
  const body = "  沈昭张口，声音比雨还轻。  ";
  const r = await runWith([{ done: [body], failed: [] }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.done, [body], "不该偷偷 trim 掉子代理的正文");
});

await t("并行档里一份空白一份有料：好的留下，空白的不算数", async () => {
  const r = await runWith([{ done: ["  ", "沈昭张口。"], failed: [] }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.done, ["沈昭张口。"], `应当只剩有料那一份，实际 ${JSON.stringify(r.done)}`);
});

await t("并行档里全是空白：整轮判没跑成", async () => {
  const r = await runWith([{ done: ["", "  "], failed: [] }]);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.stage, "empty-run", JSON.stringify(r));
});

// ── 端到端：白卷审读走不到「空审通过」那一步 ──
await t("端到端：审读交白卷时，这一章不会被零发现项放行", async () => {
  const ctx = { logger, get: (n) => (n === "workflowEngine" ? engineReturning([{ done: [""], failed: [] }]) : undefined) };
  const map = new Map(
    [...warehouseTools(ctx, () => ws), ...chapterTools(ctx, () => ws), ...fanoutTools(ctx, () => ws), ...directorTools(ctx, () => ws)]
      .map((d) => [d.name, defineTool(d)]),
  );
  const call = (n, a) => map.get(n).execute(a ?? {}, fakeExec());

  await call("forge_outline_draft", { title: BOOK, chapter: 1, volume: 1, body: outlineFixture({ constraints: ["〔硬〕沈昭必须开口。"] }) });
  await call("forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 });
  await call("forge_assemble_materials", { title: BOOK, chapter: 1, volume: 1 });
  await call("forge_import_draft", { title: BOOK, chapter: 1, body: "沈昭张口。", origin: "AI 起草" });
  await call("forge_dispatch_review", { title: BOOK, chapter: 1 });

  // 审读子代理交白卷
  const review = await call("forge_director_run", { title: BOOK, context: { draftText: "沈昭张口。", volumePlan: "卷一：开口", contract: "不许虚构设定。" } });
  assert.equal(review.ok, false, "白卷审读必须报错：" + JSON.stringify(review));
  assert.equal(review.stage, "empty-run", JSON.stringify(review));

  // 于是这一章仍停在审读中，没有被「零发现项」推到待定稿
  const st = await call("forge_book_status", { title: BOOK });
  assert.equal(st.status.finalizedChapterCount, 0, "没审过就定稿的章，一章都不该有");
  const n = await call("forge_director_next", { title: BOOK });
  assert.notEqual(n.node, "chapter.settle", `章仍没定稿，导演不该指向定稿，实际 ${n.node}`);
});

await fs.rm(ws, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}