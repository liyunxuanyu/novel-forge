/**
 * parent 接缝对照。
 *
 * 真引擎 start() 里做 `request.parent.session`。那是硬解引用——
 * parent 一旦 undefined 就抛 TypeError，错误文本对作者毫无意义。
 * 而 exec.agent 在宿主里**确实可能缺席**（dsh-tools 自己派发都写
 * `...exec.agent ? { agent: exec.agent } : {}`），后台自动跑时最常见。
 *
 * 派发层必须把它挡下来，给出可读的理由。
 */
import { strict as assert } from "node:assert";
import { runRound, runFanout } from "../lib/dispatch.js";

let passed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}`); console.log(`        ${error?.message ?? error}`); }
}

function engineThatWantsParent() {
  return {
    start(request) {
      // 照抄真引擎：硬解引用 parent.session
      const sess = request.parent.session;
      if (!sess) throw new Error("should not get here");
      return { id: "r1", result: Promise.resolve({ stopReason: "completed", value: { done: ["写好了"], failed: [] } }), dispose() {} };
    },
  };
}

console.log("阶段十 · parent 接缝对照测试\n");

await t("parent 为 undefined：runRound 给出可读的 no-parent，不是 TypeError", async () => {
  const r = await runRound(engineThatWantsParent(), { label: "draft", prompt: "x", mode: "single" });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.stage, "no-parent", JSON.stringify(r));
  assert.match(r.detail, /父级|parent/, JSON.stringify(r));
});

await t("parent 为 null：同样挡住", async () => {
  const r = await runRound(engineThatWantsParent(), { label: "draft", prompt: "x", mode: "single", parent: null });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-parent", JSON.stringify(r));
});

await t("parent 在但没有 session：给出专门理由", async () => {
  const r = await runRound(engineThatWantsParent(), { label: "draft", prompt: "x", mode: "single", parent: {} });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-parent", JSON.stringify(r));
  assert.match(r.detail, /session/, JSON.stringify(r));
});

await t("fan-out 同样挡：返回结构化 no-parent 且 done/failed 为空数组", async () => {
  const r = await runFanout(engineThatWantsParent(), { jobs: [{ id: "x", prompt: "p" }] });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.stage, "no-parent", JSON.stringify(r));
  assert.deepEqual(r.done, []);
  assert.deepEqual(r.failed, []);
});

await t("parent 齐全时正常放行（不能误伤）", async () => {
  const r = await runRound(engineThatWantsParent(), { label: "draft", prompt: "x", mode: "single", parent: { session: { id: "s1" } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.done[0], "写好了");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;
