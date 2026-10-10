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
    // output 的真实类型是 ContentBlock[]，替身必须照做。
    return { id: "s1", result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "生成的内容" }] }), async dispose() {} };
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

/**
 * 条目级 schema 覆盖追踪。
 *
 * 起因：真机报「value.done[0].ok is not a declared property」，而离线测试全绿。
 * 因为派发类工具当时全走失败路径，done / failed 恒为空数组——
 * **空数组不校验条目**，条目上的字段漂移全被放过去了。
 * 所以这里显式记：每个「数组里装对象」的声明，到底有没有被非空数据走到过。
 * 没走到不算失败（离线造不出全部合法输入），但必须**看得见**，不能静默当已覆盖。
 */
function declaredItemFields(def) {
  const out = [];
  const props = def?.output?.schema?.properties ?? {};
  for (const [key, spec] of Object.entries(props)) {
    if (spec?.type === "array" && spec?.items?.type === "object") out.push(key);
  }
  return out;
}

const itemCoverage = new Map();
for (const [name, def] of all) {
  for (const field of declaredItemFields(def)) itemCoverage.set(`${name}.${field}`, false);
}

function markItemCoverage(name, value) {
  const def = all.get(name);
  if (!def) return;
  for (const field of declaredItemFields(def)) {
    const arr = value?.[field];
    if (Array.isArray(arr) && arr.some((x) => x !== null && typeof x === "object")) {
      itemCoverage.set(`${name}.${field}`, true);
    }
  }
}

