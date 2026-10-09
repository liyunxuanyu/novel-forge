/**
 * 阶段一测试：不依赖 DSH 宿主，用模拟 ctx 把 apply() 真实跑一遍。
 *
 * 模拟 ctx 必须符合 cordis 语义，否则测出来的是桩的 bug 而不是插件的：
 *   - ctx.plugin / ctx.inject 是独立能力
 *   - ctx.effect(fn) 只「登记」清理函数，等插件卸载时才由 cordis 调用；
 *     桩若立即调用，会把刚注册的插件组件反向注销。
 */
import { strict as assert } from "node:assert";

const mod = await import(new URL("../lib/index.js", import.meta.url).href);

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

const TOOL_NAMES = [
  "forge_status",
  // 书仓协议
  "forge_init_workspace",
  "forge_create_book",
  "forge_book_status",
  "forge_write_truth",
  // 章节流水线
  "forge_chapter_status",
  "forge_outline_draft",
  "forge_confirm_outline",
  "forge_assemble_materials",
  "forge_draft_task",
  "forge_import_draft",
  "forge_dispatch_review",
  "forge_record_findings",
  "forge_settle_chapter",
  // 门禁与质量债
  "forge_gate_status",
  "forge_gate_check",
  "forge_record_finding",
  "forge_list_debts",
  "forge_settle_debt",
  "forge_debt_gate",
  // 自动导演
  "forge_director_next",
  "forge_director_plan",
  "forge_director_run",
  "forge_settle_volume",
  // 开书 fan-out
  "forge_fanout_plan",
  "forge_fanout_run",
  "forge_artifact_candidate",
  "forge_confirm_artifact",
  "forge_consistency_check",
  // 拆书管道
  "forge_ref_import",
  "forge_ref_plan",
  "forge_ref_consent",
  "forge_ref_status",
  "forge_ref_batch",
  "forge_ref_mechanisms",
  "forge_ref_redeconstruct",
  // 写法库 / 扫榜 / 去 AI 味
  "forge_style_add",
  "forge_style_list",
  "forge_scan_mechanisms",
  "forge_ai_flavor_scan",
];

