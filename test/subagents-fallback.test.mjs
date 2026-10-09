/**
 * 阶段十补充：subagents 退路。
 *
 * 真机实测本 profile 拿不到 workflowEngine，但 subagents 可达。导演链最终目的是
 * 「派子代理」，引擎只是其中一条路，所以 dispatch 补了一条直接走宿主子代理服务的
 * 退路。这里用假 subagents 服务测它——重点全在**失败路径**：
 * 退路写歪了最典型的后果是把「子代理拒答」或「交白卷」当成一份合格产出，
 * 而调用方完全看不出来，整本书就这么带着没写的东西往下走。
 */
import { strict as assert } from "node:assert";
import { runRound, runFanout } from "../lib/dispatch.js";
import { FAKE_PARENT } from "./helpers/fake-parent.mjs";

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

console.log("阶段十 · subagents 退路测试（假服务，不调模型）\n");

/** 假 subagents 服务。契约照抄 @deepseek-ai/dsh-tool-subagent 的真实用法。 */
function fakeSubagents({ output = "结果", stopReason = "completed", throwOnStart = false, list = ["spawn", "fork"] } = {}) {
  const calls = [];
  const runs = [];
  return {
    calls,
    runs,
    list: () => list,
    async start(provider, request) {
      calls.push({ provider, request });
      if (throwOnStart) throw new Error("子代理服务起不来");
      const run = {
        id: `run-${calls.length}`,
        disposed: false,
        result: Promise.resolve({ stopReason, output }),
        async dispose() { this.disposed = true; },
      };
      runs.push(run);
      return run;
    },
  };
}

const OPTS = { label: "draft", prompt: "写第一章", mode: "single", parent: FAKE_PARENT };

// ── 通路 ────────────────────────────────────────────────────────────────
await t("没有引擎但有 subagents：走退路，交回结果", async () => {
  const sa = fakeSubagents({ output: "正文草稿" });
  const r = await runRound(undefined, { ...OPTS, subagents: sa });
  assert.equal(r.ok, true);
  assert.deepEqual(r.done, ["正文草稿"]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.mode, "single");
});

await t("provider 优先取 spawn", async () => {
  const sa = fakeSubagents({ list: ["fork", "spawn"] });
  await runRound(undefined, { ...OPTS, subagents: sa });
  assert.equal(sa.calls[0].provider, "spawn");
});

await t("没有 spawn 时取列表第一个", async () => {
  const sa = fakeSubagents({ list: ["fork"] });
  await runRound(undefined, { ...OPTS, subagents: sa });
  assert.equal(sa.calls[0].provider, "fork");
});

await t("请求形状照抄宿主：prompt 是 [{type,text}]，带 parent", async () => {
  const sa = fakeSubagents({});
  await runRound(undefined, { ...OPTS, subagents: sa });
  const req = sa.calls[0].request;
  assert.deepEqual(req.prompt, [{ type: "text", text: "写第一章" }]);
  assert.equal(req.parent, FAKE_PARENT);
  assert.equal(req.label, "draft");
});

// ── 失败路径（重点） ────────────────────────────────────────────────────
await t("子代理拒答：算失败，绝不能算一份合格产出", async () => {
  const sa = fakeSubagents({ stopReason: "refusal", output: "我不写这个" });
  const r = await runRound(undefined, { ...OPTS, subagents: sa });
  assert.equal(r.ok, false, "拒答必须让整轮失败");
  assert.equal(r.done.length, 0, "拒答的输出不得混进 done");
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /拒绝/);
});

await t("撞 token 上限：算失败，不能当写完了", async () => {
  const sa = fakeSubagents({ stopReason: "max-tokens", output: "半截话" });
  const r = await runRound(undefined, { ...OPTS, subagents: sa });
  assert.equal(r.ok, false);
  assert.equal(r.done.length, 0);
  assert.match(r.failed[0].reason, /token/);
});