async function checkReal(name, args, exec = EXEC) {
  const def = all.get(name);
  assert.ok(def, `没有工具 ${name}`);
  const res = await def.execute(args, exec);
  const v = violationsOf(def, res);
  markItemCoverage(name, res);
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
  // 骨架必须带「## 索引」，否则 forge_consistency_check 会在 no-index 处早退，
  // missing / typeMismatch / extra 三个条目级 schema 永远走不到（覆盖表早就点名了这三处）。
  // 这里刻意造出三种不匹配：
  //   人物/甲  → 世界书里有「甲」但类型是「规则」→ typeMismatch
  //   规则/乙  → 世界书里根本没有乙          → missing
  //   世界书里的「丙」索引里没有              → extra
  ["forge_artifact_candidate", { title: BOOK, artifact: "skeleton", body: "# 骨架\n\n## 索引\n\n- 人物 / 主角\n- 人物 / 甲\n- 规则 / 乙\n" }],
  ["forge_artifact_candidate", { title: BOOK, artifact: "worldbook", body: "## 人物｜主角\n\n主角条目。\n\n## 规则｜甲\n\n甲条目。\n\n## 规则｜丙\n\n丙条目。\n" }],
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
  ["forge_write_truth", { title: BOOK, subject: "design(ch0001): 测试写入", files: [{ path: "大纲/卷01/0001-细纲.md", content: "第一章细纲。" }] }],
  ["forge_confirm_artifact", { title: BOOK, artifact: "skeleton" }],
  ["forge_confirm_artifact", { title: BOOK, artifact: "worldbook" }],
  // 设计工件补齐 layout 与 volume-plan。
  //
  // 为什么非补不可：上面第 282 行那次 forge_director_plan 走的是**失败分支**
  // （nextAction 停在 design.volume_layout 这个 stop 门禁上 → gate-stopped），
  // 而 buildTaskSpec 的成功分支会多返回一个 chapter（director.js:455）。
  // 失败分支不带 chapter，于是这个字段在离线永远校验不到；
  // 自动取材把成功路径打通之后，真机立刻报
  //   「value.chapter is not a declared property (additionalProperties: false)」。
  // 又是同一个形状：**测试只走失败路径，成功路径的字段漂移就没人管**。
  // 布局正文必须写成「第N卷」——director.js 的 parseVolumeLayout 正则要的是
  // /^#{1,4}[ \t]*第[ \t]*([0-9]+|[零一二三四五六七八九十]+)[ \t]*卷/，
  // 写成「## 卷一」解析不出任何卷，hasVolumeLayout 恒为 false，
  // 导演就永远停在 design.volume_layout 上，成功分支照样走不到。
  ["forge_artifact_candidate", { title: BOOK, artifact: "layout", body: "# 分卷布局\n\n## 第一卷｜灯下\n\n主角发现自己的稿子在成真，卷末被迫写下第一个自己不想写的名字。\n\n## 第二卷｜无归\n\n代价开始反噬，主角与自己写出来的「未来自我」正面撞上。\n" }],
  ["forge_confirm_artifact", { title: BOOK, artifact: "layout" }],
  ["forge_artifact_candidate", { title: BOOK, artifact: "volume-plan", body: "# 卷一规划 · 灯下\n\n## 本卷要完成的事\n\n1. 立起「写下的名字会成真」这条规则，并让读者看见它的代价。\n2. 主角第一次为了救人而主动写下一个名字，卷末为此付出代价。\n\n## 章节安排\n\n- 第 1 章：开口。主角在深夜的稿纸上写下一个陌生名字，第二天在讣告上看见它。\n- 第 2 章：他试着改写，发现改得越用力，事情越往反方向走。\n\n## 硬约束\n\n〔硬〕前 20 章不许出现任何形式的系统面板或任务提示。\n〔硬〕「替代」规则一旦成立，不能靠主角后悔撤销。\n" }],
  ["forge_confirm_artifact", { title: BOOK, artifact: "volume-plan" }],
  // 这一步必须**成功**：它是 buildTaskSpec 成功分支的唯一离线入口，
  // chapter / role / prompt 三个字段都在这里被真正校验一次。
  ["forge_director_plan", { title: BOOK }],
  // 骨架与世界书都落真源之后才查一致性——早了会走 no-skeleton 早退。
  ["forge_consistency_check", { title: BOOK }],
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

// 记录施工单的**成功分支**是否真的走到过 —— 见循环后的断言。
const seenPlanSuccess = [];
// 同理：forge_director_run 只有**真的把子代理派出去了**才会返回 stopReason
// （dispatch.js:242/354）。停在 gate-stopped 的失败分支不带这个字段，
// 所以「stopReason 有没有被校验过」就等于「派发成功分支有没有走到过」。
const seenRunDispatched = [];

for (const [name, args] of scenarios) {
  try {
    const res = await checkReal(name, args);
    if (name === "forge_director_plan" && res?.ok === true && res.needsModel === true) seenPlanSuccess.push(res);
    if (name === "forge_director_run" && res?.ok === true && "stopReason" in res) seenRunDispatched.push(res);
    // 产出正文必须真的交回调用方。
    //
    // 这是真机上发现的断链：forge_fanout_run / forge_director_run 派完子代理、
    // 拿回了正文，render 却只报「成功：skeleton（2259 字）」——正文一个字都没交出来。
    // 下一步 forge_artifact_candidate / forge_import_draft 要的就是这段正文，
    // 而模型除了 render 没有任何别的渠道能拿到它。子代理白写了，链子断在交回这一步。
    // 所以这里对**所有**工具统一立规：只要 done 里有正文，render 就必须带上它。
    const texts = Array.isArray(res?.done)
      ? res.done.map((d) => (typeof d === "string" ? d : d?.text)).filter((t) => typeof t === "string" && t !== "")
      : [];
    if (texts.length > 0) {
      const out = (all.get(name).output.render(args, res) ?? []).map((b) => b?.text ?? "").join("");
      for (const t of texts) {
        assert.ok(out.includes(t), `${name} 的 render 没把产出正文交回调用方（丢了 ${t.length} 字）`);
      }
    }
    // 「形状对」不等于「真的成了」：这两个工具返回 ok:false 也照样过 schema 校验。
    // 之前就是这样——世界书其实没落盘，测试全绿，然后一致性核对里 extra 恒为空。
    if (name === "forge_artifact_candidate" || name === "forge_confirm_artifact") {
      assert.equal(res.ok, true, `${name} 返回了 ok:false：${res.stage}｜${res.detail}`);
    }
    passed++;
    console.log(`  PASS  ${name} 返回值过宿主校验`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name} 返回值过宿主校验`);
    console.log(`        ${error?.message ?? error}`);
  }
}

await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});

// ── 成功分支覆盖断言 ────────────────────────────────────────────────────
//
// 只校 schema 是不够的：**走不到的分支，字段漂移没人管**。
// buildTaskSpec 的成功分支比失败分支多一个 chapter，而离线一直只走失败分支，
// 于是真机报「value.chapter is not a declared property」时，本地 640 条全绿。
// 这条断言的作用是：一旦成功分支又走不到了（比如谁把 volume-plan 的确认删了），
// 它立刻红，而不是安静地退化成「只测失败路径」。
t("forge_director_plan 的成功分支真的走到过（否则 chapter 这类字段无人校验）", () => {
  assert.ok(
    seenPlanSuccess.length > 0,
    "整轮下来一次都没走到成功分支 —— chapter / role / prompt 这几个只在成功分支出现的字段又没人校验了",
  );
  const p = seenPlanSuccess[0];
  assert.equal(typeof p.chapter, "number", `成功分支必须带 chapter，实际：${JSON.stringify(p)}`);
  assert.equal(p.node, "chapter.outline_confirm");
  assert.equal(p.step, "outline");
  assert.equal(p.needsModel, true);
  assert.ok(typeof p.role === "string" && p.role.length > 0, "成功分支必须带角色名");
  assert.ok(typeof p.prompt === "string" && p.prompt.length > 0, "施工单必须真的带任务文本");
  // 自动取材真的生效了：卷纲是从书仓真源读出来的，不是调用方手喂的。
  assert.ok(p.prompt.includes("本卷规划"), "prompt 里没有「本卷规划」段，自动取材没生效");
  assert.ok(p.prompt.includes("不能靠主角后悔撤销"), "prompt 没带上卷纲正文");
});

t("forge_director_run 的派发成功分支真的走到过（否则 stopReason 无人校验）", () => {
  assert.ok(
    seenRunDispatched.length > 0,
    "整轮下来 forge_director_run 一次都没真的派出子代理 —— stopReason 这个只在派发成功分支出现的字段又没人校验了",
  );
  const r = seenRunDispatched[0];
  assert.ok("stopReason" in r, "派发成功分支必须带 stopReason");
  assert.ok(Array.isArray(r.done), "派发成功分支必须带 done");
  assert.ok(r.mode === "single" || r.mode === "parallel", `mode 只能是 single/parallel，实际 ${r.mode}`);
});

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

// ── 条目级覆盖报告 ──────────────────────────────────────────────────────
// 不判失败：离线造不出全部合法输入是事实。但未覆盖的必须列出来——
// 上一轮就是「以为覆盖了、其实恒为空数组」把字段漂移放过去的。
const uncoveredItems = [...itemCoverage.entries()].filter(([, hit]) => !hit).map(([k]) => k);
t("条目级 schema 覆盖情况可见（未覆盖的必须列出来，不静默放过）", () => {
  assert.ok(itemCoverage.size > 0, "一个数组条目声明都没收集到，说明追踪本身失效了");
  const covered = itemCoverage.size - uncoveredItems.length;
  console.log(`        条目级声明 ${itemCoverage.size} 处，本轮非空走到 ${covered} 处`);
  if (uncoveredItems.length > 0) {
    console.log(`        未走到（离线造不出输入，真机跑到时必须重新核对）：${uncoveredItems.join("、")}`);
  }
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;
