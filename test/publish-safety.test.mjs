/**
 * 会话安全：本插件**绝不允许**往会话日志里写自定义事件类型。
 *
 * 为什么这条测试必须存在（真机实测，代价是一个会话）：
 * 本插件曾经 append `novelForge/state` 来喂客户端面板。重启 DSH 后那个会话
 * 直接打不开：
 *
 *   failed to observe session "session-028f57a4-…": session contains event type
 *   "novelForge/state" (seq 22) unknown to this harness and not marked
 *   ignorable; refusing to interpret the log — it was likely written by a
 *   newer harness
 *
 * 读回路径是**整份拒读**，不是跳过这一条；而且事件一旦落进 zstd 日志就拔不出来。
 * 宿主自己把这条边界写得很清楚：
 *   dsh-session/lib/index.js:1050  「Downstream (out-of-repo) plugin events are
 *   outside this list by construction; a registration surface for them is
 *   deferred until such a consumer exists.」
 *   dsh-session-persistence/lib/index.js:184
 *     if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw
 * 而 append 的签名（dsh-session/lib/types/index.d.ts:212）**没有任何口子设 ignorable**。
 *
 * 所以：仓外插件写自定义事件 = 毁会话。这条测试把这个结论钉死。
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { apply } from "../lib/index.js";
import {
  publish,
  mergeGates,
  projectionView,
  PROJECTION_KEY,
  PUBLISH_EVENT,
  PUBLISH_BLOCKED_REASON,
} from "../lib/publish.js";

let passed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}`); console.log(`        ${error?.message ?? error}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, "..", "lib");

/** 去掉块注释与行注释，免得注释里提一句 `session.append` 就把测试判失败。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function libSources() {
  return fs
    .readdirSync(libDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ file: f, code: stripComments(fs.readFileSync(path.join(libDir, f), "utf8")) }));
}

console.log("阶段五补 · 会话安全（绝不写自定义会话事件）\n");

// ── 1. 静态：lib/ 里一处 append 调用都不许有 ────────────────────────────
t("lib/ 里没有任何 .append( 调用（写自定义事件会毁掉整个会话）", () => {
  const hits = [];
  for (const { file, code } of libSources()) {
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      if (/\.append\s*\(/.test(line)) hits.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    hits,
    [],
    "以下位置在往会话里 append 事件。宿主对仓外插件事件是**整份拒读**的" +
      "（dsh-session-persistence/lib/index.js:184），append 一次就等于把这个会话写废：\n" +
      hits.join("\n"),
  );
});

t("lib/ 里没有把 novelForge/state 当事件名传出去的地方", () => {
  const hits = [];
  for (const { file, code } of libSources()) {
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      // 允许常量定义（export const PUBLISH_EVENT = "novelForge/state"），
      // 但不许出现在调用参数位置。
      if (/novelForge\/state/.test(line) && !/PUBLISH_EVENT\s*=/.test(line) && !/^\s*[*/]/.test(line)) {
        hits.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], "novelForge/state 又被当成事件名用了：\n" + hits.join("\n"));
});

// ── 2. 运行时：publish() 拿到能用的 session 也不许碰 append ──────────────
t("publish() 即使拿到可用的 session，也一次 append 都不调", () => {
  const calls = [];
  const exec = {
    agent: {
      session: {
        id: "s",
        append(...args) { calls.push(args); return { type: args[0] }; },
      },
    },
  };
  const returned = publish(exec, { bookStatus: { ok: true, finalizedChapterCount: 0 } });
  assert.deepEqual(calls, [], "publish() 调了 session.append —— 这正是毁掉会话的那个动作");
  assert.equal(returned, false, "推不上去就必须如实返回 false，不能假装成功");
});

t("publish() 对残缺/恶意输入不抛异常（推送失败绝不能搞挂工具）", () => {
  const bad = [undefined, null, {}, { agent: null }, { agent: { session: null } }, { agent: { session: { append: "不是函数" } } }];
  for (const exec of bad) {
    assert.equal(publish(exec, { x: 1 }), false);
    assert.equal(publish(exec), false);
    assert.equal(publish(), false);
  }
});

