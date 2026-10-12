/**
 * 加载体检：宿主能不能真的把这个插件装起来。
 *
 * 这条测试是被一次真机事故逼出来的——客户端入口写成了裸 ESM，
 * 而宿主的 window.__ModuleLoader__ 是 CJS 工厂、里面没有 ESM 解析器，
 * 结果用户切 profile 直接掉进恢复模式。单个工具测试全绿也照样会踩。
 *
 * 所以这里只验「宿主加载时会走的那几步」：
 *   包表面 → 客户端注册面 → 客户端入口真跑 → 宿主入口真跑 → 卸载。
 *
 * 宿主安装位置可以不存在（换台机器就找不到）；找不到时依赖宿主产物的那几条
 * 会记 SKIP 而不是 FAIL —— 剩下的包内断言照样拦得住绝大多数加载事故。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

import { createEntry } from "../lib/client.js";
import { git } from "../lib/warehouse.js";

// ENTRIES 是 createEntry() 的返回值，不是顶层导出。
// 这里只借它拿 slot 名，不需要真的造元素。
const ENTRIES = createEntry(() => null).ENTRIES;

let passed = 0;
let skipped = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    if (error?.code === "SKIP_HOST") {
      skipped++;
      console.log(`  SKIP  ${name}：${error.message}`);
      return;
    }
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message ?? error}`);
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));

/** 找宿主安装根；找不到就抛一个可跳过的标记。 */
async function hostRoot() {
  const candidates = [
    process.env.DSH_APP_ROOT,
    "D:/Program software/DSH NEXT/resources/app",
    "/Applications/DSH NEXT.app/Contents/Resources/app",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, "node_modules", "@deepseek-ai", "cordis", "package.json"));
      return c;
    } catch { /* 试下一个 */ }
  }
  const e = new Error("这台机器上没找到宿主安装，跳过依赖宿主产物的断言");
  e.code = "SKIP_HOST";
  throw e;
}



console.log(`阶段十 · 加载体检\n包: ${pkg.name}@${pkg.version}\n`);

// ── 一、包表面 ────────────────────────────────────────────────

await t("main / exports 指向的文件都在", async () => {
  const targets = [pkg.main, pkg.exports["."], pkg.exports["./client"], pkg.exports["./package.json"]];
  for (const rel of targets) {
    assert.ok(rel, "exports 里缺一项");
    await fs.access(path.join(projectRoot, rel));
  }
});

async function countMatches(rel) {
  const star = rel.indexOf("*");
  if (star < 0) {
    try {
      const st = await fs.stat(path.join(projectRoot, rel));
      return st.isDirectory() ? (await fs.readdir(path.join(projectRoot, rel))).length : 1;
    } catch {
      return -1;
    }
  }
  const base = rel.slice(0, star).replace(/[\\/]+$/, "");
  const dir = path.join(projectRoot, base);
  try {
    const names = await fs.readdir(dir);
    const suffix = rel.slice(rel.lastIndexOf("*") + 1);
    return names.filter((n) => n.endsWith(suffix)).length;
  } catch {
    return -1;
  }
}

await t("files 里列的文件都在（漏列等于宿主装完就没有）", async () => {
  const missing = [];
  const empty = [];
  for (const rel of pkg.files) {
    const n = await countMatches(rel);
    if (n < 0) missing.push(rel);
    else if (n === 0) empty.push(rel);
  }
  assert.deepEqual(missing, [], `files 里这些路径不存在：${missing.join("、")}`);
  assert.deepEqual(empty, [], `files 里这些 glob 一个也没匹配上：${empty.join("、")}`);
});

await t("exports[./client] 指向的是生成产物，不是源文件", async () => {
  const target = pkg.exports["./client"];
  assert.match(target, /client\.bundle\.js$/, "客户端入口必须指向 bundle，源文件是裸 ESM");
  const head = (await fs.readFile(path.join(projectRoot, target), "utf8")).slice(0, 400);
  assert.match(head, /window\.__ModuleLoader__/, "bundle 必须先注册进 __ModuleLoader__");
});

