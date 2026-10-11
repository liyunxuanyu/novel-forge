/**
 * 差得远 vs 差一点：改稿那一步的结构活判据。
 *
 * 这组测试守的是一个**判断**，不是一段代码。真机上第 1 章连改 8 轮，
 * 发现项 16 条降到 3 条、s1/s2 连续四轮为 0，而句子形状分毫未动。
 * 原因是改稿那一步写着「*顺手*把落在基线外的项拉回来」——
 * 「顺手」把结构活降级成附赠，模型于是只修发现项。
 *
 * 分档只在改稿用（审读拿到它会变成判分，违反「阈值只用来选样」那条）。
 * 所以这组测试同时钉两件事：
 *   1. 真差得远的项**必须**被拎出来，且排在最前；
 *   2. 组内浮动范围的项**必须**被排除，不许制造无谓动笔。
 *
 * 正的与反的两侧都要有，否则一个「永远返回空数组」的实现照样能过。
 */
import assert from "node:assert/strict";
import { proseGaps, renderProseGaps, measureProse, proseFindings } from "../lib/prose.js";

let passed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  catch (e) { failures.push([name, e.message]); process.stdout.write(`  FAIL  ${name}\n          ${e.message}\n`); }
}

/** 真机上 v8 的实测体格，形状全歪。 */
const V8_SHAPED = {
  chars: 2596, paragraphs: 72, narrativeParagraphs: 70, sentences: 180,
  dialogueRatio: 0.030, dialogueCount: 4, dialogueParticles: 0,
  sentenceAvg: 16.2, sentenceSd: 8,
  commaAvg: 7.1, commaLongRatio: 0.420,
  funcDensity: 65.4, connectiveDensity: 52, longSentenceRatio: 0.30,
  weakAdverbDensity: 0, shortParaRatio: 0.274, paraCv: 0.839, stutterRun: 3,
  dashCount: 0, ellipsisCount: 0, bannedTotal: 0, clicheTotal: 0,
  summaryTotal: 0, actionListCount: 0,
};

/** 已达标的一稿：形状全在基线上。 */
const HEALTHY = {
  ...V8_SHAPED,
  dialogueRatio: 0.50, sentenceAvg: 23, commaLongRatio: 0.77,
  funcDensity: 92, connectiveDensity: 105, longSentenceRatio: 0.20,
};

/** 刚过噪声线的一稿：每项都只差 20% 多一点，属于「可以不管」。 */
const SLIGHTLY_OFF = {
  ...V8_SHAPED,
  commaLongRatio: 0.60,   // 对中心 0.77 是 -22%
  sentenceAvg: 18.2,      // 对中心 23 是 -21%
  funcDensity: 74,        // 对下限 85 是 -13% → 不该进
  dialogueRatio: 0.40,    // 对中心 0.50 是 -20% → 不该进（临界）
};

await t("正好达标的一稿：一项都不报", async () => {
  assert.deepEqual(proseGaps(HEALTHY), []);
  assert.equal(renderProseGaps(HEALTHY), "", "没有结构活时不该渲染出空标题");
});

await t("真机上那份歪稿：四项全部进结构活，只有对话被标为换架构", async () => {
  const gaps = proseGaps(V8_SHAPED);
  const names = gaps.map((g) => g.name);
  // 实测四项分别是 -94% / -45.5% / -29.6% / -23.1%，全部超出 20% 噪声线。
  // 一个只报「超过 50%」的实现会漏掉三项——那三项正是句子架构的问题。
  assert.deepEqual(
    names.sort(),
    ["对话占比", "整句均长", "虚词密度", "逗号长句占比"].sort(),
    `实际只报了 ${names.join("、")}`,
  );
  const far = gaps.filter((g) => g.far).map((g) => g.name);
  assert.deepEqual(far, ["对话占比"], "只有 -94% 那项该标换架构");
});

await t("差得最远的排最前（对话 3% 差得比逗号长句更远）", async () => {
  const gaps = proseGaps(V8_SHAPED);
  assert.equal(gaps[0].name, "对话占比", `实际第一名是 ${gaps[0].name}`);
  // 相对偏离单调递增（都是负数，越负越靠前）
  for (let i = 1; i < gaps.length; i += 1) {
    assert.ok(gaps[i - 1].rel <= gaps[i].rel, "排序该按偏离从大到小");
  }
});

