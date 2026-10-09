/**
 * 阶段九测试：界面组件。
 *
 * 不断言 DOM —— 直接断言 React 元素树。不引 react-dom，
 * 组件逻辑（取哪个字段、给什么 data 属性、坏数据走哪条路）照样测得到。
 */
import { strict as assert } from "node:assert";
import * as m from "../lib/ui-model.js";
import { createElement } from "react";
import { makeComponents } from "../lib/ui-components.js";

const { ForgeBadge, MaterialsPanel, ActionPanel, GatesPanel, WorkspacePanel, FlavorPanel, ScanPanel, RefPanel } = makeComponents(createElement);

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

/**
 * 渲染并摊平成可检索的字符串。
 * 嵌套的函数组件要真的调用下去——不然 WorkspacePanel 里嵌的徽标根本不在树里，
 * 断言会误以为它没渲染。
 */
function flatten(node, out = [], depth = 0) {
  if (depth > 12) return out;
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const c of node) flatten(c, out, depth + 1); return out; }
  if (node && typeof node === "object" && typeof node.type === "function") {
    return flatten(node.type(node.props ?? {}), out, depth + 1);
  }
  if (node.props && node.props.children !== undefined) flatten(node.props.children, out, depth + 1);
  return out;
}
const textOf = (el) => flatten(el).join("");
const propOf = (el, name) => el?.props?.[name];

console.log("阶段九 · 界面组件测试\n");

const STATUS = { ok: true, status: { title: "雨夜剑客", bookId: "b-1", finalizedChapterCount: 7, lastChapter: "第0007章" } };

// ── 标准 3：渲染不许抛 ───────────────────────────────────────────────────
await t("标准 3：任何坏输入都渲染出东西，不抛异常", () => {
  const cases = [
    [ForgeBadge, undefined], [ForgeBadge, null], [ForgeBadge, { view: null }],
    [MaterialsPanel, {}], [MaterialsPanel, { view: { state: "ok" } }],
    [ActionPanel, { view: { state: "ok" } }],
    [GatesPanel, {}], [GatesPanel, { view: { decisions: null } }],
    [WorkspacePanel, {}], [WorkspacePanel, null],
    [FlavorPanel, {}], [FlavorPanel, { view: { state: "ok", groups: null } }],
    [ScanPanel, {}], [ScanPanel, { view: { state: "ok", rows: null } }],
    [RefPanel, {}], [RefPanel, { view: { state: "ok" } }],
  ];
  for (const [C, p] of cases) {
    let el;
    assert.doesNotThrow(() => { el = C(p); }, `${C.name} 崩了`);
    assert.notEqual(el, null, `${C.name} 渲染成了 null`);
    assert.ok(typeof textOf(el) === "string");
  }
});
await t("组件自己抛错时被兜住，退化成一行提示", () => {
  const boom = { state: "ok", get segments() { throw new Error("炸了"); } };
  const el = MaterialsPanel({ view: boom });
  assert.equal(propOf(el, "title"), "面板渲染失败，工具链不受影响");
  assert.equal(textOf(el), "十段材料", "兜底文案要短，别把异常细节糊到界面上");
});

// ── 徽标 ─────────────────────────────────────────────────────────────────
await t("徽标渲染书名与进度", () => {
  const el = ForgeBadge({ view: m.buildBadge(STATUS) });
  const s = textOf(el);
  assert.match(s, /雨夜剑客/);
  assert.match(s, /已定稿 7 章/);
  assert.equal(propOf(el, "data-tone"), "normal");
});
await t("标准 4：待决闸门在徽标上是 blocked", () => {
  const badge = m.badgeWithGate(m.buildBadge(STATUS), { ok: true, node: "settle", requiresDecision: true, question: "第1章定稿？" });
  const el = ForgeBadge({ view: badge });
  assert.equal(propOf(el, "data-tone"), "blocked");
  assert.match(textOf(el), /待你裁决/);
});
await t("未连接时是 muted，不是空白", () => {
  const el = ForgeBadge({ view: m.buildBadge(null) });
  assert.equal(propOf(el, "data-tone"), "muted");
  assert.match(textOf(el), /未连接书仓/);
});

// ── 材料 ─────────────────────────────────────────────────────────────────
await t("标准 5：材料面板逐段给出就绪与否", () => {
  const el = MaterialsPanel({ view: m.buildMaterials({ segments: [
    { id: "a", name: "前情提要", status: "ready" },
    { id: "b", name: "风格基准", status: "missing", reason: "还没有写法条目" },
  ] }) });
  assert.match(textOf(el), /十段材料 1\/2/);
  assert.equal(propOf(el, "data-tone"), "warn");
  const kids = el.props.children.filter((c) => c && c.props && "data-ready" in c.props);
  assert.equal(kids.length, 2);
  assert.equal(propOf(kids[0], "data-ready"), "true");
  assert.equal(propOf(kids[1], "data-ready"), "false");
});
await t("全齐时是 ok", () => {
  const el = MaterialsPanel({ view: m.buildMaterials({ segments: [{ id: "a", name: "A", status: "ready" }] }) });
  assert.equal(propOf(el, "data-tone"), "ok");
});

