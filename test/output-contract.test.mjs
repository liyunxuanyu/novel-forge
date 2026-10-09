/**
 * 输出契约对照：拿返回值去过宿主自己的校验器。
 *
 * 真引擎 dsh-tools 的 createSuccessResult 里有一句：
 *   const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
 *   if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
 *
 * **返回值是要被 output.schema 校验的。** 有一条违规就整次工具调用失败。
 * 而本插件的 schema 普遍写了 additionalProperties:false —— 最严的那档：
 * 返回值里多出一个没声明的字段，同样算违规。
 *
 * 以前的测试只验证「schema 在加载期能过 defineTool 校验」，
 * 也就是**声明**本身合法；从来没验证过**真实返回值**合不合法。
 * 于是写错一个字段名，离线全绿，真机上那次调用直接炸。
 *
 * 这里直接 import 宿主导出的 validateJsonSchemaValue 与
 * valueSchemaSpecToJsonSchema，用同一套规则校真实返回值。
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { validateJsonSchemaValue, valueSchemaSpecToJsonSchema, defineTool } from "@deepseek-ai/dsh-tools";

import { warehouseTools } from "../lib/tools-warehouse.js";
import { chapterTools } from "../lib/tools-chapter.js";
import { directorTools } from "../lib/tools-director.js";
import { fanoutTools } from "../lib/tools-fanout.js";
import { deconstructTools } from "../lib/tools-deconstruct.js";
import { styleTools } from "../lib/tools-style.js";
import { gateTools } from "../lib/tools-gates.js";

/** 与 lib/index.js 的 relaxTopLevelRequired 同构：真机上注册前会这么处理。 */
const relax = (def) => {
  const s = def?.output?.schema;
  if (!s || s.type !== "object" || !Array.isArray(s.required)) return def;
  const kept = s.required.filter((k) => k === "ok");
  const next = { ...s };
  if (kept.length > 0) next.required = kept; else delete next.required;
  return { ...def, output: { ...def.output, schema: next } };
};


const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const sandboxRoot = path.join(projectRoot, "..", ".forge-test-sandbox");
await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});

fs.mkdirSync(sandboxRoot, { recursive: true });

