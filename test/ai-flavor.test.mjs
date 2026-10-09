/** 阶段八测试：去 AI 味。 */
import { strict as assert } from "node:assert";
import * as af from "../lib/ai-flavor.js";

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
const ids = (r) => r.hits.map((h) => h.id);
console.log("阶段八 · 去 AI 味测试\n");

// ── 标准 5：纯函数 ───────────────────────────────────────────────────────
await t("标准 5：同一段文本两次检测结果完全一致", () => {
  const md = "无尽的沉默。\n他感到十分愤怒。\n不是他的伞，而是她的。\n";
  const a = af.detectAiFlavor(md);
  const b = af.detectAiFlavor(md);
  assert.deepEqual(a, b);
});
await t("检测不改动输入文本", () => {
  const md = "无尽的沉默。\n";
  const copy = `${md}`;
  af.detectAiFlavor(md);
  assert.equal(md, copy, "检测器绝不许碰正文");
});
await t("检测结果顺序确定（按行号 + 判据 id）", () => {
  const md = "无尽的沉默。他很悲伤。\n不是A，而是B。\n";
  const a = af.detectAiFlavor(md);
  const b = af.detectAiFlavor(md);
  assert.deepEqual(a.hits.map((h) => `${h.line}:${h.id}`), b.hits.map((h) => `${h.line}:${h.id}`));
  const lines = a.hits.map((h) => h.line);
  assert.deepEqual(lines, [...lines].sort((x, y) => x - y));
});

// ── 五类判据 ─────────────────────────────────────────────────────────────
await t("排比堆砌：三句等长同收尾连排", () => {
  const r = af.detectAiFlavor("他走了。\n她也走了。\n他们走了。\n");
  assert.ok(ids(r).includes("parallel"), JSON.stringify(r.hits));
});
await t("排比堆砌：只两句不算", () => {
  const r = af.detectAiFlavor("他走了。\n她也走了。\n");
  assert.ok(!ids(r).includes("parallel"));
});
await t("排比堆砌：长度差超过 1 字就不算", () => {
  const r = af.detectAiFlavor("他走了。\n她也说了句话。\n他们走了。\n");
  assert.ok(!ids(r).includes("parallel"));
});
await t("总结句标志：命中并给出用了哪个词", () => {
  const r = af.detectAiFlavor("雨停了。这意味着该走了。\n");
  const h = r.hits.find((x) => x.id === "summary");
  assert.ok(h, JSON.stringify(r.hits));
  assert.match(h.why, /这意味着/);
});
await t("情绪直述：命名情绪被点名", () => {
  const r = af.detectAiFlavor("他感到十分愤怒。\n");
  const h = r.hits.find((x) => x.id === "emotion");
  assert.ok(h);
  assert.match(h.why, /他感到十分愤怒/);
});
await t("情绪直述：心里满是 也算", () => {
  assert.ok(ids(af.detectAiFlavor("心中满是灰烬。\n")).includes("emotion"));
});
await t("万能形容词：命中并列出实际用到的词", () => {
  const h = af.detectAiFlavor("无尽的沉默。\n").hits.find((x) => x.id === "filler");
  assert.ok(h);
  assert.match(h.why, /无尽的/);
});
await t("对称句式：不是…而是 与 既…又 都算", () => {
  const a = af.detectAiFlavor("这不是他的伞，而是她的。\n");
  assert.ok(ids(a).includes("symmetry"));
  const b = af.detectAiFlavor("他既紧张又兴奋。\n");
  assert.ok(ids(b).includes("symmetry"));
});

// ── 干净文本 ─────────────────────────────────────────────────────────────
await t("干净的叙事文本零命中", () => {
  const md = [
    "雨下到第三天，屋檐下的水缸满了。",
    "他把伞靠在门边，蹲下去看那缸水。",
    "水面浮着两片叶子，一片是青的，一片烂了。",
    "他伸手捞起烂的那片，指腹一捻就碎了。",
  ].join("\n");
  const r = af.detectAiFlavor(md);
  assert.equal(r.total, 0, JSON.stringify(r.hits));
  assert.match(r.detail, /都没命中/);
});
await t("空文本不炸", () => {
  const r = af.detectAiFlavor("");
  assert.equal(r.total, 0);
  assert.equal(r.sentences, 0);
});

// ── 定位 ─────────────────────────────────────────────────────────────────
await t("标准 4：每条命中都带行号，能点开定位", () => {
  const md = "第一行没问题。\n第二行也没问题。\n无尽的沉默。\n";
  const r = af.detectAiFlavor(md);
  assert.ok(r.hits.length > 0);
  for (const h of r.hits) {
    assert.ok(Number.isInteger(h.line) && h.line >= 1, `命中缺行号：${JSON.stringify(h)}`);
    assert.ok(h.text.length > 0, "命中要带上原句");
    assert.ok(h.why.length > 0, "命中要说清为什么");
  }
  assert.equal(r.hits[0].line, 3);
});
await t("标题与列表标记不参与正文判据", () => {
  const r = af.detectAiFlavor("# 无尽的沉默\n");
  assert.equal(r.total, 0, "标题里的套话不该算进正文");
});
await t("按行聚合，便于直接跳过去改", () => {
  const r = af.detectAiFlavor("他感到十分愤怒。无尽的沉默。\n第二行干净。\n");
  const groups = af.groupByLine(r);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].line, 1);
  assert.equal(groups[0].hits.length, 2);
});
await t("统计按判据分列", () => {
  const r = af.detectAiFlavor("无尽的沉默。他很悲伤。他走了。她也走了。他们走了。\n");
  assert.ok(r.byKind.filler >= 1);
  assert.ok(r.byKind.emotion >= 1);
  assert.ok(r.byKind.parallel >= 1);
  assert.equal(r.total, r.hits.length);
});
await t("严重度：这类都是 s4 风格级，不阻断流程", () => {
  const r = af.detectAiFlavor("无尽的沉默。\n");
  for (const h of r.hits) assert.equal(h.severity, "s4", "AI 味不该阻断定稿");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
