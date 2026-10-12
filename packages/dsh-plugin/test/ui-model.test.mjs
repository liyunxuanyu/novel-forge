/** 阶段九测试：界面视图模型（纯函数）。 */
import { strict as assert } from "node:assert";
import * as m from "../lib/ui-model.js";

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
console.log("阶段九 · 界面视图模型测试\n");

const STATUS = { ok: true, status: { title: "雨夜剑客", bookId: "b-1", currentVolume: 1, finalizedChapterCount: 7, lastChapter: "第0007章 雨夜", volumesPresent: ["卷01"], commitCount: 12 } };

// ── 徽标 ─────────────────────────────────────────────────────────────────
await t("徽标只回答哪本书、写到第几章", () => {
  const b = m.buildBadge(STATUS);
  assert.equal(b.state, "ok");
  assert.equal(b.label, "雨夜剑客");
  assert.equal(b.chapterCount, 7);
  assert.match(b.detail, /已定稿 7 章/);
  assert.match(b.detail, /第0007章 雨夜/);
});
await t("没有书时是「未连接书仓」，不是空白", () => {
  assert.equal(m.buildBadge({ ok: true, books: [] }).detail, "书仓里还没有书");
  assert.equal(m.buildBadge(null).detail, "未连接书仓");
  assert.equal(m.buildBadge({ ok: false, stage: "x", detail: "y" }).detail, "未连接书仓");
});
await t("还没定稿时不装作有进度", () => {
  const b = m.buildBadge({ ok: true, status: { title: "新书", bookId: "b-2", finalizedChapterCount: 0 } });
  assert.equal(b.detail, "还没定稿章节");
  assert.equal(b.chapterCount, 0);
});
await t("标准 4：待决闸门要叠到徽标上并变调", () => {
  const b = m.badgeWithGate(m.buildBadge(STATUS), { ok: true, node: "settle", level: "stop", requiresDecision: true, question: "第一章定稿后要你确认" });
  assert.equal(b.tone, "blocked");
  assert.match(b.detail, /待你裁决/);
  assert.match(b.detail, /第一章定稿后要你确认/);
  assert.equal(b.gateNode, "settle");
});
await t("没有闸门时徽标不变调", () => {
  const b0 = m.buildBadge(STATUS);
  assert.equal(m.badgeWithGate(b0, { ok: true, requiresDecision: false }).tone, "normal");
  assert.equal(m.badgeWithGate(b0, null).tone, "normal");
});

// ── 材料就绪度 ───────────────────────────────────────────────────────────
await t("十段材料统计就绪与缺失", () => {
  const v = m.buildMaterials({ segments: [
    { id: "prevChapter", name: "前情提要", status: "ready" },
    { id: "style", name: "风格基准", status: "missing", reason: "还没有写法条目" },
  ] });
  assert.equal(v.state, "ok");
  assert.equal(v.ready, 1);
  assert.equal(v.total, 2);
  assert.equal(v.ratio, 0.5);
  assert.equal(v.missing[0].reason, "还没有写法条目", "缺料要带上原因");
});
await t("材料段坏掉不崩", () => {
  const v = m.buildMaterials({ segments: [null, { id: 5 }, {}] });
  assert.equal(v.state, "ok");
  assert.equal(v.total, 3);
  assert.equal(v.ready, 0);
});
await t("材料结构不对就说数据不足", () => {
  assert.equal(m.buildMaterials(null).state, "insufficient");
  assert.equal(m.buildMaterials({}).state, "insufficient");
  assert.match(m.buildMaterials({}).reason, /数据不足/);
});

// ── 当前动作与待决闸门 ───────────────────────────────────────────────────
await t("标准 4：requiresDecision 的动作置顶并变调", () => {
  const a = m.buildAction({ ok: true, node: "chapter.finalize", requiresDecision: true, question: "第 1 章定稿？" });
  assert.equal(a.requiresDecision, true);
  assert.equal(a.tone, "blocked");
  assert.equal(a.question, "第 1 章定稿？");
});
await t("不需要裁决的动作是正常调", () => {
  const a = m.buildAction({ ok: true, node: "chapter.draft", requiresDecision: false, detail: "派起草子代理" });
  assert.equal(a.tone, "normal");
  assert.equal(a.question, null);
  assert.equal(a.detail, "派起草子代理");
});
await t("标准 4：闸门清单单独挑出待决项", () => {
  const g = m.buildGates([
    { ok: true, node: "a", requiresDecision: true, question: "Q1", level: "stop" },
    { ok: true, node: "b", requiresDecision: false, question: null },
    { ok: false, node: "c", requiresDecision: true, question: "Q3" },
  ]);
  assert.equal(g.count, 1, "坏数据的闸门不许混进来");
  assert.equal(g.decisions[0].question, "Q1");
});
await t("面板不自己判断该做什么，只搬导演的结论", () => {
  const a = m.buildAction({ ok: true, node: "chapter.review", requiresDecision: false, detail: "跑审读" });
  assert.equal(a.node, "chapter.review");
  assert.equal(a.requiresDecision, false, "面板绝不自行升级或降级门禁等级");
});