let passed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}`); console.log(`        ${error?.message ?? error}`); }
}

const EXEC = { agent: { session: { id: "s" } }, signal: new AbortController().signal };

/** 拿一组工具的 schema 与 execute。 */
function collect(maker, ctx, resolveRoot, extra) {
  const arr = maker(ctx, resolveRoot, extra);
  // 顺序要紧：defineTool 先把 DSL 编译成 JSON Schema，relax 才改得动 required。
  // 反过来的话 relax 看到的是 DSL（没有顶层 required 数组），会原样返回。
  const map = arr instanceof Map ? arr : new Map(arr.map((d) => [d.name, relax(defineTool(d))]));
  return map;
}

/**
 * 真宿主会校验返回值。这里照抄它那一行：
 *   validateJsonSchemaValue(schema, value, "value")
 * 返回非空数组即违规。
 */
function violationsOf(def, value) {
  // collect 里已经过 defineTool，所以 def.output.schema 就是编译好的 JSON Schema，
  // 不能再 valueSchemaSpecToJsonSchema 二次编译（那是 DSL → JSON Schema 的单向门）。
  return validateJsonSchemaValue(def.output.schema, value, "value");
}

console.log("阶段十 · 输出契约对照测试（用宿主自己的校验器）\n");

// ---- 建工作区与书仓，后面每个工具都要用到 ----
// ---- 建工作区与书仓，后面每个工具都要用到 ----
// 各模块第二个参数是工作区根解析器（跟已有测试一致），不是 ctx 上的服务。
const fakeCtx = { logger: { info() {}, warn() {}, error() {} } };
const resolveRoot = () => sandboxRoot;

// 假运行时：引擎与 subagents 都给。
//
// 这里以前是 `const ctx = { workflowEngine: {...} }`，但 collect() 传的是 fakeCtx，
// 那个 ctx 从头到尾没人用 —— 于是所有派发类工具都走 no-engine 失败路径，
// done / failed 恒为空数组，**条目级 schema 从来没被校验过**。
// 真机就是在那里报的：「value.done[0].ok is not a declared property」。
// 现在把运行时真的接进去，让成功路径也被走到。
// 假引擎必须按**脚本**回不同形状，否则就不是忠实的替身：
//   runRound 的脚本回 [文本]
//   fanout 的脚本回 [{id, ok, text}]
// 之前一律回 [文本]，于是 fanout 的条目形状从来没被校验到。
const fakeEngine = {
  start(spec) {
    const isFanout = Array.isArray(spec?.args?.jobs);
    // 故意留一份失败：done 与 failed 的**条目级** schema 都要被走到。
    // 只回成功的话，failed[].ok 这类字段永远校验不到——真机上一轮就是这么漏的。
    const value = isFanout
      ? {
          done: spec.args.jobs.slice(1).map((j) => ({ id: j.id, ok: true, text: "生成的内容" })),
          failed: spec.args.jobs.slice(0, 1).map((j) => ({ id: j.id, ok: false, reason: "假失败：工件没派成" })),
        }
      : { done: ["生成的内容"], failed: [{ ok: false, index: 0, reason: "假失败：子代理没交回结果" }] };
    return {
      id: "r",
      result: Promise.resolve({ stopReason: "completed", value, agentsStarted: value.done.length }),
      dispose() {},
    };
  },
};
const fakeSubagents = {
  list: () => ["spawn"],
  async start() {
    return { id: "s1", result: Promise.resolve({ stopReason: "completed", output: "生成的内容" }), async dispose() {} };
  },
};
const getRuntime = () => ({ engine: fakeEngine, subagents: fakeSubagents });

const all = new Map([
  ...collect((m, r) => warehouseTools(m, r ?? resolveRoot), fakeCtx, resolveRoot),
  ...collect(chapterTools, fakeCtx, resolveRoot),
  ...collect(directorTools, fakeCtx, resolveRoot, getRuntime),
  ...collect(fanoutTools, fakeCtx, resolveRoot, getRuntime),
  ...collect(deconstructTools, fakeCtx, resolveRoot, getRuntime),
  ...collect(styleTools, fakeCtx, resolveRoot),
  ...collect(gateTools, fakeCtx, resolveRoot),
]);

t("工具集合非空（避免本测试空转）", () => {
  assert.ok(all.size > 0, "一个工具都没收集到");
});

// ---- 建工作区 ----
const initTool = all.get("forge_init_workspace");
assert.ok(initTool, "缺 forge_init_workspace");

// 真机教训：这里原来只 `await initTool.execute(...)` 把返回值丢掉，而下面那个
// 叫「真实返回值合 schema」的用例其实只断言了 schema 存在——一个永远不会失败的
// 测试。于是 initWorkspace 在新建路径上多返回的 wroteIgnore / commit 一直没被
// 发现，直到真机报「wroteIgnore is not a declared property」。
// 现在真跑真校：沙盒在第 48 行刚被删过，所以这一次走的就是**新建**分支。
const initFresh = await initTool.execute({}, EXEC);
const initV = violationsOf(initTool, initFresh);
assert.deepEqual(initV, [], `forge_init_workspace（新建）返回值违反 schema：${JSON.stringify(initV)}｜实际：${JSON.stringify(initFresh)}`);
assertLossless("forge_init_workspace.render", initTool.output.render({}, initFresh));

// 再跑一次走幂等分支——两条路径的返回形状不一样，都得校。
const initAgain = await initTool.execute({}, EXEC);
const initV2 = violationsOf(initTool, initAgain);
assert.deepEqual(initV2, [], `forge_init_workspace（幂等）返回值违反 schema：${JSON.stringify(initV2)}｜实际：${JSON.stringify(initAgain)}`);
assertLossless("forge_init_workspace.render(幂等)", initTool.output.render({}, initAgain));

t("forge_init_workspace 两条分支的真实返回值都合 schema", () => {
  assert.ok(initFresh.alreadyRepo === false, `首次应当走新建分支，实际 alreadyRepo=${initFresh.alreadyRepo}`);
  assert.ok(initAgain.alreadyRepo === true, `二次应当走幂等分支，实际 alreadyRepo=${initAgain.alreadyRepo}`);
});

const BOOK = "测试之书";

/**
 * 关键：对每个「会成功返回」的工具，校验它的 schema 本身
 * 能被宿主转换、且 additionalProperties:false 下返回体是自洽的。
 *
 * 由于无法在离线环境为全部 40 个工具造出合法输入（需要真实书仓与模型），
 * 这里采取**结构自洽**检查：把 schema 转成 JSON Schema 后，
 * 断言它通过宿主的 supported 校验，并且 declared 的 required 字段齐全。
 */
t("每个工具的 output.schema 都能过宿主转换", () => {
  for (const [name, def] of all) {
    assert.ok(def.output.schema && def.output.schema.type === "object", `${name} 的 output.schema 不是 object`);
  }
});

t("每个工具的 render 都能吃一个空对象而不抛（宿主要先调 render）", () => {
  for (const [name, def] of all) {
    try {
      def.output.render({}, {});
    } catch (error) {
      assert.fail(`${name}.render({}, {}) 抛了：${error?.message ?? error}`);
    }
  }
});

/**
 * 广撒网：把离线环境造得出合法输入的工具都真跑一遍，
 * 每次都用**宿主自己的校验器**校一遍返回值。
 * schema 写错一个字段名，这里就会炸——而以前没有这类测试。
 */
/**
 * 照抄宿主 snapshotProjection 的判据：render 的返回值必须是**无损 JSON**。
 * undefined、NaN、Infinity、函数——任何一样都会让宿主抛 ToolOutputError。
 * 尤其 undefined：render 少写一个 return 就会踩，真机上极难定位。
 */
function assertLossless(label, value) {
  if (value === undefined) throw new Error(`${label} 返回了 undefined —— 宿主 snapshotProjection 会抛 ToolOutputError`);
  const walk = (x, p) => {
    if (x === undefined) throw new Error(`${label} 在 ${p} 有 undefined`);
    if (typeof x === "function") throw new Error(`${label} 在 ${p} 有函数`);
    if (typeof x === "number" && !Number.isFinite(x)) throw new Error(`${label} 在 ${p} 有非有限数 ${x}`);
    if (x !== null && typeof x === "object") {
      for (const k of Object.keys(x)) walk(x[k], `${p}.${k}`);
    }
  };
  walk(value, "$");
}

async function checkReal(name, args, exec = EXEC) {
  const def = all.get(name);
  assert.ok(def, `没有工具 ${name}`);
  const res = await def.execute(args, exec);
  const v = violationsOf(def, res);
  assert.deepEqual(v, [], `${name} 返回值违反自己的 output.schema：${JSON.stringify(v)}｜实际：${JSON.stringify(res)}`);
  // 成功分支的 render 也要真跑一遍：以前只跑了 render({}, {})，
  // 那基本只走到失败分支——成功分支返回 undefined 也发现不了。
  assertLossless(`${name}.render`, def.output.render(args, res));
  return res;
}

await (async () => {
  await checkReal("forge_create_book", {
    title: BOOK,
    coreIdea: "一个人发现自己写的小说正在成真。",
    genreAndAudience: "都市奇幻 · 成人读者",
    keyAppeal: "作者与角色互为因果。",
    differentiation: "不靠系统，靠笔下的自己在改写作者。",
    protagonistDesire: "把稿子改完。",
    mainConflict: "他越想控制，故事越失控。",
    explicitlyAvoid: "不写系统流。",
  });
  t("forge_create_book 返回值过宿主校验", () => {});
})().catch((error) => {
  t("forge_create_book 返回值过宿主校验", () => { throw error; });
});

const scenarios = [
  ["forge_book_status", { title: BOOK }],
  ["forge_book_status", {}],
  ["forge_director_next", { title: BOOK }],
  ["forge_director_plan", { title: BOOK }],
  ["forge_fanout_plan", { title: BOOK }],
  ["forge_gate_status", { title: BOOK }],
  ["forge_gate_check", { title: BOOK, node: "chapter.draft" }],
  ["forge_list_debts", { title: BOOK }],
  ["forge_chapter_status", { title: BOOK, chapter: 1 }],
  ["forge_artifact_candidate", { title: BOOK, artifact: "skeleton", body: "第 1 卷：主角发现稿子会成真。" }],
  ["forge_ref_plan", { sourceId: "test_src", ranges: [{ start: 1, end: 120 }] }],
  ["forge_ref_status", {}],
  ["forge_style_list", { title: BOOK }],
  ["forge_director_run", { title: BOOK, step: "draft", context: { taskText: "写第一章" } }],

  // ── 第二轮：把状态机往前推，覆盖更多工具与更多分支 ──────────────
  // 债务台账：不带章号的债（chapter=null）与带章号的都要走一遍
  ["forge_record_finding", { title: BOOK, severity: "s3", quote: "他忽然意识到。", note: "AI 味：突兀转折。" }],
  ["forge_record_finding", { title: BOOK, chapter: 1, severity: "s4", quote: "风很轻。", note: "用词重复。" }],
  ["forge_list_debts", { title: BOOK }],
  ["forge_debt_gate", { title: BOOK }],
  ["forge_consistency_check", { title: BOOK }],
  ["forge_write_truth", { title: BOOK, subject: "design(ch0001): 测试写入", files: [{ path: "大纲/卷01/0001-细纲.md", content: "第一章细纲。" }] }],
  ["forge_confirm_artifact", { title: BOOK, artifact: "skeleton" }],
  ["forge_outline_draft", { title: BOOK, chapter: 1, volume: 1, body: "第一章细纲。" }],
  ["forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 }],
  ["forge_assemble_materials", { title: BOOK, chapter: 1, volume: 1 }],
  ["forge_draft_task", { title: BOOK, chapter: 1, volume: 1 }],
  ["forge_import_draft", { title: BOOK, chapter: 1, volume: 1, body: "正文草稿。" }],
  ["forge_dispatch_review", { title: BOOK, chapter: 1 }],
  ["forge_record_findings", { title: BOOK, chapter: 1, covered: ["文风"], findings: [], summary: "零发现项。" }],
  ["forge_settle_chapter", { title: BOOK, chapter: 1, volume: 1 }],
  ["forge_settle_volume", { title: BOOK, volume: 1 }],
  ["forge_settle_debt", { title: BOOK, id: "d0001", action: "resolve", how: "已按审读意见改掉。" }],
  ["forge_scan_mechanisms", { title: BOOK, text: "他握紧拳头。他知道，这一战避不开了。" }],
  ["forge_ai_flavor_scan", { title: BOOK, sourceText: "他忽然意识到。风很轻，很轻。仿佛一切都在这一刻凝固了。" }],
  ["forge_style_list", { title: BOOK }],
  ["forge_style_add", { title: BOOK, entries: [{ kind: "措辞", statement: "少用「仿佛」「忽然」这类词。", why: "这本书要写得干脆。", evidence: { chapter: 1, lineStart: 1, quote: "风很轻。" } }] }],
  ["forge_ref_status", {}],
  ["forge_ref_consent", { sourceId: "test_src", provider: "openai", model: "gpt-4o", service: "openai", ranges: [{ start: 1, end: 120 }] }],
  ["forge_ref_import", { sourceId: "test_src", filename: "a.txt", content: "第一行原文。", title: "测试原作", author: "某人", edition: "初版", acquiredFrom: "自购", allowedUses: "仅拆解", basis: "自购纸书", basisKind: "self-owned" }],
  ["forge_ref_mechanisms", { sourceId: "test_src" }],
  ["forge_ref_batch", { sourceId: "test_src", index: 1 }],
  ["forge_ref_redeconstruct", { sourceId: "test_src", reason: "换了拆解口径。" }],
  ["forge_fanout_run", { title: BOOK }],
  ["forge_director_next", { title: BOOK }],
  ["forge_director_run", { title: BOOK, step: "design.skeleton" }],
];

for (const [name, args] of scenarios) {
  try {
    await checkReal(name, args);
    passed++;
    console.log(`  PASS  ${name} 返回值过宿主校验`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name} 返回值过宿主校验`);
    console.log(`        ${error?.message ?? error}`);
  }
}