t("publish() 的入参形状不对时也返回 false，不抛", () => {
  const exec = { agent: { session: { append() { throw new Error("不该被调到"); } } } };
  assert.equal(publish(exec, null), false);
  assert.equal(publish(exec, "字符串"), false);
  assert.equal(publish(exec, 42), false);
});

// ── 3. 推不出去这件事必须是**说出来的**，不是装作没有 ────────────────────
t("PUBLISH_BLOCKED_REASON 非空，且说清了是宿主边界而不是我们偷懒", () => {
  assert.equal(typeof PUBLISH_BLOCKED_REASON, "string");
  assert.ok(PUBLISH_BLOCKED_REASON.length > 20, "理由太短，说不清根因");
  assert.match(PUBLISH_BLOCKED_REASON, /ignorable|事件类型|会话/);
});

t("投影视图对空状态返回空对象（界面显示「数据不足」，不伪装成正常态）", () => {
  assert.deepEqual(projectionView({}), {});
  assert.deepEqual(projectionView(undefined), {});
  assert.deepEqual(projectionView(null), {});
});

// ── 4. 投影注册本身要留着：key 在，值恒空 ──────────────────────────────
function makeCtx() {
  const registered = [];
  const services = new Map();
  services.set("tools", { register(def) { registered.push(def); return () => {}; } });
  services.set("skills", { snapshot: () => [] });
  services.set("workspaceRegistry", { list: () => [{ path: "C:/fake/workspace" }] });
  const captured = { projection: null };
  services.set("sessionProjections", {
    register(def) { captured.projection = def; return () => {}; },
  });
  const ctx = {
    registered,
    captured,
    logger: { info() {}, warn() {}, error() {} },
    get: (s) => services.get(s),
    has: (s) => services.has(s),
    plugin() { return { dispose() {} }; },
    inject(deps, cb) {
      if (deps.some((d) => !services.has(d))) return { dispose() {} };
      cb({ logger: ctx.logger, get: ctx.get, plugin: ctx.plugin, effect: ctx.effect, on: ctx.on });
      return { dispose() {} };
    },
    effect(fn) { const undo = fn(); return () => { if (typeof undo === "function") undo(); }; },
    on: () => () => {},
  };
  return ctx;
}

const ctx = makeCtx();
await apply(ctx, {});

t("投影仍然注册了 novelForge 这个 key（面板读到的是「空」而不是「没有」）", () => {
  const p = ctx.captured.projection;
  assert.ok(p, "sessionProjections.register 根本没被调用");
  assert.equal(p.key, PROJECTION_KEY);
  assert.equal(p.key, "novelForge");
  assert.deepEqual(p.init(), {}, "初始状态必须是空对象");
  assert.equal(typeof p.apply, "function");
  assert.ok(p.wire, "wire 是必需的（客户端读的就是它）");
  assert.deepEqual(p.wire.view(p.init()), {});
});

t("apply 仍认得 PUBLISH_EVENT 这个名字（将来宿主开注册面时一处改回）", () => {
  const p = ctx.captured.projection;
  assert.equal(PUBLISH_EVENT, "novelForge/state");
  const next = p.apply({}, { type: PUBLISH_EVENT, data: { bookStatus: { ok: true } } });
  assert.deepEqual(next, { bookStatus: { ok: true } });
  // 别的事件类型必须原样放行，不能改状态。
  const same = { bookStatus: { ok: true } };
  assert.equal(p.apply(same, { type: "tool/result", data: {} }), same);
});

t("mergeGates 按 node 覆盖，保留最后一条（面板闸门列表靠它）", () => {
  const a = [{ node: "chapter.settle", level: "stop", n: 1 }];
  const b = [{ node: "chapter.settle", level: "auto", n: 2 }, { node: "chapter.draft", level: "auto" }];
  const merged = mergeGates(a, b);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((g) => g.node === "chapter.settle").n, 2);
  assert.deepEqual(mergeGates(undefined, b).length, 2);
  assert.deepEqual(mergeGates(a, undefined).length, 1);
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;