// ── AI 味 ────────────────────────────────────────────────────────────────
await t("AI 味清单保留行号与原句", () => {
  const v = m.buildFlavorView({ ok: true, origin: "第 1 章待审稿", lines: 40, sentences: 22, total: 2, byKind: { filler: 1, parallel: 1 },
    groups: [{ line: 7, text: "无尽的沉默。", kinds: ["万能形容词"], notes: ["换个词也成立"] }] });
  assert.equal(v.groups[0].line, 7);
  assert.equal(v.clean, false);
  assert.match(v.disclaimer, /只报不改/);
});
await t("零命中要说清是零命中，且带上免责", () => {
  const v = m.buildFlavorView({ ok: true, origin: "所给文本", lines: 10, sentences: 4, total: 0, groups: [] });
  assert.equal(v.clean, true);
  assert.match(v.disclaimer, /检测不出来不等于写得对/);
});
await t("AI 味检测失败就说数据不足，不显示成「干净」", () => {
  const v = m.buildFlavorView({ ok: false, stage: "no-draft", detail: "还没有待审稿" });
  assert.equal(v.state, "insufficient");
  assert.equal(v.clean, undefined, "数据不足绝不能被读成没命中");
});

// ── 扫榜 ─────────────────────────────────────────────────────────────────
await t("扫榜三档各有色调", () => {
  const v = m.buildScanView({ ok: true, total: 3, tally: { "可用": 1, "要改着用": 1, "别用": 1 }, rows: [
    { id: "m1", name: "甲", kind: "角色向", verdict: "可用", reason: "对得上" },
    { id: "m2", name: "乙", kind: "机制向", verdict: "要改着用", reason: "试一章" },
    { id: "m3", name: "丙", kind: "结构向", verdict: "别用", reason: "撞了不要什么" },
  ] });
  assert.deepEqual(v.rows.map((r) => r.tone), ["ok", "warn", "blocked"]);
  assert.equal(v.total, 3);
});
await t("不认识的判定不静默当成可用", () => {
  const v = m.buildScanView({ ok: true, total: 1, rows: [{ name: "x", verdict: "随便" }] });
  assert.equal(v.rows[0].tone, "warn", "未知判定按最保守处理");
});

// ── 拆书进度 ─────────────────────────────────────────────────────────────
await t("拆书进度给出比例与下一批", () => {
  const v = m.buildRefProgress({ ok: true, sourceId: "ref-x", totalBatches: 8, doneBatches: 3, complete: false, mechanismCount: 11, consented: true, nextFrom: 401, nextTo: 600 });
  assert.equal(v.ratio, 0.375);
  assert.equal(v.next, "第 401–600 行");
  assert.equal(v.consented, true);
});
await t("没记录许可时要看得见", () => {
  const v = m.buildRefProgress({ ok: true, totalBatches: 2, doneBatches: 0, complete: false, consented: false });
  assert.equal(v.consented, false);
});

// ── 组合 ─────────────────────────────────────────────────────────────────
await t("buildAll 一次成形四块，坏数据各自独立降级", () => {
  const v = m.buildAll({
    bookStatus: STATUS,
    materials: { segments: [{ id: "a", name: "A", status: "ready" }] },
    director: { ok: true, node: "x", requiresDecision: false, detail: "d" },
    gateList: [{ ok: true, node: "g", requiresDecision: true, question: "Q", level: "stop" }],
    flavor: { ok: false }, scan: null, ref: { ok: true, totalBatches: 1, doneBatches: 1, complete: true, consented: true },
  });
  assert.equal(v.workspace.badge.tone, "blocked");
  assert.equal(v.workspace.gates.count, 1);
  assert.equal(v.flavor.state, "insufficient");
  assert.equal(v.scan.state, "insufficient");
  assert.equal(v.ref.complete, true);
});
await t("什么都不给也不炸", () => {
  const v = m.buildAll({});
  for (const k of ["flavor", "scan", "ref"]) assert.equal(v[k].state, "insufficient");
  assert.equal(v.workspace.badge.state, "insufficient");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