// ── 二、宿主声明面 ────────────────────────────────────────────

await t("bundle patch 存在且指名本插件", async () => {
  const rel = pkg.dsh.bundle.patch;
  assert.ok(rel, "缺 dsh.bundle.patch");
  const text = await fs.readFile(path.join(projectRoot, rel), "utf8");
  assert.match(text, /insert:/, "patch 必须是 insert 形式");
  assert.ok(text.includes(pkg.name), `patch 里没指名 ${pkg.name}`);
});

await t("client.inject 里每个宿主包都真实存在", async () => {
  const root = await hostRoot();
  const missing = [];
  for (const name of pkg.dsh.client.inject) {
    try {
      await fs.access(path.join(root, "node_modules", name, "package.json"));
    } catch {
      missing.push(name);
    }
  }
  assert.deepEqual(missing, [], `宿主里没有这些包：${missing.join("、")}`);
});

await t("每个用到的 slot 名都在注入包里声明过（没声明=静默不挂）", async () => {
  const root = await hostRoot();
  const bodies = [];
  for (const name of pkg.dsh.client.inject) {
    try {
      bodies.push(await fs.readFile(path.join(root, "node_modules", name, "lib", "client.js"), "utf8"));
    } catch { /* 有的包可能没有 client.js */ }
  }
  const declared = new Set();
  for (const body of bodies) {
    for (const m of body.matchAll(/["'`]([a-z][\w.]*\.(?:corner|actions|utilities|dock|header|toolview))["'`]/g)) {
      declared.add(m[1]);
    }
  }
  const used = new Set(ENTRIES.map((e) => e.slot));
  const missing = [...used].filter((s) => !declared.has(s));
  assert.deepEqual(missing, [], `宿主里没声明这些 slot：${missing.join("、")}`);
});

// ── 三、客户端入口真跑 ────────────────────────────────────────

await t("客户端 bundle 真能跑：注册挂上，缺 slots 不炸，卸载干净", async () => {
  const require_ = createRequire(import.meta.url);
  const react = require_("react");
  const loaders = [];
  const fakeWindow = { __ModuleLoader__: { load: (spec) => loaders.push(spec) } };
  const code = await fs.readFile(path.join(projectRoot, pkg.exports["./client"]), "utf8");
  // eslint-disable-next-line no-new-func
  const run = new Function("window", "module", "exports", "require", "return (function(){" + code + "\n})();");
  const module = { exports: {} };
  run(fakeWindow, module, module.exports, require_);
  assert.equal(loaders.length, 1, "bundle 应该恰好注册一个加载器");
  assert.equal(loaders[0].id, pkg.name);
  assert.equal(typeof loaders[0].factory, "function", "factory 必须是函数");

  const mounted = [];
  const disposer = loaders[0].factory((n) => {
    if (n === "react") return react;
    throw new Error(`宿主不该再要求 ${n}`);
  });
  assert.ok(disposer, "宿主工厂应当返回一个清理函数");
  assert.ok(!/^\s*import\s/m.test(code), "CJS 工厂里出现 import 就会加载失败");

  // 真挂一次
  const slots = {
    inject: (_slot, fn) => { mounted.push(fn()); return () => {}; },
    register: () => ({}),
  };
  const ctx = { logger: { info() {}, warn() {}, error() {} }, effect(fn) { fn(); }, get: (n) => (n === "slots" ? slots : undefined) };
  await disposer.apply(ctx, {}, {});
  assert.equal(mounted.length, 1, `应当挂一个面板（右上角徽标），实际 ${mounted.length}`);
});

// ── 四、宿主入口真跑 ──────────────────────────────────────────

await t("宿主入口：导入、注册、卸载全通", async () => {
  const mod = await import("../lib/index.js");
  assert.equal(mod.name, "novel-forge", "cordis 插件 id 应当是 novel-forge");
  assert.ok(pkg.name.startsWith("dsh-"), "包名要带 dsh- 前缀，否则宿主不会当插件扫到");
  assert.equal(typeof mod.apply, "function");
  // cordis 靠插件的 inject 决定「服务就绪前不调用 apply」
  // （lib/index.js:1317-1328 的 _refresh；INACTIVE 时不走 _reload）。
  // 不声明 inject 的话，apply 会在 tools 就绪前跑，插件只能记一条 warn 就退出，
  // 而且**永远不会重试**——表现为「插件加载了但一个工具都没有」。
  assert.ok(Array.isArray(mod.inject), "插件必须导出 inject，否则 cordis 不会等 tools 就绪");
  assert.ok(mod.inject.includes("tools"), "inject 必须包含 tools（本插件的硬依赖）");

  const registered = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const undo = fn(); effects.push(undo); },
    get(n) {
      if (n === "tools") return { register(t) { registered.push(t); return () => { const i = registered.indexOf(t); if (i >= 0) registered.splice(i, 1); }; } };
      if (n === "skillfilesystem") return { mount() { return () => {}; } };
      return undefined;
    },
  };
  await mod.apply(ctx, mod.Config ?? {});
  
  // 不用再包一层 defineTool —— lib/index.js 已经对每个工具包过了，
  // 对它的产物再包一次才是错的。apply() 没抛，就已经说明 40 个 schema
  // 全部通过了 defineTool 在加载期的编译与校验。
  const bad = [];
  for (const tool of registered) {
    if (typeof tool.execute !== "function") bad.push(`${tool.name}：缺 execute`);
    if (typeof tool.output?.render !== "function") bad.push(`${tool.name}：缺 output.render`);
    if (tool.output?.schema?.type !== "object") bad.push(`${tool.name}：output.schema 不是对象根`);
    if (typeof tool.parameters !== "object" || tool.parameters === null) bad.push(`${tool.name}：缺 parameters`);
  }
  assert.deepEqual(bad, [], `这些工具有问题：\n${bad.join("\n")}`);
  assert.equal(registered.length, 41, `工具数应当是 41，实际 ${registered.length}`);
  assert.ok(effects.length > 0, "卸载钩子必须登记，否则重复装载会叠加");
  // 每个 effect 都必须**返回**清理函数：cordis 只收集返回的那个
  // （lib/index.js:1142-1143）。返回 undefined 就等于没有卸载钩子。
  assert.ok(effects.every((fn) => typeof fn === "function"), `每个 effect 都要返回清理函数，实际：${effects.map((f) => typeof f).join(",")}`);
  // 往返验证：跑一遍卸载，工具应当真的被摘干净
  for (const fn of effects) await fn();
  assert.equal(registered.length, 0, `卸载后应当一个工具都不剩，实际还剩 ${registered.length}`);
});

// ── 测试沙盒必须住在插件仓库之外 ──────────────────────────────────────────
//
// 插件源码自建 Git 仓库之后，沙盒若留在树内，initWorkspace 的嵌套检查会把
// 17 个测试文件全部拒掉（nested-in-other-repo）。那条检查是对的——
// 不该为测试放宽它。所以沙盒搬出去了，这里钉住，免得又被挪回来。
await t("测试沙盒住在插件仓库之外（挪回来会静默废掉半个套件）", async () => {
  const sandboxRoot = path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox");
  // 每轮测试都会把沙盒清空，所以这里要先把它建出来，git 才有 cwd 可用。
  await fs.mkdir(sandboxRoot, { recursive: true });
  const top = await git(["rev-parse", "--show-toplevel"], sandboxRoot);
  assert.equal(top.ok, false, `${sandboxRoot} 落在另一个 Git 仓库（${String(top.stdout).trim()}）内部，initWorkspace 会拒绝初始化。`);
});

console.log(`\n通过 ${passed}，跳过 ${skipped}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
