/**
 * Novel Forge —— 融合 Scriptor / oh-story / Biz Novel Studio 三家长篇小说生产能力的 DSH 插件。
 *
 * 宿主侧入口。DSH 通过 cordis 载入本文件，取具名导出 { name, inject, Config, apply }。
 * 浏览器侧入口见 ./client.js。
 */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as skillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
import { warehouseTools } from "./tools-warehouse.js";
import { chapterTools } from "./tools-chapter.js";
import { gateTools } from "./tools-gates.js";
import { directorTools } from "./tools-director.js";
import { fanoutTools } from "./tools-fanout.js";
import { deconstructTools } from "./tools-deconstruct.js";
import { styleTools } from "./tools-style.js";

const execFileAsync = promisify(execFile);

export const name = "novel-forge";

export const Config = z.object({
  /** 启动时是否把宿主服务可达性打进日志。 */
  verboseStartup: z.boolean().default(true),
});

const PLUGIN_VERSION = "0.1.0";

/** 宿主服务名清单，用于 forge_status 报告能力面。 */
const HOST_SERVICES = [
  "tools",
  "skills",
  "fs",
  "llm",
  "settings",
  "storage",
  "workflowEngine",
  "subagents",
  "agentTeams",
  "goals",
  "jobs",
  "userQuestions",
  "approval",
  "workspaceRegistry",
  "embeddings",
  "reranking",
  "sceneSegmentation",
];

function tryGet(ctx, service) {
  try {
    const value = typeof ctx.get === "function" ? ctx.get(service) : undefined;
    return value === undefined || value === null ? null : value;
  } catch {
    return null;
  }
}

function detectWorkspaceRoot(ctx) {
  const registry = tryGet(ctx, "workspaceRegistry");
  if (registry) {
    const list = typeof registry.list === "function" ? registry.list() : [];
    const first = Array.isArray(list) ? list[0] : undefined;
    const path = first?.path ?? first?.root ?? (typeof first === "string" ? first : undefined);
    if (path) return String(path);
  }
  return process.cwd();
}

async function detectGit(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { cwd: dir, timeout: 5000 });
    return { available: true, version: stdout.trim() };
  } catch (error) {
    return { available: false, reason: error?.code === "ENOENT" ? "git 不在 PATH" : String(error?.message ?? error) };
  }
}

function describeValue(value) {
  if (value === null) return "absent";
  if (typeof value === "object") {
    const ctor = value?.constructor?.name;
    return ctor && ctor !== "Object" ? ctor : "object";
  }
  return typeof value;
}

