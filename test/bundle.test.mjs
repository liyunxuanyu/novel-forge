/**
 * 阶段十测试：客户端 bundle。
 *
 * 这一条是被真机打回来的：2026-10-08 code profile 切不过去，
 * 日志是 `web boot: 1 entry did not activate / dsh-novel-forge: import failed`。
 * 根因：客户端入口写成了裸 ESM，宿主的 __ModuleLoader__ 是 CJS 工厂，没有 ESM 解析器。
 *
 * 所以这里不只校验文本，而是**真把 bundle 跑起来**：
 * 造一个 window.__ModuleLoader__，喂真的 react，看它能不能注册上面板。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import path from "node:path";
import { build } from "../scripts/bundle-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(root, "lib/client.bundle.js");

let passed = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message ?? error}`);
  }
}

/** 模拟宿主：window.__ModuleLoader__ 收工厂，工厂拿 require。 */
function loadBundle(code) {
  const loaded = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec);
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function("window", "require", code)(globalThis.window, (id) => {
    if (id === "react") return { createElement };
    throw new Error(`bundle 要求了未提供的模块：${id}`);
  });
  return { loaded, exports: loaded[0].factory((id) => (id === "react" ? { createElement } : (() => { throw new Error(id); })())) };
}

/** 复刻宿主 dsh-client-ui-slots 的校验规则。 */
function makeSlots(declared) {
  const records = new Map(Object.entries(declared).map(([name, kind]) => [name, { kind, entries: [] }]));
  return {
    entriesOf: (slot) => records.get(slot)?.entries ?? [],
    inject(slot, factory) {
      const rec = records.get(slot);
      if (!rec) return { dispose() {} };
      const reg = factory();
      return reg;
    },
    register(options, component) {
      const rec = records.get(options?.name);
      if (!rec?.kind) throw new Error(`slot "${options?.name}" is not declared`);
      if (rec.kind === "list" && options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`);
      rec.entries.push({ ...options, component });
      return { dispose() {} };
    },
  };
}

const DECLARED = {
  "conversation.session.header.utilities": "list",
  "conversation.input.dock": "list",
};

const code = readFileSync(BUNDLE, "utf8");

console.log("阶段十 · 客户端 bundle 测试\n");

await t("产物与源码同步（改了源文件必须重跑打包器）", () => {
  const { code: expected } = build();
  assert.equal(code, expected, "lib/client.bundle.js 已过期，请重跑 node scripts/bundle-client.mjs");
});
await t("bundle 里没有裸 import / export（__ModuleLoader__ 是 CJS 工厂）", () => {
  assert.ok(!/^\s*import\s/m.test(code), "仍有裸 import");
  assert.ok(!/^\s*export\s/m.test(code), "仍有裸 export");
  assert.ok(!/^\s*export\s*\{/m.test(code));
});
await t("bundle 用 window.__ModuleLoader__.load 注册自己", () => {
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(code, /id:\s*"dsh-novel-forge"/);
  assert.match(code, /return module\.exports;/);
});
await t("真跑起来：react 从宿主 require 来，不静态依赖", () => {
  const { loaded, exports: mod } = loadBundle(code);
  assert.equal(loaded.length, 1);
  assert.equal(typeof mod.apply, "function");
  assert.equal(mod.name, "novel-forge-client");
  assert.equal(Array.isArray(mod.ENTRIES), true);
  assert.equal(mod.ENTRIES.length, 1);
});
await t("bundle 出来的 apply 真能挂上面板", () => {
  const { exports: mod } = loadBundle(code);
  const slots = makeSlots(DECLARED);
  const infos = [];
  const ctx = {
    logger: { info: (m) => infos.push(m), warn: () => {} },
    get: (n) => (n === "slots" ? slots : undefined),
  };
  const dispose = mod.apply(ctx);
  assert.equal(slots.entriesOf("conversation.session.header.utilities").length, 1);
  assert.match(infos[0], /1\/1 个面板挂载/);
  assert.equal(typeof dispose, "function");
});
await t("宿主没有 slots 时 bundle 也不炸（工具链不受影响）", () => {
  const { exports: mod } = loadBundle(code);
  const warns = [];
  const ctx = { logger: { info: () => {}, warn: (m) => warns.push(m) }, get: () => undefined };
  let out;
  assert.doesNotThrow(() => { out = mod.apply(ctx); });
  assert.equal(out, undefined);
  assert.match(warns[0], /工具链不受影响/);
});
await t("slot 没声明时不谎报挂上了几个", () => {
  const { exports: mod } = loadBundle(code);
  const infos = [];
  const ctx = {
    logger: { info: (m) => infos.push(m), warn: () => {} },
    get: () => ({ inject: () => ({ dispose() {} }), register: () => { throw new Error("x"); } }),
  };
  mod.apply(ctx);
  assert.match(infos[0], /0\/1 个面板挂载/);
});
await t("重新 require react 不会拿到两个 React 实例", () => {
  const { exports: mod } = loadBundle(code);
  const el = mod.ENTRIES.length;
  assert.equal(el, 1);
  // 组件必须是宿主那个 createElement 造出来的，不能是自带副本
  const slots = makeSlots(DECLARED);
  const ctx = { logger: { info: () => {}, warn: () => {} }, get: (n) => (n === "slots" ? slots : undefined) };
  mod.apply(ctx);
  const entry = slots.entriesOf("conversation.session.header.utilities")[0];
  const node = entry.component({ view: { state: "insufficient" } });
  assert.equal(typeof node.type, "string", "组件确实在造宿主 React 认识的元素");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
