/**
 * 失败形状全量对照：每个工具的 {ok:false,stage,detail} 都必须过宿主校验。
 *
 * 为什么这条测试值钱：真宿主在 isError 为 false 时，会拿 output.schema
 * 校返回值（dsh-tools 的 createSuccessResult → validateJsonSchemaValue），
 * 缺一个 required 字段就抛 ToolOutputError。
 *
 * 而本插件的工具把 {ok:false} 当**正常返回**，失败时那些领域字段
 * （chapter / files / batches…）本来就不存在。36 个工具、130 个顶层必填字段，
 * 条条失败路径都会踩——「结构化失败」全变成「抛异常」，
 * 作者看到的不是「章号非法，请改用 1–9999」，而是一句工具内部错误。
 *
 * 这条测试走**真实注册路径**（lib/index.js 的 apply），
 * 所以它验证的是作者真机上会装上的那份 schema，不是复制品。
 */
import { strict as assert } from "node:assert";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { apply } from "../lib/index.js";

let passed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}`); console.log(`        ${error?.message ?? error}`); }
}

/** 与 apply.test.mjs 同构的最小 ctx：够 apply() 跑完并把工具交出来。 */
function makeCtx() {
  const registered = [];
  const services = new Map();
  services.set("tools", { register(def) { registered.push(def); return () => {}; } });
  services.set("skills", { snapshot: () => [] });
  services.set("workspaceRegistry", { list: () => [{ path: "C:/fake/workspace" }] });
  const ctx = {
    registered,
    logger: { info() {}, warn() {}, error() {} },
    get: (s) => services.get(s),
    has: (s) => services.has(s),
    plugin() { return { dispose() {} }; },
    inject(deps, cb) {
      if (deps.some((d) => !services.has(d))) return { dispose() {} };
      cb({ logger: ctx.logger, get: ctx.get, plugin: ctx.plugin, effect: ctx.effect, on: ctx.on });
      return { dispose() {} };
    },
    // 真 cordis：**立刻执行** fn，把 fn 返回的函数登记为卸载清理。
    // 这个桩以前不执行 fn，于是「把清理写进 callback」的 bug 被遮住了。
    effect(fn) {
      const undo = fn();
      return () => { if (typeof undo === "function") undo(); };
    },
    on: () => () => {},
  };
  return ctx;
}

console.log("阶段十 · 失败形状全量对照测试\n");

const ctx = makeCtx();
await apply(ctx, {});
const tools = ctx.registered;

t("注册到了工具（避免本测试空转）", () => {
  assert.ok(tools.length >= 40, `只注册了 ${tools.length} 个`);
});

t("每个工具的失败形状 {ok:false,stage,detail} 都过宿主校验", () => {
  const bad = [];
  for (const def of tools) {
    const v = validateJsonSchemaValue(def.output.schema, { ok: false, stage: "bad-chapter", detail: "章号非法。" }, "value");
    if (v.length > 0) bad.push(`${def.name}: ${v.join("; ")}`);
  }
  assert.deepEqual(bad, [], "这些工具的失败返回值会被宿主判违规：\n" + bad.join("\n"));
});

t("每个工具的顶层 required 只剩 ok（领域字段声明但不强制）", () => {
  const bad = [];
  for (const def of tools) {
    const req = def.output.schema.required ?? [];
    const extra = req.filter((k) => k !== "ok");
    if (extra.length > 0) bad.push(`${def.name}: ${extra.join(",")}`);
  }
  assert.deepEqual(bad, [], "这些工具还有顶层必填的领域字段：\n" + bad.join("\n"));
});

t("每个工具的 ok 仍然是必填（不能连 ok 都松掉）", () => {
  const bad = [];
  for (const def of tools) {
    const req = def.output.schema.required ?? [];
    if (!req.includes("ok")) bad.push(def.name);
  }
  assert.deepEqual(bad, [], "这些工具丢了 ok 必填：" + bad.join(","));
});

t("每个工具的 schema 仍然是 object 且不许额外属性", () => {
  const bad = [];
  for (const def of tools) {
    const s = def.output.schema;
    if (s.type !== "object") bad.push(`${def.name}: type=${s.type}`);
    if (s.additionalProperties !== false) bad.push(`${def.name}: additionalProperties=${s.additionalProperties}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;