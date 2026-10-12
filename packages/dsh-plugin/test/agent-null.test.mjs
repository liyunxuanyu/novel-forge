/**
 * agent() 空返回对照。
 *
 * 官方契约（dsh-tool-workflow 的 DESCRIPTION）明写：
 *   agent() 失败时 resolve **null**，不是 reject；调用方要 .filter(Boolean)。
 *   parallel() 的 thunk 抛错也 resolve null。
 *
 * 这里曾经有个静默失血的洞：脚本用 try/catch 接 agent() 的失败，
 * 那个 catch 永远接不到——引擎给的是 null。于是 { ok: true, index: i, text: null }
 * 失败的子代理被标成成功。
 *
 * 后果分两种，都很坏：
 *  - 全部失败：done 被过滤成空 → 整轮报 empty-run（还算好）。
 *  - **部分失败**（最坏）：3 个审读维度挂了 1 个，done 里少了那条，
 *    failed 却是空的 —— 调用方看到 degraded:false，以为一切正常。
 *    有一个审读维度没跑，而且书里不留任何痕迹。
 *
 * fan-out 更糟：工件带着 text:null 被当成"已产出"交回。
 *
 * 注意：这个假引擎的 start() 必须**同步**返回 run 句柄——真引擎就是同步的
 * （start 里做完校验就 publish，返回 run，result 是它的 promise）。
 * 写成 async 会让 runRound 拿到 Promise，run.result 变 undefined，
 * 那是我自己写测试时踩的坑，不是被测代码的问题。
 */
import { strict as assert } from "node:assert";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { runRound, runFanout } from "../lib/dispatch.js";
import { FAKE_PARENT } from "./helpers/fake-parent.mjs";

let passed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}`); console.log(`        ${error?.message ?? error}`); }
}

/**
 * 真引擎把脚本体原样拼进 `(async () => {\n...\n})()` 跑，宿主侧钩子作为自由变量注入。
 * start() 同步返回 run 句柄，脚本在后台 promise 里跑。
 */
function makeEngine({ agent }) {
  return {
    start(request) {
      const args = structuredClone(request.args ?? {});
      const source = new vm.Script(`(async () => {\n${request.script}\n})()`);
      // runInNewContext 对 async 脚本体返回的是 Promise——
      // 真引擎的 run.result 就是这个 promise 的结果，脚本在里面跑。
      const running = source.runInNewContext({
        args,
        phase: () => {},
        log: () => {},
        // 官方契约：thunk 抛错 resolve null（不 reject）
        parallel: async (thunks) => Promise.all(
          thunks.map((f) => Promise.resolve().then(f).catch(() => null)),
        ),
        agent,
      });
      return {
        id: "r",
        result: running.then((value) => ({ stopReason: "completed", value, agentsStarted: 1 })),
        dispose() {},
      };
    },
  };
}

console.log("阶段十 · agent() 空返回对照测试\n");

await t("并行：一份失败（agent 返回 null）必须进 failed，不得混进 done", async () => {
  let n = 0;
  const engine = makeEngine({ agent: async () => (++n === 1 ? null : "审读意见") });
  const r = await runRound(engine, { label: "review", prompts: ["p1", "p2", "p3"], mode: "parallel", parent: FAKE_PARENT });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.done.length, 2, "只应有 2 份成功：" + JSON.stringify(r));
  assert.equal(r.failed.length, 1, "那份失败的必须被记下来：" + JSON.stringify(r));
  assert.equal(r.degraded, true, "部分失败必须标 degraded：" + JSON.stringify(r));
  assert.match(r.failed[0].reason, /没有交回结果/, JSON.stringify(r));
});

await t("并行：全部失败时整轮判没跑成，不假装成功", async () => {
  const engine = makeEngine({ agent: async () => null });
  const r = await runRound(engine, { label: "review", prompts: ["p1", "p2"], mode: "parallel", parent: FAKE_PARENT });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.stage, "empty-run", JSON.stringify(r));
});

await t("并行：thunk 抛异常（用法错误）也进 failed", async () => {
  const engine = makeEngine({ agent: async () => { throw new Error("opts 非法"); } });
  const r = await runRound(engine, { label: "review", prompts: ["p1", "p2"], mode: "parallel", parent: FAKE_PARENT });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.failed.length, 2, JSON.stringify(r));
  assert.match(r.failed[0].reason, /opts/, JSON.stringify(r));
});

await t("单发：agent 返回 null 不当成交回结果", async () => {
  const engine = makeEngine({ agent: async () => null });
  const r = await runRound(engine, { label: "draft", prompt: "x", mode: "single", parent: FAKE_PARENT });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.stage, "empty-run", JSON.stringify(r));
});

await t("fan-out：失败的工件不得带 text:null 当成已产出", async () => {
  const engine = makeEngine({
    agent: async (p) => (p === "写骨架" ? "骨架内容" : null),
  });
  const r = await runFanout(engine, {
    jobs: [{ id: "skeleton", prompt: "写骨架" }, { id: "worldbook", prompt: "写世界书" }],
    parent: FAKE_PARENT,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.done.length, 1, JSON.stringify(r));
  assert.equal(r.failed.length, 1, "世界书那件必须记失败：" + JSON.stringify(r));
  assert.equal(r.failed[0].id, "worldbook");
  assert.equal(r.degraded, true);
});

await t("契约回归：脚本里 agent() 失败走的是 null 分支，不是 catch", async () => {
  const src = readFileSync(new URL("../lib/dispatch.js", import.meta.url), "utf8");
  const n = (src.match(/agent 返回空/g) ?? []).length;
  assert.ok(n >= 2, "并行与 fan-out 脚本都必须显式判 null，实际 " + n + " 处");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;