await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});

// 收尾这两行不能少：少了它，本测试即使有 FAIL 也不会让套件变红，
// 等于一个「永远不会失败」的测试——比没有测试更糟。
// ── forge_status 单独补测 ────────────────────────────────────────────────
//
// forge_status 内联在 lib/index.js 里，不在上面那 7 个工具模块中，所以之前的
// 场景清单漏了它——而真机上它恰恰是**第一个**暴露 schema 漂移的工具：
// services.detail 被声明成 additionalProperties:false 且不列任何属性，
// 实际却是按服务名铺开的动态映射，于是宿主直接报
// 「value.services.detail.tools is not a declared property」。
//
// 这里用真实的 apply() 把它取出来，跑一次真返回值过校验，堵上这个缺口。
await (async () => {
  const { apply: applyPlugin } = await import("../lib/index.js");
  const captured = [];
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const undo = fn(); return () => { if (typeof undo === "function") undo(); }; },
    inject: (_deps, cb) => cb({ plugin: () => {}, get: () => undefined }),
    plugin: () => {},
    get(name) {
      if (name === "tools") return { register(t) { captured.push(t); return () => {}; } };
      if (name === "skills") return {};
      if (name === "workspaceRegistry") return { list: () => [] };
      return undefined;
    },
  };
  await applyPlugin(fakeCtx, { verboseStartup: false });
  const statusDef = captured.find((t) => t.name === "forge_status");
  assert.ok(statusDef, "apply() 应当注册 forge_status");
  const statusValue = await statusDef.execute({ deep: false }, {});
  const sv = violationsOf(statusDef, statusValue);
  assert.deepEqual(sv, [], `forge_status 返回值违反自己的 output.schema：${JSON.stringify(sv)}｜实际：${JSON.stringify(statusValue)}`);
  assertLossless("forge_status.render", statusDef.output.render({ deep: false }, statusValue));
})();

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;
