/** 阶段五测试：执行层。用假引擎跑，不碰模型。 */
import { strict as assert } from "node:assert";
import { runRound, buildPrompts } from "../lib/dispatch.js";

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

console.log("阶段五 · 执行层测试（假引擎，不调模型）\n");

/** 假引擎：按脚本内容决定返回什么。 */
function fakeEngine({ value, stopReason = "completed", throwOnResult = false, throwOnStart = false, disposeThrows = false, startReturns = true } = {}) {
  const calls = [];
  return {
    calls,
    disposed: false,
    start(spec) {
      calls.push(spec);
      if (throwOnStart) throw new Error("引擎起不来");
      if (!startReturns) return null;
      return {
        id: `run-${calls.length}`,
        result: throwOnResult
          ? Promise.reject(new Error("网络断了"))
          : Promise.resolve({ stopReason, value, agentsStarted: (value?.done ?? []).length }),
        async dispose() {
          if (disposeThrows) throw new Error("dispose 失败");
          this.ownerDisposed = true;
        },
      };
    },
  };
}

await t("单发成功：交回一份结果", async () => {
  const engine = fakeEngine({ value: { done: ["正文草稿"], failed: [] } });
  const r = await runRound(engine, { label: "draft", prompt: "写第一章", mode: "single" });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.deepEqual(r.done, ["正文草稿"]);
  assert.equal(r.mode, "single");
});
await t("任务文本走 args 传，不拼进脚本（避开引号与 ${}）", async () => {
  const engine = fakeEngine({ value: { done: ["x"], failed: [] } });
  await runRound(engine, { label: "draft", prompt: `含"引号"和 \${花括号} 与 \`反引号\``, mode: "single" });
  const spec = engine.calls[0];
  assert.equal(spec.args.prompt, `含"引号"和 \${花括号} 与 \`反引号\``);
  assert.equal(spec.script.includes("花括号"), false, "提示词不该出现在脚本文本里");
  assert.equal(spec.meta.name, "novel-forge:draft");
});

await t("并行成功：多份结果都交回来", async () => {
  const engine = fakeEngine({ value: { done: ["a", "b", "c"], failed: [] } });
  const r = await runRound(engine, { label: "review", prompts: ["p1", "p2", "p3"], mode: "parallel" });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "parallel");
  assert.equal(r.done.length, 3);
});

await t("标准 6：部分子代理失败，成功的结果照常落地并降级", async () => {
  const engine = fakeEngine({ value: { done: ["好的那份"], failed: [{ index: 1, reason: "超时" }] } });
  const r = await runRound(engine, { label: "review", prompts: ["p1", "p2"], mode: "parallel" });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true, "有失败就必须标降级");
  assert.deepEqual(r.done, ["好的那份"]);
  assert.equal(r.failed.length, 1);
  assert.match(r.detail, /超时/);
});

await t("全部失败：明确报错而不是假装成功", async () => {
  const engine = fakeEngine({ value: { done: [], failed: [{ index: 0, reason: "配额用尽" }] } });
  const r = await runRound(engine, { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.stage, "empty-run");
  assert.match(r.detail, /配额用尽/);
});

await t("工作流被取消：降级，不抛异常", async () => {
  const engine = fakeEngine({ stopReason: "cancelled", value: { done: [], failed: [] } });
  const r = await runRound(engine, { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "run-stopped");
  assert.match(r.detail, /cancelled/);
});

await t("取消但已有部分结果：当成降级成功", async () => {
  const engine = fakeEngine({ stopReason: "cancelled", value: { done: ["半成品"], failed: [] } });
  const r = await runRound(engine, { label: "review", prompts: ["p"], mode: "single" });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.deepEqual(r.done, ["半成品"]);
});

await t("引擎抛异常：降级返回，绝不往上抛", async () => {
  const engine = fakeEngine({ throwOnResult: true });
  const r = await runRound(engine, { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "run-threw");
  assert.match(r.detail, /网络断了/);
});

await t("引擎起不来：降级返回", async () => {
  const engine = fakeEngine({ throwOnStart: true });
  const r = await runRound(engine, { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "start-failed");
  assert.match(r.detail, /引擎起不来/);
});

await t("引擎返回空句柄：降级返回", async () => {
  const engine = fakeEngine({ startReturns: false });
  const r = await runRound(engine, { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "start-failed");
});

await t("宿主没有 workflowEngine：给出可读的说明", async () => {
  const r = await runRound(null, { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-engine");
  assert.match(r.detail, /workflowEngine/);
});

await t("dispose 抛错不会盖掉结果", async () => {
  const engine = fakeEngine({ value: { done: ["正文"], failed: [] }, disposeThrows: true });
  const r = await runRound(engine, { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.done, ["正文"]);
});

await t("并行只有一个任务时退回单发", async () => {
  const engine = fakeEngine({ value: { done: ["x"], failed: [] } });
  const r = await runRound(engine, { label: "review", prompts: ["only"], mode: "parallel" });
  assert.equal(r.mode, "single");
});

// ── 提示词拆分 ───────────────────────────────────────────────────────────
await t("审读按维度拆成并行任务", () => {
  const spec = { step: "review", prompt: "基础提示词" };
  const p = buildPrompts(spec, { dimensions: ["人物与关系", "情节与因果", "节奏"] });
  assert.equal(p.mode, "parallel");
  assert.equal(p.prompts.length, 3);
  assert.ok(p.prompts[0].includes("人物与关系"));
  assert.ok(p.prompts[0].includes("本次只审这一个维度"));
  assert.ok(p.prompts[0].includes("基础提示词"), "每个并行任务都要带上完整基础提示词");
});

await t("起草等单任务步骤不做拆分", () => {
  for (const step of ["outline", "draft", "revise"]) {
    const p = buildPrompts({ step, prompt: "提示词" }, { dimensions: ["a", "b", "c"] });
    assert.equal(p.mode, "single", `${step} 不该拆`);
    assert.equal(p.prompts.length, 1);
  }
});
await t("维度只有一个时不拆", () => {
  const p = buildPrompts({ step: "review", prompt: "x" }, { dimensions: ["只有一个"] });
  assert.equal(p.mode, "single");
});
await t("没给维度时退回单发", () => {
  assert.equal(buildPrompts({ step: "review", prompt: "x" }, {}).mode, "single");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
