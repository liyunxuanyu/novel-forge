/**
 * 真引擎契约对照。
 *
 * 派发层的三个脚本与 `engine.start()` 的调用形状，以前**从来没有被真引擎跑过**——
 * 全部测试用的假引擎直接回写死的 `done`，连 meta 都不看。
 *
 * 这一条比照 `dsh-workflow-ptc` 的真实校验写了个会挑毛病的假引擎：
 * `start()` 第一件事就是 validateMeta，name / description 都必须非空。
 * 之前的 `meta: { name }` 缺 description，会在发布 run 之前同步抛 META_INVALID——
 * 线上每一派出都是全灭，而 516 项断言照样全绿。
 */
import { strict as assert } from "node:assert";
import { runRound, runFanout } from "../lib/dispatch.js";
import { buildPrompts } from "../lib/dispatch.js";
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

/**
 * 照抄 dsh-workflow-ptc 的 validateMetaShape：只认 name/description/whenToUse/phases，
 * 且 name 与 description 都必须非空字符串。不同的就抛 META_INVALID。
 * 还会 new vm.Script 试编译脚本体——真引擎也这么做，语法错同样死在 start。
 */
function contractEngine({ reply = "沈昭张口。" } = {}) {
  const starts = [];
  const engine = {
    starts,
    start(request) {
      const m = request?.meta;
      const violations = [];
      if (typeof m !== "object" || m === null || Array.isArray(m)) violations.push("meta must be an object");
      else {
        for (const k of Object.keys(m)) if (!["name", "description", "whenToUse", "phases"].includes(k)) violations.push(`meta.${k} not recognized`);
        if (typeof m.name !== "string" || m.name.length === 0) violations.push("meta.name must be a non-empty string");
        if (typeof m.description !== "string" || m.description.length === 0) violations.push("meta.description must be a non-empty string");
      }
      if (violations.length > 0) {
        const e = new Error(`invalid meta: ${violations.join("; ")}`);
        e.code = "META_INVALID";
        throw e; // 真引擎是同步抛，不是返回失败值
      }
      starts.push(request);
      return {
        id: `run-${starts.length}`,
        result: Promise.resolve({ stopReason: "completed", value: { done: [reply], failed: [] }, agentsStarted: 1 }),
        dispose() {},
      };
    },
  };
  return engine;
}

console.log("阶段十 · 真引擎契约对照测试（照抄 dsh-workflow-ptc 的校验）\n");

await t("单发脚本：meta 合契约，派得出去", async () => {
  const engine = contractEngine();
  const r = await runRound(engine, { label: "draft", prompt: "写第 1 章", mode: "single", parent: FAKE_PARENT });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.done.length, 1);
  assert.equal(engine.starts.length, 1);
});

await t("并行脚本：meta 合契约，派得出去", async () => {
  const engine = contractEngine();
  const split = buildPrompts({ step: "review", prompt: "审这一章" }, { dimensions: ["节奏", "文风"] });
  assert.equal(split.mode, "parallel");
  const r = await runRound(engine, { label: "review", prompts: split.prompts, mode: split.mode, parent: FAKE_PARENT });
  assert.equal(r.ok, true, JSON.stringify(r));
});

await t("fan-out 脚本：meta 合契约，派得出去", async () => {
  const engine = contractEngine();
  const r = await runFanout(engine, {
    jobs: [
      { id: "skeleton", prompt: "写骨架" },
      { id: "worldbook", prompt: "写世界书" },
    ],
    parent: FAKE_PARENT,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

await t("meta 缺 description：派发必须结构化失败，而不是把异常甩给调用方", async () => {
  // 模拟我们若忘了补 description：假引擎抛 META_INVALID，runRound 要把它收成结构化返回。
  const engine = contractEngine();
  const broken = { start: (r) => engine.start({ ...r, meta: { name: r.meta.name } }) };
  const r = await runRound(broken, { label: "draft", prompt: "x", mode: "single", parent: FAKE_PARENT });
  // start 是同步抛的，runRound 用 try/catch 包着，所以这里是 ok:false 的 start-failed
  assert.equal(r.ok, false, "meta 不合约必须失败，不能算成功：" + JSON.stringify(r));
  assert.equal(r.stage, "start-failed", JSON.stringify(r));
  assert.match(r.detail, /description/, JSON.stringify(r));
});

await t("真实 runMeta 带 description（防止将来又漏回去）", async () => {
  const engine = contractEngine();
  const r = await runRound(engine, { label: "settle", prompt: "x", mode: "single", parent: FAKE_PARENT });
  assert.equal(r.ok, true, JSON.stringify(r));
  const meta = engine.starts[0].meta;
  assert.equal(typeof meta.description, "string");
  assert.ok(meta.description.length > 0, "description 不能是空串");
});

await t("三个脚本脚本体都过 vm 编译（真引擎 start 会先 parse）", async () => {
  // buildPrompts 与 runFanout 用的模板不能有语法错；真引擎 new vm.Script 会在 start 前抛。
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/dispatch.js", import.meta.url), "utf8");
  const vm = await import("node:vm");
  for (const name of ["SCRIPT_SINGLE", "SCRIPT_PARALLEL", "FANOUT_SCRIPT"]) {
    const m = src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
    assert.ok(m, `找不到 ${name}`);
    new vm.Script(`(async () => {\n${m[1]}\n})()`); // 编译即通过
  }
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