// ── 动作与闸门 ───────────────────────────────────────────────────────────
await t("标准 4：待决动作用 strong 置顶强调", () => {
  const el = ActionPanel({ view: m.buildAction({ ok: true, node: "settle", requiresDecision: true, question: "第 1 章定稿？" }) });
  assert.equal(propOf(el, "data-tone"), "blocked");
  assert.match(textOf(el), /待你裁决：第 1 章定稿？/);
});
await t("没有待决闸门时明说没有", () => {
  const el = GatesPanel({ view: m.buildGates([{ ok: true, requiresDecision: false }]) });
  assert.equal(propOf(el, "data-tone"), "ok");
  assert.match(textOf(el), /没有待决闸门/);
});
await t("待决闸门逐条列出", () => {
  const el = GatesPanel({ view: m.buildGates([
    { ok: true, node: "a", requiresDecision: true, question: "Q1", level: "stop" },
    { ok: true, node: "b", requiresDecision: true, question: "Q2", level: "stop" },
  ]) });
  assert.equal(propOf(el, "data-tone"), "blocked");
  assert.match(textOf(el), /2 个待决闸门/);
  assert.match(textOf(el), /Q1/);
  assert.match(textOf(el), /Q2/);
});

// ── AI 味 ────────────────────────────────────────────────────────────────
await t("标准 4：每条命中都带 data-line，能定位", () => {
  const el = FlavorPanel({ view: m.buildFlavorView({ ok: true, origin: "第1章", lines: 30, sentences: 10, total: 1, byKind: {}, groups: [
    { line: 7, text: "无尽的沉默。", kinds: ["万能形容词"], notes: ["换个词也成立"] },
  ] }) });
  assert.equal(propOf(el, "data-tone"), "warn");
  const rows = el.props.children.filter((c) => c && c.props && "data-line" in c.props);
  assert.equal(rows.length, 1);
  assert.equal(propOf(rows[0], "data-line"), 7);
  assert.match(textOf(el), /只报不改/);
});
await t("标准 6：面板文案明写只报不改，并带免责", () => {
  const el = FlavorPanel({ view: m.buildFlavorView({ ok: true, origin: "x", lines: 1, sentences: 1, total: 0, groups: [] }) });
  assert.match(textOf(el), /未命中/);
  assert.match(textOf(el), /检测不出来不等于写得对/);
});

// ── 扫榜 ─────────────────────────────────────────────────────────────────
await t("扫榜三档分别打 data-verdict", () => {
  const el = ScanPanel({ view: m.buildScanView({ ok: true, total: 3, tally: { "可用": 1, "要改着用": 1, "别用": 1 }, rows: [
    { id: "m1", name: "甲", verdict: "可用", reason: "" },
    { id: "m2", name: "乙", verdict: "要改着用", reason: "" },
    { id: "m3", name: "丙", verdict: "别用", reason: "" },
  ] }) });
  const rows = el.props.children.filter((c) => c && c.props && "data-verdict" in c.props);
  assert.deepEqual(rows.map((r) => propOf(r, "data-tone")), ["ok", "warn", "blocked"]);
  assert.match(textOf(el), /✗ 丙/);
});

// ── 拆书进度 ─────────────────────────────────────────────────────────────
await t("拆书进度显示百分比与下一批", () => {
  const el = RefPanel({ view: m.buildRefProgress({ ok: true, sourceId: "ref-x", totalBatches: 8, doneBatches: 3, complete: false, mechanismCount: 11, consented: true, nextFrom: 401, nextTo: 600 }) });
  assert.match(textOf(el), /3\/8 批（38%）/);
  assert.match(textOf(el), /下一批 第 401–600 行/);
  assert.equal(propOf(el, "data-tone"), "normal");
});
await t("标准 4：没记录处理许可时面板要看得出来", () => {
  const el = RefPanel({ view: m.buildRefProgress({ ok: true, totalBatches: 2, doneBatches: 0, complete: false, consented: false }) });
  assert.equal(propOf(el, "data-tone"), "warn");
  assert.match(textOf(el), /尚未记录处理许可/);
});

// ── 组合 ─────────────────────────────────────────────────────────────────
await t("标准 2：工作台面板只是把四块拼起来，不自己判断", () => {
  const view = m.buildWorkspaceView({
    bookStatus: STATUS,
    materials: { segments: [{ id: "a", name: "A", status: "ready" }] },
    director: { ok: true, node: "draft", requiresDecision: false, detail: "派起草子代理" },
    gateList: [{ ok: true, node: "g", requiresDecision: true, question: "Q", level: "stop" }],
  });
  const el = WorkspacePanel({ view });
  const s = textOf(el);
  assert.match(s, /雨夜剑客/);
  assert.match(s, /派起草子代理/);
  assert.match(s, /待你裁决：Q/);
  assert.equal(propOf(el, "data-tone"), "blocked");
});
await t("标准 5：多书场景只渲染当前这一本", () => {
  const view = m.buildBadge({ ok: true, books: [
    { title: "甲书", bookId: "b-a", currentVolume: 1 },
    { title: "乙书", bookId: "b-b", currentVolume: 3 },
  ] });
  const s = textOf(ForgeBadge({ view }));
  assert.match(s, /甲书/);
  assert.ok(!s.includes("乙书"), "多书时别把整本列表摊到徽标上");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