export function apply(ctx, config) {
  const verbose = config?.verboseStartup !== false;
  const loadedAt = new Date().toISOString();
  ctx.logger.info(`[novel-forge] 已加载 v${PLUGIN_VERSION}（${loadedAt}）`);
  if (verbose) {
    const reachable = HOST_SERVICES.filter((service) => tryGet(ctx, service) !== null);
    ctx.logger.info(`[novel-forge] 宿主服务可达 ${reachable.length}/${HOST_SERVICES.length}：${reachable.join(", ") || "无"}`);
  }

  // ── 随包技能 ────────────────────────────────────────────────────────────
  // includeDefaultRoots:false 让插件只认自己的 skills/ 目录，不污染用户的
  // ~/.dsh/skills 与 ~/.agents/skills；rank 600，低于用户级目录。
  const bundledSkillDir = fileURLToPath(new URL("../skills/", import.meta.url));
  if (typeof ctx.inject !== "function" || typeof ctx.plugin !== "function") {
    ctx.logger.warn("[novel-forge] 宿主缺少 inject/plugin 能力，随包技能未挂载；请核对 DSH 版本。");
  } else if (!existsSync(bundledSkillDir)) {
    ctx.logger.warn(`[novel-forge] 随包技能未挂载：安装包缺少技能目录 ${bundledSkillDir}`);
  } else {
    ctx.inject(["skills"], (scope) => {
      scope.plugin(skillFilesystem, {
        providerName: "forge-bundled",
        includeDefaultRoots: false,
        bundledSkillDir,
      });
    });
    ctx.logger.info(`[novel-forge] 随包技能目录已挂载：${bundledSkillDir}`);
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  // tools 服务缺失时不能让整个插件启动失败；降级为只记日志。
  const tools = tryGet(ctx, "tools");
  if (tools === null || typeof tools.register !== "function") {
    ctx.logger.warn("[novel-forge] 宿主缺少 tools 服务，forge_status 未注册。");
    return;
  }

  const tool = defineTool({
    name: "forge_status",
    description:
      "检查 Novel Forge 插件自身与宿主 DSH 环境的健康状况：插件版本、已加载时间、可达宿主服务清单、工作区根目录、Git 可用性、随包技能目录。" +
      "排查插件未加载、能力缺失、书仓定位异常时先调用它。不要用它做与写作无关的通用系统探测。",
    parameters: {
      deep: {
        type: "boolean",
        description: "true 时额外执行一次 Git 版本探测（会起一个子进程，约 10~50ms）。默认 false。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          stage: { type: "string" },
          detail: { type: "string" },
          plugin: { type: "string", required: true },
          version: { type: "string", required: true },
          loadedAt: { type: "string", required: true },
          healthy: { type: "boolean", required: true },
          workspaceRoot: { type: "string", required: true },
          skillDir: { type: "string", required: true },
          skillDirPresent: { type: "boolean", required: true },
          services: {
            type: "object",
            additionalProperties: false,
            required: true,
            properties: {
              reachable: { type: "array", required: true, items: { type: "string" } },
              absent: { type: "array", required: true, items: { type: "string" } },
              detail: { type: "object", additionalProperties: false, required: true },
            },
          },
          git: {
            type: "object",
            additionalProperties: true,
            description: "仅在 deep=true 时出现；缺省表示未探测。",
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Novel Forge v${value.version} — ${value.healthy ? "健康" : "降级"}`,
          `已加载：${value.loadedAt}`,
          `工作区：${value.workspaceRoot}`,
          `技能目录：${value.skillDirPresent ? value.skillDir : `${value.skillDir}（缺失）`}`,
          `宿主服务：可达 ${value.services.reachable.length} 项，缺失 ${value.services.absent.length} 项`,
        ];
        if (value.services.absent.length > 0) lines.push(`缺失：${value.services.absent.join(", ")}`);
        if (value.git) lines.push(`Git：${value.git.available ? value.git.version : `不可用（${value.git.reason}）`}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const detail = {};
      const reachable = [];
      const absent = [];
      for (const service of HOST_SERVICES) {
        const value = tryGet(ctx, service);
        if (value === null) absent.push(service);
        else {
          reachable.push(service);
          detail[service] = describeValue(value);
        }
      }
      const workspaceRoot = detectWorkspaceRoot(ctx);
      const skillDirPresent = existsSync(bundledSkillDir);
      const result = {
        ok: true,
        plugin: name,
        version: PLUGIN_VERSION,
        loadedAt,
        healthy: tools !== null && skillDirPresent && reachable.includes("tools"),
        workspaceRoot,
        skillDir: bundledSkillDir,
        skillDirPresent,
        services: { reachable, absent, detail },
      };
      if (args?.deep) result.git = await detectGit(workspaceRoot);
      return result;
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Novel Forge 自检",
      kind: "other",
      rawInput: args ?? {},
    }),
  });

  // 书仓工具在经 defineTool 后再注册：它在加载期编译并校验 schema，
  // 把写错的 schema 挡在启动时，而不是等模型真的调到这个工具才炸。
  // 宿主自带的 tools.register 不做这层校验。
  // 注意：上面那个 forge_status 已经是 defineTool 的产物，别再包第二层——
  // 编译过的 JSON Schema 不是参数 DSL，二次编译会直接报
  // "parameters.type must be a value schema object"。
  const resolveRoot = () => detectWorkspaceRoot(ctx);
  /**
   * 顶层只保留 ok 必填，领域字段一律「声明但不强制」。
   *
   * 为什么必须这样：失败路径也是一等公民。工具返回
   * `{ ok: false, stage, detail }` 时，chapter / files / batches 这些
   * 领域字段本来就不存在。而宿主的规矩是——只要 isError 为 false，
   * 就拿 output.schema 去校返回值
   * （dsh-tools 的 createSuccessResult → validateJsonSchemaValue），
   * 缺一个 required 字段就抛 ToolOutputError。
   *
   * 于是「结构化失败」变成「抛异常」：作者看到的不是
   * 「章号非法，请改用 1–9999」，而是一句工具内部错误。
   * 本插件 36 个工具、130 个顶层必填字段，条条失败路径都会踩。
   *
   * defineTool 之后 output.schema 已是编译好的 JSON Schema，
   * 所以这里直接改 required，一处覆盖全部工具。
   */
  const relaxTopLevelRequired = (def) => {
    const schema = def?.output?.schema;
    if (!schema || schema.type !== "object" || !Array.isArray(schema.required)) return def;
    const kept = schema.required.filter((k) => k === "ok");
    const next = { ...schema };
    if (kept.length > 0) next.required = kept;
    else delete next.required;
    return { ...def, output: { ...def.output, schema: next } };
  };
  const warehouse = warehouseTools(ctx, resolveRoot).map((def) => defineTool(def)).map(relaxTopLevelRequired);
  const chapters = chapterTools(ctx, resolveRoot).map((def) => defineTool(def)).map(relaxTopLevelRequired);
  const gates = gateTools(ctx, resolveRoot).map((def) => defineTool(def)).map(relaxTopLevelRequired);
  const directors = directorTools(ctx, resolveRoot).map((def) => defineTool(def)).map(relaxTopLevelRequired);
  const fanouts = fanoutTools(ctx, resolveRoot).map((def) => defineTool(def)).map(relaxTopLevelRequired);
  const deconstruction = deconstructTools(ctx, resolveRoot).map((def) => defineTool(def)).map(relaxTopLevelRequired);
  const styles = styleTools(ctx, resolveRoot).map((def) => defineTool(def)).map(relaxTopLevelRequired);
  // forge_status 也过 relax：它同样遵守「顶层只留 ok 必填」的约定。
  const registered = [relaxTopLevelRequired(tool), ...warehouse, ...chapters, ...gates, ...directors, ...fanouts, ...deconstruction, ...styles];
  const disposers = registered.map((def) => tools.register(def));
  ctx.logger.info(`[novel-forge] 工具已注册 ${disposers.length} 个：${registered.map((d) => d.name).join(", ")}`);

  ctx.effect(() => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  }, "novel-forge:tools");
}
