# DeepSeek Harness (DSH) 插件开发技术参考

本文档位于 Novel Forge 根 `docs/`。当前插件包根目录是 `packages/dsh-plugin/`，所以文中的 `lib/index.js`、`lib/client.js`、`skills/` 和 `package.json` 等插件相对路径均相对于 `packages/dsh-plugin/` 解析。

> 目标：让读者在不重读整个 DSH API 的前提下，从零写出一个可用的 DSH 插件。
> 运行时版本：`0.2.0-rc.2`（Cordis `4.0.4`）。
> 全部结论均来自本地文件；每条都给出可核对的文件路径。凡本地无法确证的，均显式标注 **未确认**。

## 目录

1. [插件入口形态](#1-插件入口形态)
2. [注册工具](#2-注册工具)
3. [注册技能](#3-注册技能)
4. [客户端 UI 注入](#4-客户端-ui-注入)
5. [子代理与编排 API](#5-子代理与编排-api)
6. [workflow 工具](#6-workflow-工具)
7. [Agent Team](#7-agent-team)
8. [ralph 工具](#8-ralph-工具)
9. [Goals 与 Jobs](#9-goals-与-jobs)
10. [用户提问与审批](#10-用户提问与审批)
11. [配置、存储、事件](#11-配置存储事件)
12. [package.json 清单参考](#12-packagejson-清单参考)
13. [从零到可用的落地清单](#13-从零到可用的落地清单)

## 关键路径速查

```
DSH 包根             D:\Program software\DSH NEXT\resources\app\node_modules\@deepseek-ai\
参考插件 A (scriptor) C:\Users\liyunxuanyu\.dsh\profiles\story\node_modules\@linfengqaqtat\dsh-scriptor\
参考插件 B (oh-story) C:\Users\liyunxuanyu\.dsh\profiles\story\node_modules\@oh-story\dsh\
Cordis 源码          D:\Program software\DSH NEXT\resources\app\node_modules\@deepseek-ai\cordis\src\
```

> **重要前置事实**：已安装的 `@deepseek-ai/*` 包**不发布可用的 `.d.ts`**（`dsh-package-manifest` 只有 `lib/index.js`，11 字节，纯类型再导出）。
> 每个包的权威文档是 `README.zh.md`（中文），代码里的 JSDoc 注释是第二权威来源。
> `@deepseek-ai/cordis` 例外，发布完整 `src/*.ts` 源码 —— 所以入口契约以 Cordis 源码为最硬证据。

---

## 1. 插件入口形态

### 1.1 权威契约（Cordis 层）

Cordis 支持三种插件入口形态，由 `Plugin` 联合类型定义：

```ts
// cordis\src\registry.ts:92-134
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>

export namespace Plugin {
  export interface Base<T = any> {
    name?: string                                    // 显示名，用于 fiber 诊断与 logger 名
    Config?: StandardSchemaV1<any, T>                 // 标准 schema，插件启动前校验 config
    inject?: Inject                                  // 依赖的服务名数组 / { [svc]: interceptConfig }
    provide?: string | string[]                      // 本插件提供的服务名
    intercept?: Dict<boolean>                        // 声明本插件消费哪些服务的 intercept config
  }
  export interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any }
  export interface Constructor<T = any> extends Base<T> { new (ctx: Context, config: T): any }
  export interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any }
}
```

`Context` 是 Proxy，属性读取走服务解析器；核心成员（`cordis\src\context.ts:16-33`）：

```ts
export interface Context {
  [symbols.isolate]: Dict<symbol>      // 服务名 → scope 标签
  [symbols.intercept]: Dict            // 服务名 → 该服务 per-plugin config 的合并值
  root: this
  baseUrl?: string
  events: EventsService                // 事件总线；方法也 mixin 到 ctx（ctx.on / ctx.emit / ctx.waterfall）
  logger: LoggerService                // ctx.logger('name')
  reflect: ReflectService              // ctx.get / ctx.provide
  registry: RegistryService            // ctx.plugin / ctx.inject
}
```

`RegistryService.plugin` 的运行时规则（`cordis\src\registry.ts:316-336`）：

- `resolve(plugin)`：函数直接用；对象取 `.apply`；都没有则抛 `invalid plugin, expect function or object with an "apply" method`。
- `name === 'apply'` 时 `name` 被丢弃（`registry.ts:325`），所以**要导出具名 `name` 常量**，不能靠 `apply.name`。
- 返回 `Fiber & PromiseLike<Fiber>`，`await` 它会在加载完成后 settle（配置或启动错误则 reject）。

### 1.2 DSH 的标准写法（具名导出 + schemastery Config）

这是 DSH 全部内建插件的统一形态。逐字摘录 `@deepseek-ai/dsh-tool-workflow`
（`dsh-tool-workflow\lib\index.js:60-70` 与末尾 `:437`）：

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "tool-workflow";                                  // Cordis 插件名
const inject = ["tools", "workflowEngine", "systemPrompt"];     // 依赖的服务
const Config = z.object({                                       // schemastery schema
  toolName: z.string().default("workflow"),
  maxResultChars: z.natural().min(1).default(5e4),
  enableRunInBackground: z.boolean().default(true)
});

function apply(ctx, config) {
  ctx.tools.register(defineTool({ /* ... */ }));
}

export { Config, apply, inject, name };
```

另一处最小实证 —— `@deepseek-ai/dsh-subagent-spawn-in-process\lib\index.js` 全文：

```js
const name = "subagent-spawn-in-process";
const inject = ["subagents"];
const Config = z.object({ providerName: z.string().default("spawn") });

function apply(ctx, config) {
  ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName));
}

export { Config, apply, inject, name };
```

**结论：DSH 插件 = 导出 `{ name, inject, Config, apply }`。**
`Config` 是标准 schema（schemastery 产出 Standard Schema V1），插件启动前用它校验 `cordis.patch.yml` 里的 `config:`。

### 1.3 服务类插件（当你要提供新服务时）

继承 Cordis `Service`（`dsh-storage\lib\index.js:104-138`）：

```js
import { Service } from "@deepseek-ai/cordis";

export class Storage extends Service {
  backend = new BackendRegistry();
  forms = new Map();

  constructor(ctx) {
    super(ctx, "storage");          // ← 服务名在这里固定
  }
  mount(form, facility) { /* ...；返回 disposer */ }
  form(form) { /* ... */ }
  get domain() { return this.form("domain"); }
}
```

类插件也可以带静态 `inject`（`dsh-settings\lib\types\index.js:186`）：

```js
export class SettingsForms extends Service {
  static inject = ['configEditor', 'profileContext'];
  constructor(ownerContext) { super(ownerContext, 'settings'); }
}
```

### 1.4 `ctx.inject` / `ctx.plugin` / `ctx.effect`

Cordis 提供的（`cordis\src\registry.ts:164-186`）：

```ts
ctx.inject(deps: Inject, callback: (ctx, config) => void): Fiber & PromiseLike<Fiber>
ctx.plugin(plugin: Plugin, ...config): Fiber & PromiseLike<Fiber>
```

- `ctx.inject(deps, cb)` 是 `ctx.plugin({ inject, apply: cb })` 的简写，**依赖一变就卸载并重跑回调**。
- `ctx.effect(fn, label)` 在插件卸载时执行 `fn` 的返回值作为清理。scriptor 的封装写法（`lib\index.js:27361-27372`）：

```js
function step(ctx, label, execute) {
  const host = ctx;
  if (typeof host.effect !== "function") { execute(); return; }
  host.effect(() => {
    const undo = execute();
    return typeof undo === "function" ? undo : () => {};
  }, label);
}
```

### 1.5 参考插件的 apply() 长什么样

`@linfengqaqtat/dsh-scriptor` 的 `apply`（打包后的 `lib\index.js:27455` 起）没有 `Config`，直接裸用 `ctx`：

```js
function apply(ctx) {
  ctx.logger.info("工作台插件已加载（webnovel bundle）");
  const bundledSkillDir = fileURLToPath(new URL("../skills/", import.meta.url));
  if (typeof ctx.inject !== "function" || typeof ctx.plugin !== "function") {
    ctx.logger.warn("[webnovel-bundle] 随包技能未挂载：宿主缺少 inject/plugin 能力，请核对 DSH 版本。");
  } else if (!existsSync28(bundledSkillDir)) {
    ctx.logger.warn(`[webnovel-bundle] 随包技能未挂载：安装包缺少技能目录 ${bundledSkillDir}`);
  } else {
    ctx.inject(["skills"], (scope) => {
      scope.plugin(skillFilesystem, {
        providerName: "webnovel-bundled",
        includeDefaultRoots: false,
        bundledSkillDir,
      });
    });
  }
  // … 用 ctx.inject(['agents', …]) 挂工具、监听 agent/created 等
}
```

> 关键模式：`ctx.inject(['skills'], scope => scope.plugin(skillFilesystem, {...}))`
> 把 `dsh-skill-filesystem` **作为子插件**在本地作用域再挂一次，配置只作用于本作用域，与全局 provider 并存。
> 这是「随包技能」的标准做法。

---

## 2. 注册工具

### 2.1 服务与 API

服务键是 `ctx.tools`（`ToolRuntime`）。核心 API（`dsh-tools\lib\index.js:2872-2923, 3023, 3116`）：

```ts
tools.register(definition): Disposer      // 全局注册；重复名与保留名 run_code 抛错
tools.restrict({ allow?, deny? }): Disposer
tools.get(name, scope?)
tools.schemas(scope?)                     // 可见 schema（不含 execute）
tools.guard(guard): Disposer
tools.execute(exec)                       // 直接执行一个 tool call
```

`register` 的运行时校验（`dsh-tools\lib\index.js:2878-2887`）：

- `output` 必须是对象且含函数 `render`（`presentationMeta?` 可选）——**没有 `output.render` 会直接 TypeError**。
- `output.schema` 必须落在受支持的 JSON Schema 子集内（`assertSupportedJsonSchema`）。
- `name === 'run_code'` 是 PTC 保留名，不能注册或遮蔽。
- 同一层内重名失败；**作用域注册会遮蔽全局注册**。

`restrict` 的限制（`dsh-tools\lib\index.js:2895-2909`）：

- **必须**在有作用域的上下文（`agent.ctx`）调用，否则抛错：
  `tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead`。
- `{}` 是 no-op，抛错；未知工具名抛错并列出已知全局工具。

### 2.2 `defineTool` 的完整选项

`defineTool(options)`（`dsh-tools\lib\index.js:838-874`）：

| 选项 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | 模型可见名。snake_case 惯例。 |
| `description` | ✅ | 模型可见描述。 |
| `parameters` | ✅ | **参数 schema spec**（`ParameterSchemaSpec`），**不是 schemastery**。见 §2.3。 |
| `output.schema` | ✅ | 值 schema spec，转成 JSON Schema 校验返回值。 |
| `output.render(args, value)` | ✅ | 把返回值渲染成给模型的内容块数组。 |
| `output.presentationMeta(args, value)?` | ❌ | 附加展示元数据。 |
| `execute(args, exec)` | ✅ | `async`；`args` 已按 `parameters` 校验，违规抛 `ToolArgsError`。 |
| `presentCall(args)?` / `presentResult(args, result)?` | ❌ | Host 本地展示转换器。 |
| `timeoutMs?` | ❌ | **仅声明，注册表绝不强制执行**；需自行包 `@deepseek-ai/dsh-tool-call-timeout-policy`。 |
| `isConcurrencySafe?` | ❌ | 并行安全属性。 |
| `deferLoading?` | ❌ | `true` 表示延迟加载工具定义。 |
| `projectContent?(exec, result)?` / `finalizeContent?(exec, result)?` | ❌ | 图文内容投影钩子。 |

### 2.3 参数 schema 写法（关键：不是 schemastery）

`parameters` 走 `parameterSchemaSpecToJsonSchema`（`dsh-tools\lib\index.js:848`），
是一个**手写的 JSON-Schema 子集 spec**，字段用 camelCase 的描述性对象：

```js
parameters: {
  path:  { type: 'string', required: true, description: 'Absolute file path' },
  limit: { type: 'number' },
  items: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,               // 强制：未知键在 schema 层直接失败
      properties: {
        status: { type: 'string', required: true, enum: ['a', 'b'], description: '...' }
      }
    }
  }
}
```

支持的类型（`dsh-tools\README.zh.md:60`）：`string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、
仅供作者使用的 `json`、恰好匹配一个分支的 `oneOf`。`InferValue` 在 16 层容器内保留精确类型，之后加宽为 `JsonValue`。

> **易错点**：`Config` 用 schemastery（`z.object`），`parameters` 用 JSON-Schema spec。两者不要混。

### 2.4 最小可运行工具（逐字取自真实包）

`@deepseek-ai/dsh-tool-todo\lib\index.js:11-12, 78-99, 120-193` 精简：

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
const Config = z.object({ allowParallelInProgress: z.boolean().required() });

function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "todo_write",
    description: "Record and update a task list to plan multi-step work…",
    parameters: {
      todos: {
        type: "array",
        required: true,
        description: "The COMPLETE task list, replacing any previous list.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            content: { type: "string", required: true, description: "What the task is." },
            status: { type: "string", required: true, enum: ["pending","in_progress","completed"], description: "…" }
          }
        }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          todos: { type: "array", required: true, items: { /* 同上形状 */ } },
          counts: {
            type: "object", additionalProperties: false, required: true,
            properties: {
              pending:     { type: "integer", required: true },
              inProgress:  { type: "integer", required: true },
              completed:   { type: "integer", required: true }
            }
          }
        }
      },
      render: (_args, value) => ([{ type: "text", text:
        `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.` }]),
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error("todo_write requires an owning agent session");
      // exec.agent.session.append("todo/write", { todos })  ← 持久化到会话日志
      return Promise.resolve({ todos: args.todos, counts: { pending: 1, inProgress: 0, completed: 0 } });
    },
    presentCall: (args) => ({ card: "generic", title: "Update todo list", kind: "other", rawInput: args.todos }),
  }));
}

export { Config, apply, inject, name };
```

### 2.5 `execute(args, exec)` 的 `exec` 字段

来自 `dsh-scriptor\lib\index.js:27441-27454`（它显式列出了它用到的全部宿主字段）：

```ts
exec: {
  agent, arguments, callId, rootCallId, token,
  name,                 // 工具名
  parent,               // 父 transport exec（顶层调用时缺省）
  signal,               // AbortSignal
  deferContext,         // 推迟渲染上下文
  concludeTurn,         // 结束当前轮次
}
```

`exec.signal` 是所有循环/IO 的中止来源。scriptor 在 workflow 注册时就是靠它桥接取消（`dsh-tool-workflow\lib\index.js:418-430`）。

### 2.6 插件级 vs per-agent 注册

scriptor 演示了两种模式的组合（`lib\index.js:27547-27566`）：

```js
function registerToolsInto(agent) {
  const registry = agentCtxGet(agent, "tools");           // 从 agent.ctx 取注册表
  if (registry === undefined || typeof registry.register !== "function") return false;
  const offs = [];
  for (const tool of toolKit.defs) {
    const off = registry.register({
      name: tool.name, description: tool.description,
      parameters: tool.parameters, output: tool.output,
      execute: async (args, exec) => tool.execute(args, toExecContext(exec)),
    });
    if (typeof off === "function") offs.push(off);
  }
  agentToolOffs.set(agent.id, offs);
  return true;
}
```

要点：

- 在 `apply()` 里拿 `ctx.tools` 注册 = **全局注册**，所有 agent 可见。
- 在 `agent.ctx.tools` 注册 = **作用域注册**，遮蔽同名全局工具。
- 监听 `agent/created` / `agent/disposed` 事件把工具挂到每个 agent 上：

```js
const offCreated  = ctx.on("agent/created",  (payload) => { installFor(payload.agent); });
const offDisposed = ctx.on("agent/disposed", (payload) => { detachAgent(payload.agent); });
```
（`dsh-scriptor\lib\index.js:27680-27690`）

- 反向做法：给子 agent **撤掉**全局工具 —— `tools.restrict({ deny: [...] })`，并对子 agent 强制
  `approval.setPolicy(agent, 'never')`（`dsh-scriptor\lib\index.js:27585-27609`）。

---

## 3. 注册技能

### 3.1 两个包、两个角色

| 包 | 服务键 | 职责 |
|---|---|---|
| `@deepseek-ai/dsh-skill` | `ctx.skills` | 注册表：合并多个提供方的目录、裁决重名、按需加载正文 |
| `@deepseek-ai/dsh-skill-filesystem` | 子插件 | 本地磁盘提供方：扫描根目录、解析 frontmatter、watch |

（`dsh-skill\README.zh.md`、`dsh-skill-filesystem\README.zh.md`）

### 3.2 `ctx.skills` 注册表 API

（`dsh-skill\README.zh.md`「注册表提供什么」节 + `dsh-skill\lib\index.js:147, 193`）

```ts
skills.registerProvider(create): Disposer   // 提供方贡献目录；同步注册，返回 disposer
skills.register(skill): Disposer            // 直接注册「内存 skill」，不落盘
skills.list(options) / snapshot(options)    // 合并后的、调用策略中立的摘要，按名排序
skills.get(name, ...)                       // 按名加载完整正文
```

调用策略（`invocation`）决定谁能调用（`dsh-skill\README.zh.md`）：

| 策略 | 模型目录 | 用户命令 |
|---|---|---|
| `{ modelInvocable: true, userInvocable: true }` | 包含 | 包含 |
| `{ modelInvocable: true, userInvocable: false }` | 包含 | 排除 |
| `{ modelInvocable: false, userInvocable: true }` | 排除 | 包含 |
| `{ modelInvocable: false, userInvocable: false }` | 排除 | 排除 |

`register()` 会为省略的 `invocation` 与 `runtime` 提供方标签补默认值（默认都是 `true`，
见 `dsh-skill\lib\index.js:203-206`）。非布尔值会抛
`TypeError('<subject> with a non-boolean invocation.modelInvocable')`（`:504-509`）。

### 3.3 随包技能的机制（scriptor 用的正是这个）

`dsh-skill-filesystem` 的 `Config`（`dsh-skill-filesystem\lib\index.js:31-43`）：

```js
const Config = z.object({
  providerName: z.string().min(1).default("filesystem"),
  includeDefaultRoots: z.boolean().default(true),
  dshHome: …,            // $DSH_HOME 或 ~/.dsh
  agentsHome: …,         // $DSH_AGENTS_HOME 或 ~/.agents
  customSkillDirs: …,    // string[]
  watch: …,              // 默认 true
  bundledSkillDir: z.string(),   // ← 关键
  // 另有 watch* 系列字段（chokidar 调参：轮询、稳定窗口、间隔、项目上限、符号链接跟随）
});
```

`bundledSkillDir` 按 **rank 600** 加入扫描；默认根 rank 顺序（`dsh-skill-filesystem\README.zh.md:48-56`）：

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundledSkillDir` | 插件自带的 `skills/` 目录 |

`includeDefaultRoots: false` 会**省略项目根、用户根与 `$DSH_BUNDLED_SKILL_DIR`**
（`dsh-skill-filesystem\lib\index.js:84-85`），所以「随包技能」插件通常配
`includeDefaultRoots: false` + `bundledSkillDir`，做到隔离。

**所以 `@linfengqaqtat/dsh-scriptor` 的 `package.json` 里没有 `dsh.skills` 字段，是完全正确的**：
它在 `apply()` 里把 `bundledSkillDir` 解析为 `new URL('../skills/', import.meta.url)`，再用
`ctx.inject(['skills'], scope => scope.plugin(skillFilesystem, {...}))` 挂载。
`files` 数组里的 `"skills/**/*"` 只负责**打包**。

### 3.4 目录约定（精确）

> 来源：`dsh-skill-filesystem\README.zh.md:36, 148` 与 `lib\index.js:550-556, 587`

- ✅ `<root>/<name>/SKILL.md` —— 目录 bundle
- ✅ `<root>/<name>.md` —— 平铺文件
- ❌ **刻意不支持**嵌套的 `**/SKILL.md`（发现深度为 1 层）

因此插件的 `skills/` 目录**不能嵌套一层再放 SKILL.md**。像 scriptor 那样：

```
skills/
  novel-outline/SKILL.md
  novel-outline/scripts/xxx.md      ← 资源文件，不是另一个 skill
  novel-review/SKILL.md
  novel-review/底本/xxx.md          ← 资源文件
```

资源目录 `scripts/`、`references/`、`assets/` 不参与发现，且**会被监视器忽略**
（`dsh-skill-filesystem\README.zh.md:81`）：改这些文件不触发目录刷新。
SKILL.md 正文本身靠「每次加载重读文件」保证新鲜（`README.zh.md:42`）。

### 3.5 SKILL.md frontmatter（必需 / 可选）

解析代码：`dsh-skill-filesystem\lib\index.js:664-702`。

```yaml
---
name: novel-outline                  # 必需，必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/（kebab-case）
description: 当会话处于…时使用——…   # 必需
whenToUse: 可选                       # 可选字符串
metadata: 可选                         # 可选对象
disable-model-invocation: false       # 可选布尔；true 则不进模型目录与 loader
user-invocable: false                 # 可选布尔；false 则不进用户命令
---
```

规则细节：

- 名字正则：`dsh-skill\lib\index.js:17` → `const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`。
- 两个布尔键接受 YAML 布尔，以及不区分大小写的 `true/false`、`yes/no`、`on/off`、`1/0`；
  **非法拼写会让整个 skill 被丢弃并告警**，不会静默放行某个接口（`dsh-skill-filesystem\README.zh.md:38`）。
- 旧 camelCase 键 `disableModelInvocation` / `modelInvocable` / `userInvocable` 会被显式拒绝
  （`lib\index.js:850-852`）。
- 缺 frontmatter / 缺 name 或 description / 名字非法 → 该文件被跳过并 `ctx.logger.warn`
  （`lib\index.js:672-688`）。

真实 frontmatter（`@linfengqaqtat\dsh-scriptor\skills\novel-outline\SKILL.md` 逐字）：

```yaml
---
name: novel-outline
description: 当章节面位置为 章细纲(待定位/待确认) 或 写作备料 时使用——确认章细纲落真源(design(chNNNN) 整批提交)并组装材料包,把一章备齐到可开写。
disable-model-invocation: false
user-invocable: false
---
```

> 注意 `user-invocable: false` —— 这类技能只供模型自动调用，不出现在用户命令列表。

---

## 4. 客户端 UI 注入

### 4.1 `dsh.client` 的字段与校验

解析器 `parseDshClient`（`dsh-client-modules\lib\index.js:61-75`）给出精确契约：

```ts
dsh.client = {
  platform: string                  // 必需，必须是字符串
  inject?: string[]                 // 浏览器侧依赖包名数组
  external?: string[]
  immediately?: boolean
}
```

校验失败信息形如 `client-modules: <pkg> dsh.client.inject must be a string array`。

**`dsh.client.inject` 的语义**：它是**浏览器端 lazy CJS 模块表的依赖列表**。
宿主侧 Loader 扫描到该声明后，把 `inject` 里的包 + `./client` 子路径一并纳入 bundle 图；
浏览器端 `__ModuleLoader__` 只注册 factory，`factory(require)` 时才真正求值（含 CSS 注入副作用）。
（`dsh-client-modules\lib\index.js:7-31`）

> 结论：`inject` 列表 = 「我的 `lib/client.js` 会 `require` 的 DSH 客户端包」。
> 必须列全，否则运行时会抛「模块未注册」。

### 4.2 `lib/client.js` 是什么

两个参考插件都导出 `./client` 子路径（`package.json` 的 `exports`）：

```json
"exports": {
  ".": "./lib/index.js",
  "./client": "./lib/client.js",
  "./package.json": "./package.json"
}
```

`lib/client.js` 是一个**浏览器侧 Cordis 插件 bundle**（默认导出 `apply(ctx)`，可挂 React 组件）。
scriptor 的 `lib/client.js` 里直接出现 `ctx.inject([...], ...)`、`ctx.slots.inject(...)`、
`ctx.sidebarRightTabs.register(...)`、`ctx.effect(...)`。

### 4.3 Slot 系统与已知 slot 名

`@deepseek-ai/dsh-client-ui-slots` 提供纯注册表 `SlotCore`（`lib\index.js:47`），
由 runtime `Service` 包装成 `ctx.slots`。核心 API：

```ts
slots.register({ name, id?, order?, label?, priority?, inject? }, Component): Disposer
slots.inject(slotName, (scope) => { … })        // 对某个 slot 声明内容（scriptor 实际用法）
slots.registerFactory({ name, children, store? }, Component)
slots.entriesOfSlot(name) / slots.onEntryError(...)
```

`root` slot 是唯一「先验声明」的，由框架在 `SlotCore` 构造时 seed（`lib\index.js:64-72`）。

已从真实代码读到的 slot 名：

| Slot 名 | 用途 | 出处 |
|---|---|---|
| `sidebar.right.pane.tab` | 右侧栏面板的 tab 内容区 | `dsh-client-ui-sidebar-right\lib\client.js:9201` |
| `sidebar.right.pane.tab.title` | 右侧栏 tab 的标题区 | 同上 `:9218` |
| `conversation.session.header.corner` | 会话 header 角落（工具组右缘） | `dsh-client-ui-sidebar-right\README.zh.md:57` |
| `tool.call.toolview` | 工具调用卡片 renderer | `dsh-tools\README.zh.md:91` |
| `conversation.view` | 会话主视图（整块覆盖） | `dsh-scriptor\lib\client.js:1483` |
| `conversation.input.right` | 输入框右侧 | `dsh-scriptor\lib\client.js` |
| `shell.overlay` | 覆盖层 | `dsh-scriptor\lib\client.js` |
| `root` | 框架预声明的渲染根孔位 | `dsh-client-ui-slots\lib\index.js:65-72` |

> **未确认**：`dsh-client-ui-*` 各包的**完整** slot 名清单无法从已安装文件穷举确定
> （这些包没有 README，也没有源码，只有压缩后的 `lib/client.js`）。
> 可靠做法：**直接 grep 你要挂的那个包的 `lib/client.js` 里的 `name: "…"` 字面量**，
> 或 grep 现成插件的 `lib/client.js`。scriptor 的做法就是后者。

### 4.4 完整可抄的 client 片段（取自 scriptor，逐字）

scriptor 注册一个右侧栏面板 + 一个会话视图 slot（`lib\client.js:1482-1483`）：

```js
// 1) 右侧栏 tab
ctx.sidebarRightTabs.register({
  id: "webnovel-outline",          // 唯一 id
  kind: "outline",                 // tab 类型
  title: "细纲",                    // tab 标题
  guide: "…",                       // 说明文字
  render: /* (ctx) => ReactElement */ (c) => OutlinePanel(c),
});

// 2) 覆盖会话主视图
ctx.slots.inject("conversation.view", () =>
  ctx.slots.register({
    name: "conversation.view",
    id: "webnovel-visual",
    label: "可视化",
    order: 30,
    inject: () => ({ host: ctx, store, openIndex }),  // 传给组件的 props
  }, MyVisualComponent),
);

// 3) 注册名唯一的固定 slot
ctx.slots.register({ name: "shell.overlay", id: "webnovel-overlay", label: "…", order: 20,
                     inject: () => ({ host: ctx }) }, OverlayComponent);
```

打开 / 关闭面板（同一个 client.js）：

```js
ctx.sidebarRight.openTab("outline");
ctx.sidebarRight.isExpanded();
ctx.sidebarRight.toggleExpanded();
```

> panel 折叠时 DOM 上会出现 `data-sidebar-right-collapsed` / `data-sidebar-right-fullscreen` /
> `data-rightbar-col` 等属性，scriptor 用 `MutationObserver` + `ResizeObserver` 监听它们做布局适配。

### 4.5 依赖声明清单（两个参考插件对比）

| 包 | `platform` | `inject` |
|---|---|---|
| `@linfengqaqtat/dsh-scriptor` | `web` | layout, sidebar-right, conversation, chat, tool, sidebar-documentpreview |
| `@oh-story/dsh` | `web` | client-store, conversation, layout, tool |

> `dsh-client-ui-layout` 提供三栏 grid（含 `[data-rightbar-col]`、折叠/全屏属性），
> `dsh-client-ui-sidebar-right` 提供右侧栏面板宿主，`dsh-client-ui-conversation` 提供会话视图与输入区，
> `dsh-client-ui-chat` 提供聊天界面原语，`dsh-client-ui-tool` 提供工具卡片，
> `dsh-client-ui-sidebar-documentpreview` 提供文档预览。
> **未确认**：`dsh-client-ui-renderer`、`dsh-client-store` 的完整导出面（安装目录里没有它们的 `lib/index.js`，
> 且两个参考插件都未使用）。

---

## 5. 子代理与编排 API

### 5.1 `ctx.subagents` 服务

服务定义在 `@deepseek-ai/dsh-subagent`，注册表实现见 `lib\types\index.js`（`SubagentRuntime`，`:473`）。
核心是**一个服务 + 多个具名提供方**（`dsh-subagent\README.zh.md:80-81`）。

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'   # 提供方名 "spawn"
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

**只挂服务不改变任何行为**；必须同时有提供方 + 委派工具才能委派
（`dsh-subagent\README.zh.md:43`）。

### 5.2 提供方注册（`registerProvider`）

一个提供方就是一个对象。spawn 后端的完整实现（`dsh-subagent-spawn-in-process\lib\index.js`，逐字）：

```js
class SpawnInProcessProvider {
  name;
  capabilities = {
    agentOptions: true,     // 覆盖子 Agent 的提供方/模型/推理强度/输出 token 上限
    outputSchema: true,     // 结构化输出 schema
    depthLimit: true,       // 递归深度上限
    toolFilter: true,       // 子 Agent 工具过滤
    persona: true,          // 子 Agent persona 遮蔽
  };
  inheritsParentContext = false;   // spawn 是全新开始

  constructor(name) { this.name = name; }

  start(request) { return startInProcessRun(request, {}); }

  prepareContinuable() { return Promise.resolve({}); }
}

ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName));
```

服务侧的能力校验（`dsh-subagent\lib\types\index.js:457-471`）：请求里出现的能力若提供方没声明，
**在 `start()` 之前**就抛
`SubagentError('subagent provider "<name>" does not support the "<cap>" capability', 'UNSUPPORTED_CAPABILITY')`。
进程外后端一律声明全 false（`NO_START_CAPABILITIES`，`lib\types\out-of-process.js:49-55`）。

### 5.3 编程方式启动 / 等待结果 / 发消息

真实调用序列（`dsh-tool-subagent\lib\index.js:509-560`，这是最可靠的实证）：

```ts
// 1) 构造启动请求
const request = {
  label: args.description,                              // 观察者可见的名字
  prompt: [{ type: "text", text: args.prompt }],        // 内容块数组
  parent,                                               // 调用方 agent
  agentOptions?,        // { provider?, model?, reasoningEffort?, maxOutputTokens? }
  persona?,
  toolFilter?,
  maxDepth?,
};

// 2) 一次性（one-shot）：await 它直接拿到结果
const result = await ctx.subagents.start(config.provider, { ...request, signal: exec.signal });
// result.stopReason: 'completed' | 'aborted' | 'error' | …
// result.output: 内容块数组；result.structured: 经 schema 校验的结构化值（若声明）

// 3) 可继续（continuable）：拿到稳定 childId，可后续发消息
const { childId } = await ctx.subagents.startContinuable({
  provider: config.provider, label: args.description, request, signal: exec.signal,
});

// 4) 深度
const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth);

// 5) 提供方查询
ctx.subagents.getProvider(name);

// 6) 直接子级发现（不读子级日志、不加载子 agent）
await ctx.subagents.listChildren(parentSessionId, signal?);
```

`result` **从不 reject**：失败以 `stopReason` 兑现（`dsh-subagent\README.zh.md:67`）。
run 的 `dispose()` 必须由调用方执行（每条路径都要）。

发消息与中断（`dsh-subagent\README.zh.md:61-63`）：

- 每个确切在线 agent 可对**直接可继续 child** 使用 `sendMessage()`。
- 驻留的可继续 child 还能对自己的**直接 parent** 使用 `sendMessage()`。
- 正在工作的目标 → **Steer**（在最近 step 边界收到）；空闲目标 → 启动新轮次。
- parent 可随时 `interrupt()` 正在运行的后代，或枚举自己的子级。
- **未确认**：`sendMessage` 的精确方法签名（在 `lib\types\continuation-messages.js` / `client.js`，
  未逐行核到）。

### 5.4 两个进程内后端的差别

| 后端 | `providerName` 默认 | 初始内容 | `inheritsParentContext` |
|---|---|---|---|
| `dsh-subagent-spawn-in-process` | `spawn` | 空对话（全新 Agent），继承 cwd/谱系/提供方/模型/推理强度/输出上限 | `false` |
| `dsh-subagent-fork-in-process` | `fork` | 父级**已完成轮次**的前缀快照 | — |

fork 的边界（`dsh-subagent-fork-in-process\README.zh.md:34-36, 145`）：
初始内容止于父级最后一个 `turn/end`；父级当前进行中的工具调用轮次绝不会被包含；
这是**一次性快照**，此后父级记的内容不再到达子级，不实时共享上下文。

共享机制在 `dsh-subagent-in-process-driver`；两个后端只贡献「提供方注册 + 全新/fork 的决定」。

### 5.5 容量与深度

- `maxActiveSubagents`（`dsh-subagent` 插件配置）默认 `8`，限制**存活的可继续子代理数**。
  容量耗尽时新建/冷恢复以 `ACTIVATION_LIMIT_REACHED` 拒绝（浏览器消息返回
  `subagent/delivery-unavailable`），**不排队**。名额只在当前进程存在。
- `maxDepth` 默认 `1`（Host 的 `subagent` 设置分节）。深度 `0` 禁止该工具委派；`1` 只允许直接子代理。
  工具显式指定的深度（含 `provider-managed`）优先于 Host 设置。修改在下一次委派时生效。

---

## 6. workflow 工具

> 这是 LangGraph 的替代路径。**先读 `dsh-workflow\README.zh.md` 与 `dsh-workflow-ptc\README.zh.md`**。

### 6.1 分层

```
dsh-tool-workflow   ← 拥有「面向模型的 schema + 结果包络 + 系统提示词段」
      ↓ ctx.workflowEngine
dsh-workflow        ← 脚本/运行/结果/事件约定（不含执行）
      ↓
dsh-workflow-ptc    ← 当前执行引擎：在全新 Node PTC 进程里跑脚本
```

一个上下文只能有一个引擎；加载第二个引擎会明确报错（`dsh-workflow\README.zh.md:71`）。

### 6.2 工具调用契约

模型提交三个参数 + 一个开关（`dsh-tool-workflow\README.zh.md:32`）：

| 参数 | 必需 | 说明 |
|---|---|---|
| `meta` | ✅ | 身份数据：`{ name, description, whenToUse?, phases? }` |
| `script` | ✅ | **纯 JavaScript 脚本体** —— 不含 `export const meta` 语句（那是 `meta` 参数） |
| `args` | ❌ | JSON 对象，作为全局变量 `args` 暴露给脚本。**必须是对象**；裸数组要包到字段里 |
| `run_in_background` | ❌ | 仅当 `enableRunInBackground` 生效时存在 |

前台成功返回：

```json
{ "kind": "foreground", "runId": "…", "agentsStarted": 3, "result": <脚本返回值> }
```

向模型渲染为 `workflow "<name>" completed (<count> agent<optional-s>).` + `Return value:` + 美化 JSON。
无法启动的工作流（脚本解析或 meta 校验失败）返回模型可修正的错误。
取消 → `Error: workflow run was cancelled`；失败 → `Error: workflow run failed: <error>`；
**部分输出绝不报告为成功**。

后台立即返回：

```json
{ "kind": "background", "jobId": "workflow-1", "runId": "…" }
```

配置（`dsh-tool-workflow\lib\index.js:66-70`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `toolName` | `workflow` | 注册的工具名 |
| `maxResultChars` | `50000` | 渲染结果上限，超出截断并附提示 |
| `enableRunInBackground` | `true` | 暴露 `run_in_background`；关闭后调用也会被拒绝 |

### 6.3 脚本 API（权威定义在 PTC guest 源码里）

`dsh-workflow-ptc\lib\index.js` 中的 `WorkflowExecution` 构造 VM 全局对象（逐字）：

```js
const globals = {
  agent:    (prompt, opts)       => …,
  parallel: (thunks)             => …,
  pipeline: (items, ...stages)   => …,
  phase:    (title)              => …,
  log:      (message)            => …,
  args,                                  // ← 调用方的 args 对象
};
```

脚本以**顶层 await** 运行，编译为 `(async () => { <body> })()`
（`filename: workflow:<meta.name>`，`lineOffset: -1`）。

#### `agent(prompt, opts?)`

`opts` 只接受这 5 个键（`SUPPORTED_AGENT_OPTIONS`，逐字）：

```js
const SUPPORTED_AGENT_OPTIONS = new Set(["label", "phase", "schema", "provider", "model"]);
const DEFERRED_AGENT_OPTIONS  = new Set(["effort", "isolation", "agentType"]);
```

- `label: string` —— 显示名；不传则取 prompt 第一行，超 48 字符截断加 `…`。
- `phase: string` —— 归到当前 phase；不传则继承 `phase()` 设置的当前值。
- `schema: object` —— **必须是对象根**的 JSON Schema 子集（`assertObjectJsonSchema`）。
  传了就返回**经校验的结构化值**；没传就把子 agent 最终文本块的 `text` 拼成字符串。
- `provider` / `model: string` —— 仅当提供方声明了 `agentOptions` 能力时可用。

返回语义（关键）：

- 子 agent **普通失败** → `agent()` 兑现 `null`（不是抛错），脚本自己处理。
- 但 `schema` 传了而子 agent 没产出 `result.structured` → 也返回 `null`。
- `agent()` **选项误用**（未知键 / 类型错 / schema 越界）→ 抛 `WorkflowError`，**终止整个脚本**（不降级为 `null`）。

#### `parallel(thunks)`

```js
const reviews = await parallel([
  () => agent('Review src/a.ts for correctness'),
  () => agent('Review src/b.ts for correctness'),
])
// → string[]（或 null[]），保持输入顺序
```

- 参数必须是**零参函数数组**；非函数 → `INVALID_ARGUMENT`。
- 每个 thunk 独立 catch：**致命 `WorkflowError` 重新抛出**，普通错误 → 该项为 `null`。
- 并发受 `maxConcurrentAgents` 限制（FIFO 槽位获取，`acquireSlot`）。

#### `pipeline(items, ...stages)`

```js
const out = await pipeline(items, stageA, stageB, stageC)
// stage(value, item, index) => value
```

- **逐项流水线，没有跨 stage 屏障**（注释原文：`per-item stage chains, NO cross-stage barrier`）。
- 每个 item 内串行跑完所有 stage；不同 item 之间并行。
- 单 item 抛错：致命重抛，普通错误 → 该 item 结果为 `null`。
- 至少要有一个 stage，否则 `INVALID_ARGUMENT`。

#### `phase(title)` / `log(message)` / `args`

```js
phase("静态审计");       // 设置当前 phase，后续 agent() 归入此 phase；通知 workflow/phase
log("处理第 3 个文件");   // 纯叙述；通知 workflow/log
```

两者都要求非空字符串。观察者事件**只供观察**，模型永远看不到中间输出。

`args` 是全局变量，直接是调用方传入的 JSON 对象（绝不作为代码求值）。

### 6.4 上限（引擎配置，`dsh-workflow-ptc\README.zh.md:41-49`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `provider` | `spawn` | `agent()` 用的宿主侧 subagent 提供方 |
| `maxConcurrentAgents` | `0` | 并发 `agent()` 上限；`0` 按可用 CPU 并行度解析 |
| `maxTotalAgents` | `1000` | 一次运行最多启动的 `agent()` 次数 |
| `maxItemsPerCall` | `4096` | 一次 `parallel()`/`pipeline()` 的条目上限 |
| `syncTimeoutMs` | `5000` | 脚本最初同步片段的 VM 超时 |

消费方可用 `WorkflowStartRequest.subagentProvider` 与 `maxTotalAgents` **下调**单次运行上限，
**脚本钩子不能更改这两项**（`dsh-workflow-ptc\README.zh.md:47`）。

其他硬约束：

- 返回值必须是**无损 JSON**：拒绝嵌套 `undefined`、函数、symbol、BigInt、循环引用、稀疏数组、
  非有限数、Date/Map/类实例、symbol 键属性 → `RESULT_UNSERIALIZABLE`。
  根级 `undefined` 是允许的，会得到 `null`。
- 没有整体超时；取消 = `exec.signal` 桥接到 `run.cancel()`。调用方的截止仍然适用。
- **VM 不是安全边界**；OS 文件策略才约束触达 Node 的代码。程序可见的环境为空。
- 没有 `workflow()` 钩子，**不能嵌套/递归调用工作流**。
- 没有跨子 agent 的 token 预算词汇。
- **上限是协作式的**：辅助函数计数器限制普通脚本，不是 Host 强制的安全配额。

### 6.5 编程方式启动（插件代码里直接跑）

```ts
const run = await ctx.workflowEngine.start({
  script: body,                 // 纯 JS 脚本体
  meta:   { name: "audit", description: "…" },
  args?:  { … },                // 必须是对象
  parent,                       // 每个子 agent 归属给这个 agent
  signal?,
  subagentProvider?,            // 下调覆盖引擎默认
  maxTotalAgents?,              // 下调覆盖引擎默认
});
// run: { id, meta, result, cancel(reason?), dispose() }
// run.result 永不 reject：{ value, stopReason, agentsStarted, error? }
// stopReason: 'completed' | 'cancelled' | 'error'
```

`start()` 在运行存在之前校验 meta 并解析脚本，因此格式错误的请求会立即以**违规清单**失败。
**`dispose()` 必须调用**：它取消剩余工作并等待脚本与子 agent 清理。

### 6.6 事件

`workflow/start` 与 `workflow/end` 为运行配对；
`workflow/phase`、`workflow/log` 携带脚本叙述；
`workflow/agent-start` 与 `workflow/agent-end` 按 `seq` 为每次子 agent 调用配对。
**每个监听器独立隔离**：抛错的监听器只记日志，不饿死同级监听器，也不改变执行。

### 6.7 限制清单

- 仅支持**前台收集**（`dsh-workflow\README.zh.md:127`：后台启动/轮询、spill 句柄、分离收集均暂缓 ——
  但 `dsh-tool-workflow` 已通过 `run_in_background` 补上了任务化后台路径）。
- **没有日志化或恢复**：脚本、子 agent 进度与中间值都不设检查点，进程重启后无法继续运行。
- 没有已保存或嵌套工作流。
- 没有 token 预算词汇。
- 运行由持有方负责，服务不跟踪；每个消费方都必须 dispose 自己启动的运行。
- 跨 realm 错误在脚本内**无法通过 `instanceof Error`** 判定 —— 根据 `name` 与 `code` 等稳定字段分支。

### 6.8 `WorkflowError` code

已知 code（从 PTC guest 源码逐字读到）：`SCRIPT_PARSE`、`INVALID_ARGUMENT`、`UNSUPPORTED_OPTION`、
`UNSUPPORTED_SCHEMA`、`ITEM_CAP`、`AGENT_CAP`、`AGENT_START`、`AGENT_RESULT`、`RESULT_UNSERIALIZABLE`。
另有启动失败、提供方与结果故障、取消相关 code（`dsh-workflow\README.zh.md:90` 提及但未逐字列出）。
**完整 code 字符串全集未确认**（定义在 `dsh-workflow\src\index.ts`，该 src 未随包发布）。

---

## 7. Agent Team

### 7.1 两个包

- `@deepseek-ai/dsh-experimental-agent-team` —— **服务**，服务键 `ctx.agentTeams`。
  提供 roster、持久消息、共享任务板。**本身不带任何工具。**
- `@deepseek-ai/dsh-experimental-tool-agent-team` —— **模型侧工具**，
  `inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']`。

（`dsh-experimental-agent-team\README.zh.md:12, 28`；`dsh-experimental-tool-agent-team\lib\index.js:9-14`）

最小配置：

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'   # ← 团队功能需要持久会话存储
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

### 7.2 提供的 9 个工具

从 `dsh-experimental-tool-agent-team\lib\index.js` 读到的确切工具名与行号：

| 工具 | 行号 | 说明（依据 `POLICY` 与 schema） |
|---|---|---|
| `spawn_teammate` | 243 | 建具名 teammate，`context: 'fresh' \| 'fork'` |
| `send_message` | 296 | 返回 `{ messageId, status: 'accepted' \| 'queued' }` |
| `list_agents` | 323 | 返回成员数组 |
| `wait_agent` | 332 | 返回 `{ timedOut, noProgress? }` |
| `interrupt_agent` | 354 | 返回 `{ previousStatus }` |
| `team_task_create` | 367 | 标题/详情/`blockedBy`/`writeScopes` |
| `team_task_list` | 402 | 任务板列表 |
| `team_task_get` | 446 | 单个任务（含 `revision`、`ready`、`writeScopeWarnings`） |
| `team_task_update` | 459 | 带 revision 的 CAS 更新 |

配置（`lib\index.js:16-19`）：

```js
const Config = z.object({
  freshProvider: z.string().default("spawn"),
  forkProvider:  z.string().default("fork"),
});
```

服务侧配置（`dsh-experimental-agent-team\README.zh.md:49-55`）：

| 字段 | 默认 |
|---|---|
| `maxMembers` | `16` |
| `maxTasks` | `256` |
| `maxPendingMessagesPerMember` | `64` |
| `maxMessageBytes` | `65,536` |
| `disposalTimeoutMs` | `5,000` |

### 7.3 与「普通 subagent」的本质区别

| 维度 | 普通 subagent | Agent Team |
|---|---|---|
| 拓扑 | 一次性委派 / 可继续子级 | 一个 Lead + N 个**具名、扁平、永久** teammate |
| 持久性 | 结果一次结算即弃 | roster / 消息 / 任务**持久化到会话日志**，挺过崩溃与重启 |
| 离线成员 | — | 消息**排队**，成员恢复后送达；未加载成员唤醒后收到消息 |
| 共享状态 | 无 | **共享同一工作目录与文件系统**，编辑对所有成员立即可见 |
| 任务协调 | 无 | 共享任务板：claim / complete / owner / `blockedBy` 依赖 / `writeScopes` |
| 权限 | 任意 | **只有 Lead 能 spawn / reassign / interrupt** |
| 嵌套 | 支持（受 maxDepth 限制） | **不支持**嵌套 Team |
| 名字 | 自动 | 小写唯一，**永不复用**（创建失败也占名） |
| worktree 隔离 | — | ❌ 不提供；write scope 只是**提示**，不是锁 |

Prompt 策略（`POLICY` 常量，`lib\index.js:21-27`）明确要求：仅在用户明确要求时才建 teammate；
把写工作拆成不相交范围；`FS_STALE_VERSION` 时重读并 rebase 再重试；Lead 负责审最终 diff 并跑测试。

> ⚠️ **实验性，无稳定性承诺**（`README.zh.md:205`），且**单进程**——不支持多 harness 进程操作同一 Team。
> 它把每次 roster/任务变化广播给所有已连接浏览器，即使它正在看别的 Session（`README.zh.md:204`）。

---

## 8. ralph 工具

### 8.1 它做什么

`ralph` 跑一个**固定的前台循环**：每个 Round 一个**全新子 agent**，共享工作区，
只把**上一份有界报告**跨 Round 传递。父级对话与先前子 agent 会话**绝不复制**到新 Round。

它是基于 `ctx.workflowEngine` 与 `ctx.subagents` 的**普通插件** —— 不会向 `agent-loop` 添加 Ralph 模式，
也不与同会话的 goal 领域耦合（`dsh-tool-ralph\README.zh.md:61`）。

### 8.2 精确调用契约

模型只提交两个参数（`dsh-tool-ralph\README.zh.md:32`）：

```json
{ "objective": "<不可变目标字符串>", "maxRounds": 8 }
```

- `objective`：必填字符串。
- `maxRounds`：可选数字；部署配置的 `maxRounds` 既是默认值也是**调用覆盖值的上限**。
- 调用**阻塞**到整个运行结算。

终态结果三选一：`complete` / `blocked` / `budget-limited`，
携带最后一份有界报告与已启动的 Round 数。
普通子 agent 失败 → 返回错误，其中标明失败的 Round，并保留上一次成功交接。

### 8.3 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 每个 Round 的结构化输出提供方 |
| `maxRounds` | `256` | 默认值 + 部署上限 |
| `maxHandoffChars` | `16384` | 单份 Round 报告序列化后的最大字符数 |
| `maxResultChars` | `16384` | 返回给父级的完整成功结果最大字符数 |

**提供方硬要求**：必须存在、支持结构化输出、且报告 `inheritsParentContext: false`。
不满足时**在任何 Round 开始前**直接报错（`README.zh.md:47`）。

### 8.4 报告校验规则

- `continue` 状态 → 需要**后续步骤**且**空阻塞文本**
- `complete` 状态 → 需要**证据**且**没有后续步骤**
- `blocked` 状态 → 需要**具体阻塞**
- 无效 / 缺失 / 过大 → 工作流**失败**（不截断、不误认为上限耗尽）

（`README.zh.md:36, 69`）

### 8.5 每个 Round 看到什么

只接收：不可变目标、当前 Round 及其上限、一条「共享工作区是权威状态」指令、
以及上一份结构化交接。**工作区是跨 Round 的长期记忆。**

### 8.6 能否驱动「无人值守多步循环」？

**能，但有严格边界。** 逐条对照限制（`README.zh.md:162-167`）：

| 问题 | 答案 |
|---|---|
| 完全无人值守？ | ✅ 前台阻塞循环，会一直跑到 complete/blocked/maxRounds |
| 进程恢复？ | ❌ **仅前台**，无 job id、无后台收集、无恢复检查点、无调度器、无挂钟时间启动策略 |
| 完成是否可信？ | ❌ **由 worker 自行声明**，无独立评估器/验证器 |
| Round 内扇出？ | ❌ 一个 Round = 一个全新子 agent，无 Round 内扇出/模型切换/fork/模型选提供方 |
| 失败重试？ | ❌ 普通子 agent 失败**终止运行**，不重试 |
| 跨 Round 记忆？ | ⚠️ **共享工作区 + 一份有界报告**；子 agent 结束后未提交的对话推理全部消失 |
| 预算控制？ | ⚠️ 只有 Round 数；无 token / 价格 / 耗时预算 |
| Ralph 在默认组合里？ | ❌ **保持禁用，需显式启用**（`dsh-workflow-ptc\README.zh.md:12, 28`） |

**选型建议**（README 原话，`dsh-tool-ralph\README.zh.md:12, 28`）：
普通长期同会话工作 → `goal` 工具；有界委派与扇出 → `subagent` / `workflow` 工具。
只有「用户明确要求 Ralph 式全新 agent 迭代」才用 ralph。

---

## 9. Goals 与 Jobs

### 9.1 Goal（同会话持久目标）

服务 `@deepseek-ai/dsh-goal`，服务键 `ctx.goals`（`GoalService`），要求组合提供 `ctx.sessionProjections`。
模型侧工具：`@deepseek-ai/dsh-tool-goal`。

**读取**（`dsh-goal\README.zh.md:78-83` 逐字）：

```ts
const view = ctx.goals.get(agent)      // 没有当前 goal 时为 undefined
view.phase                             // 'active' | 'paused' | 'blocked' | 'complete'
view.roundsStarted, view.maxGoalRounds // 续行进度
view.activation                        // 'armed' | 'disarmed' —— 不持久化
```

**动词**：`create` / `edit` / `pause` / `resume` / `complete` / `block` / `clear`。

| 操作 | 作用 |
|---|---|
| `create` | 以目标和 Round 上限启动一个 active goal |
| `edit` | 修改目标和/或 Round 上限，不改变 phase |
| `pause` | 停止自动续行并保留状态 |
| `resume` | 重新开始续行；也用于会话恢复或 fork 后重新启用 active goal |
| `complete` | 标记 goal 已完成并停止续行 |
| `block` | 记录稳定的 blocker 代码与说明 |
| `clear` | 移除当前 goal；其历史保留在会话日志中 |

每个变更都是**事件溯源**：追加持久 `goal/change` 事件（版本 1），携带变更后的完整快照；
`clear` 写带 revision 的 tombstone。每次变更必须携带**精确的** `{ id, revision }`，
陈旧 revision 会得到明确的陈旧视图错误，而不是静默覆盖。

模型侧三个工具（`dsh-tool-goal\README.zh.md:34-38`）：

| 工具 | 作用 |
|---|---|
| `get_goal()` | 读当前 goal；无则 `null` |
| `create_goal(objective, max_goal_rounds?)` | 创建 |
| `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)` | `edit`/`pause`/`resume`/`complete`/`blocked` |

**权限**：create/edit/pause/resume 要求**顶层 agent 当前轮次中存在人类直接消息**；
subagent 或非人类生产方不能创建或编辑 goal。自主 `blocked` 要求同一条件连续达到
`blockedAfterConsecutiveRounds`（默认 `3`）轮。

**重要坑**：`Agent.followup()` 与 `steer()` 在调用方省略 source 时会分配 `{ kind: 'user' }`。
因此**插件、调度器与其他非人类生产方必须显式传入自己的 source**，否则会错误地继承人类权限
（`dsh-tool-goal\README.zh.md:72`）。

`resume` 拒绝持久 `paused` goal，抛 `GOAL_TOOL_RESUME_PAUSED`。
blocked reason 以稳定代码 `model-reported` 持久化。

服务只存状态、不调度工作 —— 续行策略属于 `dsh-goal-round-driver` 等消费方包。

### 9.2 Jobs（后台任务）

约定包 `@deepseek-ai/dsh-jobs` 是**抽象类，直接加载会抛错**
（`dsh-jobs\lib\types\index.js:57-59`）：

```
Error: '@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead'
```

必须加载实现（如 `dsh-jobs-local`）+ 模型侧控制 `dsh-tool-jobs`。

`JobSpec` 最小形状（实证自 `dsh-tool-subagent\lib\index.js:538-554`）：

```ts
const jobId = ctx.jobs.start({
  kind: "subagent",                       // → id 形如 "subagent-1"
  label: args.description,
  owner: parent.id,                       // 归属的 agent/session
  run: () => {
    const controller = new AbortController();
    return {
      cancel: (reason) => controller.abort(reason ?? "…"),
      done:   settleStart(/* Promise */, controller.signal),
    };
  },
  // 可选：pull 源（注册表按自己节奏泵送的非消耗偏移读取器）/ maxBytes（可选字节上限）
});
// start() 返回稳定 id（`<kind>-N`）
```

注册表操作（`dsh-jobs\README.zh.md:88`）：

```
list / get / read / readAt / kill / wait / remove / start / events.subscribe
```

- `read` 推进**模型游标**（消耗式）；`readAt(offset)` **不消耗**，供观察者按绝对字节偏移读。
- 输出环有界；chunk 的 `channel` 为 `stdout` | `stderr`（到模型）或 `log`（只到观察者）。
- `wait(jobId, timeoutMs)` 阻塞到结算或超时。
- `updateProgress(text)` 发布实时进度行到每个投影；结算时封流。
- **归属边界**：任务属于启动它的 agent 会话，其他 agent 无法读写。id 可预测 → 这是**授权**不是保密。
- **启动需要一个已附加的控制器**（`dsh-tool-jobs` 就是控制器）；没加载时 `start()` 失败并指出缺失组件。
- 结算事件遵循 `registered` → 恰一次结算 → `removed` 不变式。
- 已结算记录会一直列出直到被移除，注册表不保留数量上限。

模型侧三个工具（`dsh-tool-jobs\README.zh.md:32-34`）：

- `job_output(job_id, wait?, timeout_ms?)` → `{ text, job }`
- `job_list()` → `PublicJobSnapshot[]`
- `job_kill(job_id, reason?)` → `{ outcome: 'cancellation-requested' | 'already-finished', job }`

配置（`README.zh.md:54-57`）：`waitTimeoutMs` 默认 `30,000`；`maxWaitTimeoutMs` 默认 `600,000`；
`completionDelivery` 默认 `wakeup`（`quiet` 让通知继续待领）；`maxConsecutiveWakes` 未设置即不封顶。

---

## 10. 用户提问与审批

### 10.1 `ctx.userQuestions.ask()` —— 插件代码提问

服务 `@deepseek-ai/dsh-user-questions`，服务键 `ctx.userQuestions`。

```ts
// 阻塞等待答案
const answer = await ctx.userQuestions.ask({
  questions: [ { id, question, header?, options?, multiSelect?, custom?, intent? } ],
  agent,     // 可选。传了就必须是「确切的存活运行时根 agent」
  signal?,   // AbortSignal
});

// 带期限的前台等待；到期返回 { pending: true, callId }
const answer = await ctx.userQuestions.askTimed(request, callId, timeoutMs);
```

（`dsh-user-questions\lib\types\index.js:239, 294`；`attachWait(agent, callId, signal)` 在 `:216-225`）

失败 code：

| code | 含义 |
|---|---|
| `ASK_ABORTED` | signal 已中止 |
| `EMPTY_QUESTIONS` | `questions` 为空 |
| `CALLER_NOT_LIVE` | 传入的 agent 不是注册表的确切实例 |
| `DELEGATED_CALLER` | 该存活 agent **归属于另一个 agent**（子代理不能提问） |
| `BAD_TIMEOUT` | 超时非正安全整数或超 `2_147_483_647` |
| `BAD_INTENT` | `intent` 断言无法表达（`approve` 未指向本问题自身选项，或无 `detail`） |
| `DUPLICATE_WAIT` | 该 callId 已有前台等待 |
| `NO_PROVIDER` | 无 answerer 接受 |

回答语义（`dsh-user-questions\README.zh.md:29`）：

- **单选题**：`custom` 覆盖选中的选项，且 `selected` 为空。
- **多选题**：`custom` 补充 `selected` 中的标签。
- UI 可以把跳过的条目保留为 `{ id, selected: [] }`。

**呈现意图 `intent`**：目前唯一标记是 `plan-review`，`detail` 是待审阅的计划，`approve` 指明表示同意的选项。
`dsh-plan-mode` 在 `exit_plan_mode` 的审阅问题上设置它。

> **子代理不能向用户提问**。若需要某个决定，必须让子代理把未解决的问题写进它的最终结果。
> 边界由**运行时所有权**而非持久 session 谱系决定：带谱系的会话恢复为新根后可正常提问。

### 10.2 `ask_user_question` 工具（模型侧）

`@deepseek-ai/dsh-tool-ask-user`，默认**阻塞模式**；`mode: timed` 需显式配置。

```yaml
# 这是插件条目，不是顶层 --patch 条目
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 120     # 秒；-1 = 无限期
```

模型提交形状（`dsh-tool-ask-user\README.zh.md:46-60` 逐字）：

```json
{
  "questions": [
    {
      "id": "cleanup",
      "question": "Proceed with the destructive cleanup?",
      "header": "Confirm",
      "options": [
        { "label": "Yes, delete them (Recommended)", "description": "Removes the three stale files." },
        { "label": "No, keep them", "description": "Aborts the cleanup." }
      ]
    }
  ]
}
```

> **`timeout: -1` 绝不表示批准**（`README.zh.md:44`）。超时只表示「没等到答案」，模型必须另行处理。

返回：

```json
{ "answers": [{ "id": "cleanup", "selected": ["Yes, delete them (Recommended)"], "custom": "…" }] }
```

有限时长的 timed 调用到期返回 `{ "pending": true, "callId": "…" }`；
之后到达的回答以用户消息送达，由 `kind: "answer_to_pending_question"`、`tool`、`callId` 标识。

失败字符串包括：`Error: ask_user_question was aborted before the user answered`、
`... requires at least one question`、`... no user-questions answerer accepted the request`、
`DELEGATED_CALLER`（存活子代理）。

### 10.3 审批：`ctx.approval`

服务 `@deepseek-ai/dsh-user-approval`，服务键 `ctx.approval`（`ApprovalService`）。

```js
static Config = z.object({
  policy: z.union(['ask', 'never']).default('ask'),
});
```

策略常量（`lib\types\index.js:15-21` 逐字）：

```js
const OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
export const APPROVAL_POLICIES = ['ask', 'never'];

const NEVER_SENTENCE =
  'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).';
const ASK_SENTENCE =
  'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.';
```

**如何检测审批提示被禁用**：

1. **读策略**：`ctx.approval.effectivePolicy(agent.session)` → `'ask' | 'never'`
   （`ApprovalService` 构造器内 `const effective = (agent) => this.effectivePolicy(agent.session)`，`:65`）。
2. **按 agent 覆盖**：`approval.setPolicy(agent, 'never')`
   —— scriptor 正是用它把所有子 agent 设为 never（`dsh-scriptor\lib\index.js:27585-27594`）。
3. **持久覆盖**：`setApprovalPolicy(session, 'never')` 追加 `approval/policy` 事件到会话日志
   （`lib\types\index.js:46-51`；非法值在改动日志前抛 `TypeError`）。
4. 无 answerer 时 **fail closed** → 返回 `'unavailable'`。

审计记录必须 **turn-enclosed**：审计对必须是 `turn/start` 与其后的 `turn/end` 之间的
`user/approval-request` + `user/approval-outcome`，裸事件追加在两轮之间会在重载时被当作崩溃尾巴静默丢弃
（`hasOpenTurn`，`lib\types\index.js:22-51`）。

> **未确认**：`ApprovalService` 的完整方法列表与具体的事件名（如 `approval/policy-changed`）未逐行核到。

---

## 11. 配置、存储、事件

### 11.1 用户设置：`ctx.settings`

服务 `@deepseek-ai/dsh-settings`，服务键 `ctx.settings`（`SettingsForms`）。
注意：**它面向的是「插件配置的设置表单」，不是任意键值存储**。

```js
static inject = ['configEditor', 'profileContext'];
```

关键成员（`lib\types\index.js`）：

| 成员 | 行号 | 说明 |
|---|---|---|
| `writable: boolean` | 259 | 当前 profile 是否接受表单编辑 |
| `documentPath: string` | 261 | 当前 profile patch 路径（= `configEditor.documentPath`） |
| `prepareDocument(): Promise<string>` | 265 | 定位 profile patch 供原生编辑 |
| `describe(options?): Form[]` | 270 | 读活跃插件的 schema 与实时值（远程调用需 `options.redactSecrets`） |
| `configure(presentation, owner?): Disposer` | 228 | 注册本插件实例的自动页面策略 |
| `async update(ns, patch, expectedRevision?)` | 317 | 写入某 profile entry 的 config |
| `async read(ns, …)` | ~322 | 读（JSDoc `@param ns Profile entry id`） |
| `schema(entry)` | 399 | 该 entry 的 schemastery schema |

`Form` 的字段（`describe` 返回项，`:294-301`）：
`{ autoGenerate, ns, schema, revision, applies: 'live', value, base, user, secrets? }`。

**乐观并发**：写入携带 `expectedRevision`，不匹配抛 `SettingsConflictError`
（`code = 'SETTINGS_CONFLICT'`，含 `expected` / `actual`，`lib\types\index.js:12-30`）。
每次变更发 `settings/document-updated(entryId, revision)` 事件（`:287`）。

> **未确认**：`ctx.settings.read` 的完整参数列表（只读到 `@param ns Profile entry id`）。

### 11.2 配置编辑服务：`ctx.configEditor`

`@deepseek-ai/dsh-config-editor`，服务键 `ctx.configEditor`（`ConfigEditor`）。

```js
static inject = ["loader", "profileContext"];
get documentPath(): string                              // = profileContext.patchPath
entries(): LoaderEntry[]                                // 有唯一 profile patch id 的活跃 entry
configuration(): { entry, inherited, override }[]       // 继承层与显式覆盖层分离
async edit(entry, change: (current, inherited) => next): Promise<void>
```

`edit()` 的流程（`lib\index.js:69-135`）：文件锁（`withFileLock` on profile `package.json`）→ 重读 patches →
reconcile → 校验 → 通过 `waterfall('internal/config')` + `resolveConfig` → 原子写回 YAML
（保留 `tag:yaml.org,2002:js` JS 表达式）→ reconcile；失败时恢复原文件并回滚 reconcile。
若该 entry 的 config 被 home patch 或命令行 overlay 覆盖，抛
`Configuration for "<id>" is overridden by a home patch or command-line overlay`。

> 插件**自己**通常不需要调 `configEditor`。只要写出规范的 `Config` schema，
> `dsh-settings` 会自动发现它并生成可配置表单。

### 11.3 插件自有持久状态

#### 方案 A：`ctx.storage`（结构化，推荐）

`@deepseek-ai/dsh-storage` 提供 hub，服务键 `ctx.storage`（`Storage` 类，`lib\index.js:104-138`）：

```ts
storage.backend.register(name, backend): Disposer   // 注册具名后端；返回的 disposer 只注销，不关闭
storage.backend.get(name)
storage.backend.names()
storage.mount(form, facility): Disposer             // 挂载 data-form
storage.form(form)
storage.domain                                     // 已挂载时的便捷 getter
storageBackendServiceKey(name)                      // → `storage.backend.${name}`（供 ctx.provide）

StorageError(code, message)                         // code: 'duplicate-backend' | 'backend-not-found'
                                                   //       | 'duplicate-mount' | 'form-not-mounted'
```

**hub 本身不做任何 IO** —— 后端拥有介质，data form 拥有语义（`lib\index.js:83-87`）。

后端实现示例（`dsh-storage-json\lib\index.js:547-607` 逐字）：

```js
const name = "storage-json";
const inject = ["storage"];
const Config = z.object({ root: z.string().required() });

function apply(ctx, config) {
  const backend = /* … 用 config.root 建 JSON 文件树后端 … */;
  const unregister = ctx.storage.backend.register("json", backend);
  ctx.effect(unregister);
  ctx.provide(storageBackendServiceKey("json"), backend);   // ← 声明生命周期服务键
}
```

后端契约要点：单位/表名必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`dsh-storage\lib\index.js:79-80`）。
`ctx.provide('storage.backend.json', …)` 让 domain 层能 `ctx.inject` 等待后端注册，避免激活竞态（`:89-99`）。

#### 方案 B：直接用 `ctx.fs` / `node:fs`

对「一本书一个目录 + Markdown 真源」这类场景（scriptor 的做法），直接用文件路径最简单：
scriptor 用 `fileURLToPath(new URL('../skills/', import.meta.url))` 定位随包资源，
用 `ctx.get('workspaceRegistry').list()` 拿工作区根。

### 11.4 事件：发射与监听

Cordis `EventsService` 的方法全部 mixin 到 `ctx`：

```ts
ctx.on(event, listener): Disposer        // 返回的函数取消监听
ctx.emit(event, ...args)
ctx.waterfall(event, payload, initial)   // 可逐级改写 payload
ctx.once(event, listener)
```

跨插件用**带斜杠的事件名**。真实存在的事件（从各包源码读到）：

| 事件 | 含义 | 出处 |
|---|---|---|
| `agent/created` | 新 agent（payload: `{ agent }`） | `dsh-scriptor\lib\index.js:27680` |
| `agent/disposed` | agent 销毁 | 同上 `:27684` |
| `subagent/provider-added` | 提供方注册（payload 为 provider） | `dsh-tool-subagent\lib\index.js:565` |
| `subagent/provider-removed` | 提供方移除（payload 为 name） | 同上 `:568` |
| `workflow/start` / `workflow/end` | 工作流运行配对 | `dsh-workflow\README.zh.md:86` |
| `workflow/phase` / `workflow/log` | 脚本叙述 | `dsh-workflow-ptc\lib\index.js` guest observer |
| `workflow/agent-start` / `workflow/agent-end` | 按 `seq` 配对 | 同上 |
| `goal/changed` / `goal/activation-changed` | goal 变更 / 进程本地 armed 边界 | `dsh-goal\README.zh.md:116` |
| `llm/adapters-updated` | LLM 适配器变更 | `dsh-scriptor\lib\index.js:27482` |
| `skills/change` | 技能目录失效 | `dsh-skill\README.zh.md`（失效节） |
| `approval/policy` | 持久审批策略（`session.append`） | `dsh-user-approval\lib\types\index.js:50` |
| `fs/observed` | 第一方 write/edit 的文件变更 | `dsh-skill-filesystem\README.zh.md:114` |
| `webserver/index-inject` | 客户端注入表 | `dsh-client-modules\lib\index.js:553` |
| `settings/document-updated` | 设置文档变更 | `dsh-settings\lib\types\index.js:287` |
| `app-boot/config-reload` | 配置重载 | 同上 `:196` |

会话级持久事件通过 `agent.session.append(type, data)` 写入（如 todo 的 `todo/write`，
`dsh-tool-todo\lib\index.js:173`），再由投影单元推给客户端：

```js
ctx.sessionProjections.register({
  key: "todos",
  stateSchema: todosProjectionSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type === "todo/write") return event.data.todos;
    if (event.type === "turn/start") return null;
    return state;
  },
  wire: { viewSchema: todosProjectionSchema, view: (state) => state },
  stateVersion: 2,
});
```
（`dsh-tool-todo\lib\index.js:80-94`）

---

## 12. package.json 清单参考

### 12.1 `dsh` 字段的权威类型

`@deepseek-ai/dsh-package-manifest`（`README.zh.md:30-54` 逐字示例）：

```ts
import type { DshClientManifest, DshPackageManifest } from '@deepseek-ai/dsh-package-manifest'

const client: DshClientManifest = { platform: 'web' }
const manifest: DshPackageManifest = {
  name: 'example-dsh-plugin',
  version: '1.0.0',
  engines: { node: '>=24', dsh: '0.1.5-alpha.1' },
  dsh: {
    manifestVersion: 1,
    bundle: { patch: './cordis.patch.yml' },
    client,
  },
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | 包名 |
| `version` | ✅ | 版本 |
| `dsh.manifestVersion` | ❌ | 声明的格式为 `1`，独立于 npm 版本与 Session 格式版本 |
| `dsh.bundle.patch` | ❌ | **一个 patch 文件路径，或有序路径列表**，均相对包根；launcher 按列表顺序作为同一个 bundle 层应用 |
| `dsh.client` | ❌ | 见 §4.1 |
| `engines.node` | ❌ | 与 `engines.npm`、`engines.dsh` 并列；engines 可整体省略 |
| `engines.dsh` | ❌ | 作者声明的兼容 DSH 版本（SemVer 范围，也可精确预发布版） |

另有两个读取方专属字段 `configTrees`、`sessionFormatMigration`、`moduleFallback` 由其它包拥有，
**公共类型不暴露**（`README.zh.md:57`）。

> ⚠️ **兼容性只是声明**：`README.zh.md:93` 明确「当前安装器和加载器**不强制检查**
> `dsh.manifestVersion` 或 `engines.dsh`；声明范围不会拒绝不兼容的宿主」。

### 12.2 `cordis.patch.yml` 最小形态

两个参考插件**逐字相同**（结构一致，只有 id/name 不同）：

```yaml
# @linfengqaqtat\dsh-scriptor\cordis.patch.yml
- insert:
    - id: webnovel
      name: '@linfengqaqtat/dsh-scriptor'
```

```yaml
# @oh-story\dsh\cordis.patch.yml
- insert:
    - id: oh-story
      name: '@oh-story/dsh'
```

即：**顶层必须是 YAML 序列**；元素用 `insert:` 键（无 `id`/`config` 的行）把本包插入组合图。
带配置的写法形如（来自各包 README 的示例）：

```yaml
- insert:
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
      config:
        mode: timed
```

> `ConfigEditor.edit` 会解析该文档时校验「Profile patch must be a YAML sequence」
> （`dsh-config-editor\lib\index.js:96`）。

### 12.3 最小可用 package.json

```jsonc
{
  "name": "@acme/dsh-novel",
  "version": "1.0.0",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-tool"
      ]
    }
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "skills/**/*",
    "cordis.patch.yml"
  ],
  "engines": { "node": "^22.19.0 || ^24.0.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.4",
    "@deepseek-ai/schemastery": "^3.18.4",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/dsh-skill-filesystem": "0.2.0-rc.2"
  }
}
```

### 12.4 两个参考插件的差异对照

| 字段 | `@linfengqaqtat/dsh-scriptor` | `@oh-story/dsh` |
|---|---|---|
| `engines.node` | `^22.19.0 \|\| ^24.0.0` | `>=24.0.0` |
| `peerDependencies` cordis | `4.0.4`（精确） | `^4.0.4 \|\| ^4.0.5-alpha.1` |
| `peerDependencies` dsh 包 | 精确 `0.2.0-rc.2` | 区间 `>=0.2.0-rc.2 <0.2.1-0 \|\| >=0.2.1-alpha.1 <0.2.2-0` |
| `peerDependencies` react | `18.3.1` | `^18.3.1` |
| `peerDependencies` schemastery | ❌ 未声明 | ✅ `^3.18.4 \|\| ^3.18.5-alpha.1` |
| `peerDependencies` zod | ❌ | ✅ `^4.4.3` |
| `types` 字段 | ❌ 无（纯 JS bundle） | ✅ `"./lib/types/index.d.ts"` |
| `exports` 结构 | 纯字符串 | 对象 + `types` 条件导出 |
| `files` 含 skills | ✅ `"skills/**/*"` | ❌ 无技能包 |
| `license` | `GPL-3.0-only` | `MIT` |
| `devDependencies` | 含全部 DSH 包 + esbuild + typescript | 含全部 DSH 包 + typescript 6 |

**必需 vs 可选判定**：

- **必需**（否则插件不生效）：`name`、`version`、`main` 或 `exports["."]`、
  `dsh.bundle.patch` 指向的 patch 文件存在、且 patch 里的 `name: '<你的包名>'` 与包名一致。
- **强烈建议**：`type: "module"`（否则 `import.meta.url` 不可用）、
  `files`（否则 npm 打包会漏掉 `lib/`、`skills/`）、
  `engines.node`、`peerDependencies` 里对 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 的声明。
- **可选**：`dsh.client`（无 UI 则省略）、`dsh.manifestVersion`、`engines.dsh`、`types`、`keywords`、
  `homepage`、`repository`、`bugs`、`publishConfig`、`scripts`。

> **peerDependencies 约定**：`@deepseek-ai/*` 是 DSH 宿主提供的，**必须放 peerDependencies 而不是 dependencies**
> （否则会打包一份副本进 profile `node_modules`，导致 Cordis 服务实例分裂与身份比对失败）。
> `react` / `react-dom` / `zod` 同理。开发期版本放 `devDependencies` 精确锁版本。
>
> **版本范围建议**（oh-story 的做法更稳）：
> `">=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-alpha.1 <0.2.2-0"` 允许同一 minor 内的 patch 升级。

---

## 13. 从零到可用的落地清单

### `package.json`

见 §12.3。

### `cordis.patch.yml`

```yaml
- insert:
    - id: novel
      name: '@acme/dsh-novel'
```

### `lib/index.js`（服务端）

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import skillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
import { fileURLToPath } from "node:url";

export const name = "dsh-novel";
export const inject = ["tools", "skills"];
export const Config = z.object({
  defaultBookRoot: z.string().optional(),
});

export function apply(ctx, config) {
  // 1) 随包技能（隔离，不污染用户根）
  const bundledSkillDir = fileURLToPath(new URL("../skills/", import.meta.url));
  ctx.inject(["skills"], (scope) => {
    scope.plugin(skillFilesystem, {
      providerName: "novel-bundled",
      includeDefaultRoots: false,
      bundledSkillDir,
    });
  });

  // 2) 工具
  ctx.tools.register(defineTool({
    name: "novel_save_chapter",
    description: "Save a drafted chapter into the book's true source as Markdown.",
    parameters: {
      bookId:    { type: "string", required: true },
      chapterNo: { type: "integer", required: true },
      body:      { type: "string", required: true },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false, required: true,
        properties: { path: { type: "string", required: true } },
      },
      render: (_a, v) => [{ type: "text", text: `Saved ${v.path}` }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const root = config.defaultBookRoot ?? ctx.get("workspaceRegistry")?.list()[0]?.path;
      if (!root) throw new Error("no workspace available");
      const path =
        `${root}/books/${args.bookId}/chapters/` +
        `ch${String(args.chapterNo).padStart(4, "0")}.md`;
      const fs = exec.agent?.ctx.get("fs");
      await fs?.write(path, args.body);
      return { path };
    },
    presentCall: (a) => ({ card: "generic", title: "Save chapter", kind: "other", rawInput: a }),
  }));
}
```

### `skills/<name>/SKILL.md`

```markdown
---
name: novel-drafting
description: 当需要为某一章起草正文时使用——读取章细纲与材料包，产出整章草稿。
disable-model-invocation: false
user-invocable: false
---
（正文：主调度手册 + 验收标准 + 失败恢复）
```

### `lib/client.js`（浏览器侧，可选）

```js
export function apply(ctx) {
  ctx.sidebarRightTabs.register({
    id: "novel-outline",
    kind: "outline",
    title: "细纲",
    render: (c) => OutlinePanel(c),
  });
}
```

并把 `dsh.client.inject` 列全它 `require` 的客户端包。

### 调试速查

| 现象 | 排查点 |
|---|---|
| 插件是否加载 | `ctx.logger.info('...已加载...')`；宿主侧看启动日志 |
| 插件为何未激活 | `fiber.inject` 里缺失的服务会阻塞启动（`dsh-app-boot\lib\index.js:3942`） |
| 工具是否可见 | `ctx.tools.schemas(scope)` |
| 技能是否被发现 | 检查 `ctx.skills.list()`；发现失败只 warn，**不会把诊断交给模型** |
| 技能为何没进模型目录 | `disable-model-invocation: true`；或 frontmatter 缺 name/description；或名字非 kebab-case |
| 配置没生效 | `cordis.patch.yml` 里 `config` 可能被 home patch 或命令行 overlay 覆盖（`dsh-config-editor\lib\index.js:122`） |
| 工具没出现在 UI | 检查 `presentCall` 的 `card` 字段；或缺 `dsh-client-ui-tool` 注入 |
| 子代理不能提问 | 子代理不能调用 `ask_user_question`，需把决定写进最终结果 |

---

## 未确认清单（诚实标注）

| 项 | 原因 |
|---|---|
| `dsh-client-ui-*` 各包的**完整** slot 名清单 | 这些包没有 README / src，只有压缩 `lib/client.js`；已确认的 8 个见 §4.3，其余需逐包 grep |
| `dsh-client-ui-renderer`、`dsh-client-store` 的完整导出面 | 安装目录里没有它们的 `lib/index.js`，且两个参考插件都未使用 |
| `WorkflowError` 的完整 code 字符串全集 | 定义在 `dsh-workflow\src\index.ts`，该 src 未随包发布 |
| `ctx.subagents.sendMessage()` 的精确签名 | 在 `lib\types\continuation-messages.js` / `client.js`，未逐行核到 |
| `ctx.settings.read` 的完整参数列表 | JSDoc 只给出 `@param ns Profile entry id` |
| Cordis 是否提供 `ctx.off` | 一律按「`ctx.on` 返回 disposer」写 |
| `ApprovalService` 的完整方法列表与事件名 | 从构造器与常量推得 `effectivePolicy` / `setPolicy` / `request`；`approval/policy-changed` 为推断 |
| `agent()` 的 `provider` / `model` 是否在所有提供方可用 | 需提供方声明 `agentOptions` 能力；脚本无法改引擎级 provider |
| `@deepseek-ai/*` 的 `.d.ts` 类型 | 已安装包未发布可用的 `.d.ts`（只有 `cordis` 有 `src/*.ts`） |