function makeCtx({ withTools = true, withSkills = true, withPlugin = true } = {}) {
  const registered = [];
  const mounted = [];
  const effectFns = [];
  const logs = [];

  const services = new Map();
  if (withTools) {
    services.set("tools", {
      register(def) {
        registered.push(def);
        return () => {
          const i = registered.indexOf(def);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    });
  }
  if (withSkills) services.set("skills", { snapshot: () => [] });
  services.set("workspaceRegistry", { list: () => [{ path: "C:/fake/workspace" }] });

  const ctx = {
    registered,
    mounted,
    effectFns,
    logs,
    logger: {
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
      error: (m) => logs.push(["error", m]),
    },
    get: (service) => services.get(service),
    has: (service) => services.has(service),
    // 独立能力：cordis 的 RegistryService.plugin
    plugin(plugin, config) {
      mounted.push({ plugin, config });
      return { dispose() {} };
    },
    inject(deps, callback) {
      const missing = deps.filter((d) => !services.has(d));
      if (missing.length > 0) return { dispose() {} };
      const scope = {
        logger: ctx.logger,
        get: ctx.get,
        plugin: ctx.plugin,
        effect: ctx.effect,
        on: ctx.on,
      };
      callback(scope);
      return { dispose() {} };
    },
    // 只登记，不立即执行 —— 与 cordis 一致
    effect(fn, label) {
      effectFns.push({ fn, label });
      return () => {
        const i = effectFns.findIndex((e) => e.fn === fn);
        if (i >= 0) effectFns.splice(i, 1);
      };
    },
    on: () => () => {},
    // 测试专用：模拟插件卸载，触发已登记的清理
    async runEffects() {
      for (const e of [...effectFns]) {
        const undo = e.fn();
        if (typeof undo === "function") undo();
      }
    },
  };
  // 模拟「宿主缺 plugin 能力」：能力本身不存在，而不是调用时报错
  if (!withPlugin) delete ctx.plugin;
  return ctx;
}

console.log("阶段一 · 插件加载契约测试\n");

await t("导出 name / apply / Config", () => {
  assert.equal(typeof mod.name, "string");
  assert.equal(typeof mod.apply, "function");
  assert.equal(typeof mod.Config, "function");
});
await t("name 为 novel-forge", () => assert.equal(mod.name, "novel-forge"));
await t("Config 补默认值", () => assert.equal(mod.Config({}).verboseStartup, true));

// ── 正常路径 ─────────────────────────────────────────────────────────────
const ctx = makeCtx();
const applyError = (() => {
  try {
    mod.apply(ctx, mod.Config({}));
    return null;
  } catch (error) {
    return error;
  }
})();
await t("apply() 不抛异常", () => {
  if (applyError) throw applyError;
});

await t("随包技能已挂载且隔离用户根", () => {
  const skill = ctx.mounted.find((m) => m.config?.bundledSkillDir);
  assert.ok(skill, "没有找到技能挂载记录");
  assert.equal(skill.config.providerName, "forge-bundled");
  assert.equal(skill.config.includeDefaultRoots, false);
});
await t("注册全部 40 个工具，名字与顺序符合约定", () => {
  assert.deepEqual(ctx.registered.map((t) => t.name), TOOL_NAMES);
});
await t("每个工具都带 output.render（宿主要求）", () => {
  for (const t of ctx.registered) assert.equal(typeof t.output.render, "function", `${t.name} 缺 output.render`);
});
await t("每个工具的 schema 都在加载期通过了 defineTool 校验", () => {
  // 走到这里本身就说明 defineTool 没抛——它对非法 schema 是抛异常而非静默放行。
  for (const t of ctx.registered) {
    assert.equal(t.output.schema.type, "object", `${t.name} 的 output.schema 不是对象根`);
    assert.equal(typeof t.parameters, "object", `${t.name} 缺 parameters`);
    assert.equal(typeof t.execute, "function", `${t.name} 缺 execute`);
  }
});
await t("output.render 存在（宿主要求）", () => {
  assert.equal(typeof ctx.registered[0].output.render, "function");
});
await t("presentCall 走 generic 卡片", () => {
  assert.equal(ctx.registered[0].presentCall({}).card, "generic");
});

const tool = ctx.registered[0];
const result = await tool.execute({ deep: false }, { signal: new AbortController().signal });

await t("healthy=true", () => assert.equal(result.healthy, true));
await t("版本与 loadedAt 正确", () => {
  assert.match(result.version, /^\d+\.\d+\.\d+$/);
  assert.ok(!Number.isNaN(Date.parse(result.loadedAt)));
});
await t("工作区根来自 workspaceRegistry", () => {
  assert.equal(result.workspaceRoot, "C:/fake/workspace");
});
await t("services.reachable 含 tools 与 skills", () => {
  assert.ok(result.services.reachable.includes("tools"));
  assert.ok(result.services.reachable.includes("skills"));
});
await t("services.absent 列出缺失服务", () => {
  assert.ok(result.services.absent.includes("workflowEngine"));
  assert.equal(result.services.absent.includes("tools"), false);
});
await t("detail 带类型标注", () => assert.equal(typeof result.services.detail.tools, "string"));
await t("deep=false 时不带 git 字段", () => assert.equal(result.git, undefined));
await t("deep=true 时带 git 字段", async () => {
  const deep = await tool.execute({ deep: true }, { signal: new AbortController().signal });
  assert.ok(deep.git, "deep=true 应返回 git 字段");
  assert.equal(typeof deep.git.available, "boolean");
});
await t("output.render 渲染出含版本与工作区的文本", () => {
  const blocks = tool.output.render({}, result);
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
  assert.equal(blocks[0].type, "text");
  assert.ok(blocks[0].text.includes("Novel Forge"));
  assert.ok(blocks[0].text.includes("C:/fake/workspace"));
});

// ── 卸载 ─────────────────────────────────────────────────────────────────
await t("effect 已登记清理钩子", () => {
  assert.ok(ctx.effectFns.some((e) => e.label === "novel-forge:tools"));
});
await t("卸载后工具被注销", async () => {
  await ctx.runEffects();
  assert.equal(ctx.registered.length, 0);
});

// ── 降级路径 ─────────────────────────────────────────────────────────────
await t("宿主缺 skills 服务时不崩", () => {
  const c = makeCtx({ withSkills: false });
  mod.apply(c, mod.Config({}));
  assert.equal(c.mounted.filter((m) => m.config?.bundledSkillDir).length, 0);
  assert.ok(c.logs.some(([, m]) => String(m).includes("随包技能")));
  assert.equal(c.registered.length, TOOL_NAMES.length, "缺 skills 不应影响工具注册");
});
await t("宿主缺 plugin 能力时不崩", () => {
  const c = makeCtx({ withPlugin: false });
  mod.apply(c, mod.Config({}));
  assert.ok(c.logs.some(([, m]) => String(m).includes("inject/plugin")));
  assert.equal(c.registered.length, TOOL_NAMES.length, "缺 plugin 能力不应影响工具注册");
});
await t("宿主缺 tools 服务时不崩且不注册", () => {
  const c = makeCtx({ withTools: false });
  mod.apply(c, mod.Config({}));
  assert.equal(c.registered.length, 0);
  assert.ok(c.logs.some(([, m]) => String(m).includes("tools 服务")));
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
