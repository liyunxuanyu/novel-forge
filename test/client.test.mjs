/**
 * 阶段九测试：客户端注册。
 *
 * 假 slots 服务复刻宿主 dsh-client-ui-slots 的真实校验规则
 * （slot 必须已声明；single 不可重复；keyed 需 key；list 需 id）。
 * 这样即使没跑起客户端，也能验证注册描述符不会把宿主顶掉或直接抛错。
 */
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { createEntry } from "../lib/client.js";

const { apply, ENTRIES } = createEntry(createElement);

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

/** 按宿主真实规则实现的假 slots。 */
function makeSlots(declared) {
  const records = new Map(Object.entries(declared).map(([name, kind]) => [name, { kind, entries: [] }]));
  const log = [];
  return {
    log,
    entriesOf: (slot) => records.get(slot)?.entries ?? [],
    inject(slot, factory) {
      const rec = records.get(slot);
      if (!rec) return { dispose() {} };
      const reg = factory();
      log.push({ slot, reg });
      return reg;
    },
    register(options, component) {
      const rec = records.get(options?.name);
      if (!rec?.kind) throw new Error(`slot "${options?.name}" is not declared (a parent entry's children table must declare it)`);
      if (rec.kind === "list" && options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`);
      if (rec.kind === "keyed" && options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`);
      if (rec.kind === "single" || rec.kind === "list") {
        const order = options.order ?? 0;
        if (rec.entries.some((e) => (e.order ?? 0) === order && (rec.kind === "single" || e.id === options.id))) {
          throw new Error(`${rec.kind} slot "${options.name}" already has an entry`);
        }
      }
      rec.entries.push({ ...options, component });
      return { dispose: () => { rec.entries.splice(rec.entries.indexOf(rec.entries.find((e) => e.component === component)), 1); } };
    },
  };
}

function makeCtx(slots) {
  const warns = [];
  const infos = [];
  return {
    warns, infos,
    logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error: (m) => warns.push(m) },
    get: (n) => (n === "slots" ? slots : undefined),
  };
}

const DECLARED = {
  "conversation.session.header.utilities": "list",
  "conversation.input.dock": "list",
  "conversation.session.header.corner": "single",
};

console.log("阶段九 · 客户端注册测试\n");

await t("标准 6：挂在两个 list 型 slot 上，追加而非占用", () => {
  const slots = makeSlots(DECLARED);
  const ctx = makeCtx(slots);
  const dispose = apply(ctx);
  assert.equal(slots.log.length, 2);
  const rec = slots.entriesOf("conversation.session.header.utilities");
  assert.equal(rec.length, 1, "utilities 上应有一条");
  assert.notEqual(rec[0].id, undefined, "list 型必须给 id");
  assert.ok(rec[0].label, "要有 label");
  assert.equal(typeof rec[0].component, "function", "必须挂真组件");
  assert.equal(typeof dispose, "function");
  dispose();
  assert.equal(slots.entriesOf("conversation.session.header.utilities").length, 0, "卸载后要从 slot 上消失");
  assert.equal(slots.entriesOf("conversation.input.dock").length, 0);
});

await t("标准 6：绝不占用 single 型 slot（那会顶掉别的插件）", () => {
  for (const e of ENTRIES) {
    assert.notEqual(e.slot, "conversation.session.header.corner", "single 型不能占");
    assert.equal(DECLARED[e.slot], "list");
  }
});
await t("卸载后从 slot 上消失", () => {
  const slots = makeSlots(DECLARED);
  const dispose = apply(makeCtx(slots));
  assert.equal(slots.entriesOf("conversation.session.header.utilities").length, 1);
  dispose();
});
await t("标准 3：宿主没有 slots 服务时不抛，只记一条警告", () => {
  const ctx = makeCtx(undefined);
  let out;
  assert.doesNotThrow(() => { out = apply(ctx); });
  assert.equal(out, undefined);
  assert.equal(ctx.warns.length, 1);
  assert.match(ctx.warns[0], /工具链不受影响/);
});
await t("标准 3：注册描述符非法时不拖垮另一个面板", () => {
  const slots = makeSlots({ "conversation.session.header.utilities": "list", "conversation.input.dock": "list" });
  const original = slots.register.bind(slots);
  let first = true;
  slots.register = (o, c) => { if (first) { first = false; throw new Error("模拟宿主拒绝"); } return original(o, c); };
  const ctx = makeCtx(slots);
  let out;
  assert.doesNotThrow(() => { out = apply(ctx); });
  assert.equal(ctx.warns.length, 1);
  assert.match(ctx.warns[0], /注册失败/);
  assert.match(ctx.infos[0], /1\/2 个面板挂载/, "要如实报挂了几个");
  assert.equal(typeof out, "function");
  out();
});
await t("slot 未被声明时安静跳过，不抛", () => {
  const slots = makeSlots({});
  const ctx = makeCtx(slots);
  let out;
  assert.doesNotThrow(() => { out = apply(ctx); });
  assert.equal(slots.log.length, 0);
  assert.match(ctx.infos[0], /0\/2 个面板挂载/);
});
await t("两个面板的 id 不重复", () => {
  assert.equal(new Set(ENTRIES.map((e) => e.id)).size, ENTRIES.length);
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