await t("组内浮动内的项不报——不许制造无谓动笔", async () => {
  const gaps = proseGaps(SLIGHTLY_OFF);
  const names = gaps.map((g) => g.name);
  assert.equal(names.includes("虚词密度"), false, "差 13% 属组内浮动，不该报");
  assert.equal(names.includes("对话占比"), false, "差 20% 是临界，不该报");
  // 差 21–22% 的那两项超了噪声线，要报
  assert.ok(names.includes("逗号长句占比"));
  assert.ok(names.includes("整句均长"));
});

await t("渲染文案把结构活与发现项分开，并给出「怎么改」", async () => {
  const text = renderProseGaps(V8_SHAPED);
  assert.match(text, /本轮的结构活/);
  assert.match(text, /不只是顺手/, "必须明确否掉原来那个「顺手」的定性");
  assert.match(text, /怎么改：/, "要给正面做法，不能只报数字");
  assert.match(text, /别用作弊的方式凑数/, "要给反作弊边界");
});

await t("换架构的那项单独点名", async () => {
  const text = renderProseGaps(V8_SHAPED);
  assert.match(text, /对话占比.*不是.*量级/s);
  assert.match(text, /〔换架构〕/);
  // 最后这句是防「指标导向」的：把数字当目的地会写出更假的东西。
  assert.match(text, /指标是路标，不是目的地/);
});

await t("反作弊边界覆盖三种最常见的凑数法", async () => {
  const text = renderProseGaps(V8_SHAPED);
  assert.match(text, /不要把本来该短的地方拉长/);
  assert.match(text, /不要为了对话占比硬加寒暄/);
  assert.match(text, /不要把一句拆成三句再补虚词/);
});

await t("〔硬〕约束优先于结构活：不许为了拉形状违反细纲", async () => {
  const text = renderProseGaps(V8_SHAPED);
  assert.match(text, /细纲〔硬〕约束优先于这一节/);
});

await t("超噪声的项不再分组：一版该修的就该逐项改到基线内", async () => {
  // 前一版实现把 20–50% 的项放进「偏得不多、可以不管的项」那一栏，
  // 而实测那一栏里装的是逗号长句 -45%——一个已确诊的架构问题。
  // 现在 renderProseGaps 没有第二栏，全部是「逐项改到基线内」。
  const text = renderProseGaps(SLIGHTLY_OFF);
  assert.match(text, /逐项改到基线内/);
  assert.equal(text.includes("可以不管"), false, "超了噪声线的项不能标为可以不管");
});

await t("审读那一路不拿这份结构活——它会把选样变成判分", async () => {
  // 这两条路必须分开：审读拿的是**候选发现项**（要人工/子代理表态），
  // 改稿拿的是**本轮的结构活**（指令性文案）。混起来审读就变成判分，
  // 正好违反「阈值只用来选样，不用来判分」那条。
  //
  // 用真文本走 measureProse，不喂手工指标对象——proseFindings 内部要读正文
  // 字段，喂半成品对象会得到一个与被测行为无关的 TypeError。
  const prose = "他把碗从桌上拿起来，用两根手指捏着碗沿，慢慢放到水池边。"
    + "\n那个本子还在门边。他说，你先走。\n"
    + "她没有动，只是把灯往这边推了推，屋子里亮了一点，影子就短了一截。\n"
    + "他把本子合上，塞回口袋，起身去关灯，手停在开关上，又放下了。\n"
    + "外面还在下雨。他站在门口看了一会儿，才想起来自己没有带伞。";
  const findings = proseFindings(measureProse(prose));
  assert.ok(Array.isArray(findings), "审读产出必须是 findings 数组");
  const joined = JSON.stringify(findings);
  for (const banned of ["本轮的结构活", "逐项改到基线内", "怎么改：", "〔换架构〕"]) {
    assert.equal(joined.includes(banned), false, `审读产出里不该出现指令性文案「${banned}」`);
  }
  // 而改稿那条路确实带指令性文案——反过来确认两边没串。
  assert.ok(renderProseGaps(measureProse(prose)).includes("怎么改："));
});

await t("空正文不炸", async () => {
  assert.deepEqual(proseGaps(null), []);
  assert.deepEqual(proseGaps({ chars: 0 }), []);
  assert.deepEqual(proseGaps(measureProse("")), []);
});

process.stdout.write(`\n  通过 ${passed}，失败 ${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);