await t("交白卷：空白输出当失败，不当成功", async () => {
  const sa = fakeSubagents({ output: "   \n  " });
  const r = await runRound(undefined, { ...OPTS, subagents: sa });
  assert.equal(r.ok, false, "空串比报错危险得多");
  assert.equal(r.done.length, 0);
});

await t("start 抛异常：结构化失败，不往上抛", async () => {
  const sa = fakeSubagents({ throwOnStart: true });
  const r = await runRound(undefined, { ...OPTS, subagents: sa });
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /起不来/);
});

await t("dispose 一定要被调用（成功与失败两条路都要）", async () => {
  const ok = fakeSubagents({ output: "好" });
  await runRound(undefined, { ...OPTS, subagents: ok });
  assert.ok(ok.runs.every((r) => r.disposed), "成功路径没 dispose");

  const bad = fakeSubagents({ stopReason: "error" });
  await runRound(undefined, { ...OPTS, subagents: bad });
  assert.ok(bad.runs.every((r) => r.disposed), "失败路径没 dispose");
});

await t("两者都没有：no-engine，且说清楚两条路都没有", async () => {
  const r = await runRound(undefined, { ...OPTS });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-engine");
  assert.match(r.detail, /subagents/);
});

await t("parent 不合法时，退路也要拦住", async () => {
  const sa = fakeSubagents({});
  const r = await runRound(undefined, { ...OPTS, parent: undefined, subagents: sa });
  assert.equal(r.ok, false);
  assert.equal(sa.calls.length, 0, "parent 不合格就不该真的派出去");
});

// ── 并行与 fan-out ──────────────────────────────────────────────────────
await t("并行：三个维度各派一个，全成功", async () => {
  const sa = fakeSubagents({ output: "审读意见" });
  const r = await runRound(undefined, { label: "review", mode: "parallel", prompts: ["a", "b", "c"], parent: FAKE_PARENT, subagents: sa });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "parallel");
  assert.equal(r.done.length, 3);
  assert.equal(sa.calls.length, 3);
  assert.deepEqual(sa.calls.map((c) => c.request.label), ["review-0", "review-1", "review-2"]);
});

await t("fan-out：每件工件带回自己的 id，不靠顺序猜", async () => {
  const sa = fakeSubagents({ output: "工件正文" });
  const r = await runFanout(undefined, {
    jobs: [{ id: "skeleton", prompt: "p1" }, { id: "worldbook", prompt: "p2" }],
    parent: FAKE_PARENT,
    subagents: sa,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.done.map((d) => d.id), ["skeleton", "worldbook"]);
  assert.ok(r.done.every((d) => d.text === "工件正文"));
});

await t("fan-out 全失败：all-failed，且带得出是哪些工件", async () => {
  const sa = fakeSubagents({ stopReason: "refusal" });
  const r = await runFanout(undefined, {
    jobs: [{ id: "skeleton", prompt: "p1" }, { id: "worldbook", prompt: "p2" }],
    parent: FAKE_PARENT,
    subagents: sa,
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "all-failed");
  assert.deepEqual(r.failed.map((f) => f.id), ["skeleton", "worldbook"]);
});

// ── 有引擎时不能走退路 ──────────────────────────────────────────────────
await t("有 workflowEngine 时仍走引擎，退路不抢", async () => {
  const engineCalls = [];
  const engine = {
    start(spec) {
      engineCalls.push(spec);
      return { id: "r1", result: Promise.resolve({ stopReason: "completed", value: { done: ["引擎结果"], failed: [] } }), async dispose() {} };
    },
  };
  const sa = fakeSubagents({});
  const r = await runRound(engine, { ...OPTS, subagents: sa });
  assert.equal(r.ok, true);
  assert.deepEqual(r.done, ["引擎结果"]);
  assert.equal(sa.calls.length, 0, "有引擎就不该去动 subagents");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL  ${f.name}\n        ${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}