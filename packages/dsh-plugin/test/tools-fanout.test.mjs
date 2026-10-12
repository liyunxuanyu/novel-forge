/** 阶段六测试：fan-out 工具层。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { fanoutTools } from "../lib/tools-fanout.js";
import * as wh from "../lib/warehouse.js";
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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `ftool-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

/** 假引擎：按 jobs 逐个决定成败，用来验证「一件失败不影响其余」。 */
function makeCtx(engineFactory) {
  const engine = engineFactory();
  return {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === "workflowEngine" ? engine : undefined),
    __engine: engine,
  };
}
function byName(ctx) {
  const m = new Map();
  for (const def of fanoutTools(ctx, () => ws)) m.set(def.name, defineTool(def));
  return m;
}
const callOf = (m, n, a) => m.get(n).execute(a ?? {}, fakeExec());

console.log(`阶段六 · fan-out 工具层测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: { 核心创意: "雨夜才能开口的剑客", 题材与目标读者: "玄幻", 核心看点: "沉默的代价", 差异化方向: "写沟通", 主角核心欲望: "说完一句话", 主要冲突: "开口即暴露", "明确不要什么": "不要系统流" },
});
const bookBase = wh.bookPaths(ws, BOOK).base;

const okEngine = (behavior) => ({ __behavior: behavior, start(spec) {
  return { id: "r1", result: Promise.resolve({ stopReason: "completed", value: behavior(spec.args.jobs) }), async dispose() {} };
} });

// ── 标准 1：计划与并行 ───────────────────────────────────────────────────
const ctxOk = makeCtx(() => okEngine((jobs) => ({ done: jobs.map((j) => ({ id: j.id, ok: true, text: `产出-${j.id}` })), failed: [] })));
const M = byName(ctxOk);
const call = (n, a) => callOf(M, n, a);

await t("计划给出三轮依赖，且第一轮只有骨架", async () => {
  const r = await call("forge_fanout_plan", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.rounds, [["skeleton"], ["layout", "worldbook"], ["volume-plan"]]);
  assert.deepEqual(r.ready.map((x) => x.id), ["skeleton"]);
  assert.equal(r.allDone, false);
  const text = M.get("forge_fanout_plan").output.render({}, r)[0].text;
  assert.match(text, /可派：故事骨架/);
  assert.match(text, /卡着：首卷规划/);
});

await t("并行派发：一次派出去多件，产出带回工件身份", async () => {
  const r = await call("forge_fanout_run", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.dispatched, ["skeleton"]);
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].id, "skeleton");
  assert.equal(r.done[0].text, "产出-skeleton");
  assert.equal(r.degraded, false);
});

await t("骨架与布局那一轮能并行派出两件", async () => {
  await call("forge_artifact_candidate", { title: BOOK, artifact: "skeleton", body: "# 骨架\n\n## 索引\n- 人物 / 沈昭\n" });
  await call("forge_confirm_artifact", { title: BOOK, artifact: "skeleton" });

  const seen = [];
  const ctx2 = makeCtx(() => ({ start(spec) {
    seen.push(...spec.args.jobs.map((j) => j.id));
    return { id: "r2", result: Promise.resolve({ stopReason: "completed", value: { done: spec.args.jobs.map((j) => ({ id: j.id, ok: true, text: `${j.id}-正文` })), failed: [] } }), async dispose() {} };
  } }));
  const M2 = byName(ctx2);
  const r = await callOf(M2, "forge_fanout_run", { title: BOOK });
  assert.deepEqual(seen.sort(), ["layout", "worldbook"], "同一层的两件应当同一次并行派出");
  assert.equal(r.done.length, 2);
});

// ── 标准 2：一件失败不影响其余 ───────────────────────────────────────────
await t("标准 2：布局失败、世界书成功 —— 成功的那件照常交回", async () => {
  const ctx3 = makeCtx(() => okEngine((jobs) => ({
    done: jobs.filter((j) => j.id === "worldbook").map((j) => ({ id: j.id, ok: true, text: "世界书正文" })),
    failed: [{ id: "layout", ok: false, reason: "上下文超长" }],
  })));
  const r = await callOf(byName(ctx3), "forge_fanout_run", { title: BOOK });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.deepEqual(r.done.map((d) => d.id), ["worldbook"]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, "layout");
  assert.match(r.detail, /上下文超长/);
});

await t("全部失败时明确报错，不假装成功", async () => {
  const ctx4 = makeCtx(() => okEngine((jobs) => ({ done: [], failed: jobs.map((j) => ({ id: j.id, ok: false, reason: "配额用尽" })) })));
  const r = await callOf(byName(ctx4), "forge_fanout_run", { title: BOOK });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "all-failed");
  assert.match(r.detail, /配额用尽/);
});

await t("宿主没有引擎时给出可读说明", async () => {
  const ctx5 = { logger: { info() {} }, get: () => undefined };
  const r = await callOf(byName(ctx5), "forge_fanout_run", { title: BOOK });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-engine");
  assert.match(r.detail, /workflowEngine/);
});

// ── 标准 4/5：候选与真源 ─────────────────────────────────────────────────
await t("落候选：真源一个字都没动", async () => {
  const r = await call("forge_artifact_candidate", { title: BOOK, artifact: "layout", body: "## 第 1 卷（第 1–20 章）｜雨落\n" });
  assert.equal(r.ok, true);
  assert.equal(existsSync(path.join(bookBase, "大纲", "分卷布局.md")), false, "候选不该直接进真源");
  assert.ok(existsSync(path.join(ws, "草稿", BOOK, "候选", "layout.md")));
});

await t("确认时省略正文就取候选", async () => {
  const r = await call("forge_confirm_artifact", { title: BOOK, artifact: "layout" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(existsSync(path.join(bookBase, "大纲", "分卷布局.md")));
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "design: 确认分卷布局");
});

await t("没有候选也没给正文时报错，不写空文件", async () => {
  const r = await call("forge_confirm_artifact", { title: BOOK, artifact: "volume-plan" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-candidate");
  assert.equal(existsSync(path.join(bookBase, "大纲", "卷01", "卷纲.md")), false);
});

await t("世界书确认后拆成多份条目", async () => {
  const body = "## 人物｜沈昭\n\n只在雨天能说话。\n\n## 地点｜听雨楼\n\n城中最高的楼。\n";
  await call("forge_artifact_candidate", { title: BOOK, artifact: "worldbook", body });
  const r = await call("forge_confirm_artifact", { title: BOOK, artifact: "worldbook" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files.length, 2);
  assert.ok(existsSync(path.join(bookBase, "设定", "人物", "沈昭.md")));
  assert.ok(existsSync(path.join(bookBase, "设定", "地点", "听雨楼.md")));
});

// ── 标准 3：一致性 ───────────────────────────────────────────────────────
await t("骨架与世界书对得上", async () => {
  const r = await call("forge_consistency_check", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.consistent, true);
  const text = M.get("forge_consistency_check").output.render({}, r)[0].text;
  assert.match(text, /一致/);
});

await t("骨架提到世界书没有的实体时报出来", async () => {
  await call("forge_artifact_candidate", { title: BOOK, artifact: "skeleton", body: "# 骨架\n\n## 索引\n- 人物 / 沈昭\n- 人物 / 断剑\n" });
  await call("forge_confirm_artifact", { title: BOOK, artifact: "skeleton" });
  const r = await call("forge_consistency_check", { title: BOOK });
  assert.equal(r.consistent, false);
  assert.deepEqual(r.missing.map((m) => m.name), ["断剑"]);
  const text = M.get("forge_consistency_check").output.render({}, r)[0].text;
  assert.match(text, /缺失 1 个/);
  assert.match(text, /断剑/);
});

// ── 标准 6：幂等 ─────────────────────────────────────────────────────────
await t("确认过的不再重复派发", async () => {
  const p = await call("forge_fanout_plan", { title: BOOK });
  assert.ok(!p.ready.some((x) => x.id === "skeleton"));
  assert.ok(!p.ready.some((x) => x.id === "layout"));
  assert.ok(!p.ready.some((x) => x.id === "worldbook"));
  assert.deepEqual(p.ready.map((x) => x.id), ["volume-plan"]);
});

await t("全部工件落真源后，plan 报告开书完成", async () => {
  await call("forge_artifact_candidate", { title: BOOK, artifact: "volume-plan", body: "# 卷纲\n\n本卷目标：沈昭开口。\n" });
  await call("forge_confirm_artifact", { title: BOOK, artifact: "volume-plan" });
  const p = await call("forge_fanout_plan", { title: BOOK });
  assert.equal(p.allDone, true);
  assert.deepEqual(p.landed.sort(), ["layout", "skeleton", "volume-plan", "worldbook"]);
  const r = await call("forge_fanout_run", { title: BOOK });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "nothing-ready");
});

// ── 边界 ─────────────────────────────────────────────────────────────────
await t("空内容不能落候选", async () => {
  const r = await call("forge_artifact_candidate", { title: BOOK, artifact: "skeleton", body: "  " });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-body");
});
await t("未知工件 id 被拒并列出可选值", async () => {
  const r = await call("forge_artifact_candidate", { title: BOOK, artifact: "瞎写的", body: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "unknown-artifact");
  assert.match(r.detail, /skeleton/);
});
await t("非法书名被拒", async () => {
  const r = await call("forge_fanout_plan", { title: "../逃逸" });
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
