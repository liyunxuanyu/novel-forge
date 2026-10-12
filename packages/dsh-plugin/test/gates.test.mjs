/** 阶段四测试：门禁分级与质量债。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as g from "../lib/gates.js";
import * as g2 from "../lib/director.js";
import * as wh from "../lib/warehouse.js";

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message ?? error}`);
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox", `gate-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

console.log(`阶段四 · 门禁与质量债测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: { 核心创意: "x", 题材与目标读者: "x", 核心看点: "x", 差异化方向: "x", 主角核心欲望: "x", 主要冲突: "x", "明确不要什么": "x" },
});

// ── 标准 1：等级可查，每个节点都有 ───────────────────────────────────────
const policy = await g.loadPolicy(ws, BOOK);
await t("策略可查：默认策略带全部节点", () => {
  assert.equal(policy.isDefault, true);
  assert.equal(policy.source, "default");
  assert.ok(Object.keys(policy.nodes).length >= 12);
});
await t("每个节点的等级都合法", () => {
  for (const [node, level] of Object.entries(policy.nodes)) {
    assert.ok(g.GATE_LEVELS.includes(level), `${node} 的等级 ${level} 非法`);
  }
});
await t("未登记的节点按最保守处理（stop），不是 auto", () => {
  const c = g.gateCheck(policy, "某没人登记过的节点");
  assert.equal(c.level, "stop");
  assert.equal(c.proceed, false);
});

// ── 标准 2：auto 档可无人值守 ────────────────────────────────────────────
await t("auto 节点直接放行，不触发任何确认", () => {
  for (const node of ["chapter.outline_confirm", "chapter.materials", "chapter.draft", "chapter.review", "chapter.revise"]) {
    const c = g.gateCheck(policy, node);
    assert.equal(c.level, "auto", `${node} 应为 auto`);
    assert.equal(c.proceed, true);
    assert.equal(c.requiresDecision, false);
    assert.equal(c.stopReason, null);
  }
});

// ── 标准 3：stop 档真停下，且给足决策信息 ─────────────────────────────────
await t("stop 节点停下并给出决策选项", () => {
  const c = g.gateCheck(policy, "chapter.settle");
  assert.equal(c.proceed, false);
  assert.equal(c.requiresDecision, true);
  assert.equal(c.defaultOption, null, "纯 stop 不该偷偷给默认");
  assert.ok(c.decisions.length > 0);
  assert.ok(c.decisions[0].question.length > 0);
  assert.ok(c.decisions[0].options.length >= 2);
  assert.match(c.stopReason, /作者拍板/);
});
await t("stop-with-default 停下但给默认选项", () => {
  const c = g.gateCheck(policy, "design.volume_plan");
  assert.equal(c.level, "stop-with-default");
  assert.equal(c.proceed, false);
  assert.equal(c.hasDefault, true);
  assert.equal(c.defaultOption, c.decisions[0].defaultOption);
});
await t("关键节点确实是人工闸门", () => {
  for (const node of ["book.create", "design.skeleton", "chapter.settle", "volume.settle"]) {
    assert.notEqual(g.gateCheck(policy, node).level, "auto", `${node} 不该是 auto`);
  }
});
await t("决策队列只列需要人拍板的节点", () => {
  const q = g.decisionQueue(policy, ["chapter.draft", "chapter.settle", "design.outline"]);
  assert.deepEqual(q.map((x) => x.node), ["chapter.settle"]);
});

// ── 标准 6：策略可配置 ───────────────────────────────────────────────────
await t("书仓里的策略文件覆盖默认值", async () => {
  const abs = g.policyPath(ws, BOOK);
  await fs.writeFile(abs, JSON.stringify({ schema: 1, nodes: { "chapter.settle": "auto", "design.volume_plan": "stop" } }), "utf8");
  const custom = await g.loadPolicy(ws, BOOK);
  assert.equal(custom.isDefault, false);
  assert.equal(custom.source, "book");
  assert.equal(g.gateCheck(custom, "chapter.settle").proceed, true);
  assert.equal(g.gateCheck(custom, "design.volume_plan").level, "stop");
  assert.equal(g.gateCheck(custom, "chapter.draft").level, "auto", "未覆盖的节点仍走默认");
});
await t("策略里写了非法等级就丢掉该项，不整份作废", async () => {
  await fs.writeFile(g.policyPath(ws, BOOK), JSON.stringify({ schema: 1, nodes: { "chapter.settle": "随便写的", "chapter.draft": "auto" } }), "utf8");
  const p = await g.loadPolicy(ws, BOOK);
  assert.deepEqual(p.invalidEntries, ["chapter.settle"]);
  assert.equal(g.gateLevel(p, "chapter.settle"), "stop", "非法项回落到保守默认");
  assert.equal(g.gateLevel(p, "chapter.draft"), "auto");
});
await t("策略文件坏掉时回退默认，而不是崩", async () => {
  await fs.writeFile(g.policyPath(ws, BOOK), "{ 这不是 JSON", "utf8");
  const p = await g.loadPolicy(ws, BOOK);
  assert.equal(p.isDefault, true);
  assert.match(p.parseError, /解析失败/);
  await fs.rm(g.policyPath(ws, BOOK));
});

// ── 标准 4：严重度分流 ───────────────────────────────────────────────────
await t("四级严重度定义齐全", () => {
  assert.deepEqual(Object.keys(g.SEVERITY).sort(), ["s1", "s2", "s3", "s4"]);
});

// 这一条原来叫「S1/S2 当场阻断，不进台账」，断言的是 r.debt === undefined。
// 那条设计有个致命后果：结论在真源里**根本不存在**——子代理下一轮看不到它，
// 导演没有规则读它，会话一断就没了。真机上第 1 章因此空转了一轮：
// 审读报 s2 → 结论蒸发 → 导演仍停在审读中 → 再审一轮 → 又报同一个 s2。
// 无声死循环，比崩溃难发现得多。现在阻断项也落档，用状态区分。
await t("S1/S2 记为阻断项：落档、标未处置、计入未清债", async () => {
  for (const severity of ["s1", "s2"]) {
    // 引文要各不相同：台账现在按「同章 + 同引文 + 同说明」去重，
    // 两条一模一样的会被认成同一件事（那是刻意的，见下面那条去重测试）。
    const r = await g.recordFinding(ws, BOOK, { chapter: "ch0001", severity, quote: `${severity} 的引文`, note: "与第三章已定稿矛盾" });
    assert.equal(r.ok, true);
    assert.equal(r.blocked, true);
    assert.match(r.action, /阻断项/);
    assert.ok(r.debt, "阻断项也必须落档，否则它会蒸发");
    assert.equal(r.debt.status, "未处置", "阻断项用状态区分，好让导演当场停下问作者");
  }
  const l = await g.listDebts(ws, BOOK);
  assert.equal(l.total, 2, "阻断项要落档");
  assert.equal(l.blocking, 2, "两条都还是未处置");
  assert.equal(l.open, 2, "未处置也算未清债");
  assert.equal(l.bySeverity.s1, 1);
  assert.equal(l.bySeverity.s2, 1);
});
await t("S3/S4 记为质量债并提交，不阻塞流程", async () => {
  const r = await g.recordFinding(ws, BOOK, { chapter: "ch0001", severity: "s3", dimension: "信息密度", quote: "他站在窗前", note: "连续三段都在描述同一件事" });
  assert.equal(r.ok, true);
  assert.equal(r.blocked, false);
  // 编号接着前面两条阻断项走：s1/s2 现在也落档，所以 s3 是 d0003。
  assert.equal(r.debt.id, "d0003");
  assert.equal(r.debt.status, "未处理");
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.match(log.stdout.trim(), /^design: 记质量债 d0003/);
});
await t("质量债台账落在书仓并入库", async () => {
  assert.ok(existsSync(g.debtPath(ws, BOOK)));
  const ls = await wh.git(["ls-files"], ws);
  assert.match(ls.stdout, /质量债\.json/);
});
await t("S4 也记债", async () => {
  const r = await g.recordFinding(ws, BOOK, { chapter: "ch0001", severity: "s4", quote: "他的心中充满了", note: "AI 味重" });
  assert.equal(r.ok, true);
  assert.equal(r.blocked, false);
  assert.equal(r.debt.id, "d0004");
});
await t("同一件事重复报上来，台账里不许长出第二条", async () => {
  // 审读每轮都重跑，没修掉的问题会被一轮轮重新报上来。以前无条件新建，
  // 于是「一条 s2 改不掉 → 下一轮再报 → 又一条 → 导演每轮都停在
  // chapter.blocked 上问同一句」。那不是报错，是无声地反复问同一句。
  const first = await g.recordFinding(ws, BOOK, { chapter: "ch0005", severity: "s3", quote: "重复的引文", note: "重复的说明" });
  assert.equal(first.reused, undefined);
  const again = await g.recordFinding(ws, BOOK, { chapter: "ch0005", severity: "s3", quote: "重复的引文", note: "重复的说明" });
  assert.equal(again.reused, true, "第二次要复用");
  assert.equal(again.debt.id, first.debt.id, "编号必须还是原来那个");
  assert.equal(again.commit, null, "没变就不该产生提交");

  // 但**升级**不算重复：上一轮作者说「按发现项改掉」，改稿没改动，
  // 这一轮它又以 s2 报上来——那就该重新挂起，让导演再问一次。
  await g.dispositionBlocking(ws, BOOK, "ch0005", "按发现项改掉再定稿", "改掉它");
  const before = await g.listDebts(ws, BOOK);
  const target = before.entries.find((e) => e.id === first.debt.id);
  assert.equal(target.status, "未处理", "处置后转成待改");

  const escalated = await g.recordFinding(ws, BOOK, { chapter: "ch0005", severity: "s2", quote: "重复的引文", note: "重复的说明" });
  assert.equal(escalated.reused, true, "还是同一条，不新建");
  assert.equal(escalated.debt.id, first.debt.id);
  assert.equal(escalated.blocked, true, "改稿没消掉，就该重新挂为阻断项");
  const after = await g.listDebts(ws, BOOK);
  assert.equal(after.entries.find((e) => e.id === first.debt.id).status, "未处置");
});

await t("处置理由要存下来——选项名本身执行不了", async () => {
  // 「按发现项改掉再定稿」是决定，「删掉『靠前两个字先没了』」才是要照着做的话，
  // 而后者写在理由里。理由不存，改稿者就只剩发现项自己的「二选一」可挑。
  await g.recordFinding(ws, BOOK, { chapter: "ch0006", severity: "s2", quote: "要记录的引文", note: "要记录的说明" });
  await g.dispositionBlocking(ws, BOOK, "ch0006", "按发现项改掉再定稿", "删掉「靠前两个字先没了」，让限定词只是渐糊");
  const l = await g.listDebts(ws, BOOK);
  const e = l.entries.find((x) => String(x.chapter) === "ch0006");
  assert.equal(e.disposition.choice, "按发现项改掉再定稿");
  assert.match(e.disposition.reason, /删掉「靠前两个字先没了」/, "理由必须落档，否则改稿者只能自己挑一个方案");
});

await t("非法严重度被拒", async () => {
  const r = await g.recordFinding(ws, BOOK, { severity: "s9", quote: "x", note: "y" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "bad-severity");
});
await t("缺引文或说明被拒", async () => {
  const r = await g.recordFinding(ws, BOOK, { severity: "s3", note: "只有说明" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "finding-invalid");
});

// ── 标准 5：豁免要写理由，且进 Git ────────────────────────────────────────
await t("豁免不写理由被拒", async () => {
  const r = await g.waiveDebt(ws, BOOK, "d0001", "   ");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "reason-required");
});
await t("豁免写入理由并提交（阻断项也能直接豁免，不必绕道 chapter.blocked）", async () => {
  const r = await g.waiveDebt(ws, BOOK, "d0001", "这一处是有意重复，用来压住节奏，不改");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.debt.status, "已豁免");
  assert.match(r.debt.waiver.reason, /有意重复/);
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.match(log.stdout.trim(), /^design: 豁免质量债 d0001/);
});
await t("同一条债不能重复豁免", async () => {
  const r = await g.waiveDebt(ws, BOOK, "d0001", "再豁免一次");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "already-settled");
});
await t("豁免不存在的债报错明确", async () => {
  const r = await g.waiveDebt(ws, BOOK, "d9999", "理由");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-entry");
});
await t("已处理与已豁免是两种状态，都能结清债务", async () => {
  const r = await g.resolveDebt(ws, BOOK, "d0002", "改成短句了");
  assert.equal(r.ok, true);
  assert.equal(r.debt.status, "已处理");
});

// ── 整卷定稿前的债务闸门 ─────────────────────────────────────────────────
await t("有未清债时整卷定稿被挡", async () => {
  await g.recordFinding(ws, BOOK, { chapter: "ch0002", severity: "s3", quote: "他又看了一眼", note: "重复动作" });
  const gate = await g.debtGate(ws, BOOK);
  assert.equal(gate.passed, false);
  assert.equal(gate.blocked, true);
  assert.match(gate.detail, /未清质量债/);
  assert.equal(gate.level, "stop");
});
await t("债清空后闸门放行", async () => {
  const list = await g.listDebts(ws, BOOK, { status: "未处理" });
  for (const e of list.entries) await g.waiveDebt(ws, BOOK, e.id, "已确认可接受");
  const gate = await g.debtGate(ws, BOOK);
  assert.equal(gate.passed, true);
  assert.equal(gate.blocked, false);
  assert.match(gate.detail, /没有未清质量债/);
});
await t("台账统计按严重度分开，且已处理/已豁免的不计入未清", async () => {
  await g.recordFinding(ws, BOOK, { chapter: "ch0003", severity: "s3", quote: "a", note: "s3 一条" });
  await g.recordFinding(ws, BOOK, { chapter: "ch0003", severity: "s4", quote: "b", note: "s4 一条" });
  await g.recordFinding(ws, BOOK, { chapter: "ch0004", severity: "s4", quote: "c", note: "s4 再一条" });
  const all = await g.listDebts(ws, BOOK);
  const open = await g.listDebts(ws, BOOK, { status: "未处理" });
  assert.equal(open.open, 3);
  assert.equal(open.bySeverity.s3, 1);
  assert.equal(open.bySeverity.s4, 2);
  assert.equal(open.bySeverity.s1, 0, "已豁免的 s1 不该再计入");
  assert.equal(open.bySeverity.s2, 0);
  assert.equal(open.entries.length, 3);
  assert.ok(all.total > open.open, "历史条目应当仍然保留");
  assert.equal(open.entries.every((e) => e.status === "未处理"), true);
});
await t("按严重度筛选能只看某一级", async () => {
  const s3 = await g.listDebts(ws, BOOK, { status: "未处理" });
  const target = s3.entries.find((e) => e.severity === "s3");
  const r = await g.resolveDebt(ws, BOOK, target.id, "改掉了");
  assert.equal(r.ok, true);
  const after = await g.listDebts(ws, BOOK, { status: "未处理" });
  assert.equal(after.bySeverity.s3, 0);
  assert.equal(after.bySeverity.s4, 2);
});

// ── 阻断项的答复通路（chapter.blocked）────────────────────────────────────
//
// 这一组测的是本轮真正修的那个 bug。此前 recordFinding 对 s1/s2 直接 return，
// 什么都不写；而 SEVERITY.s2.blocks = true 又没有对应的 DECISIONS 节点，
// 于是「阻断」既没有落档、也没有人问、更没有答复的入口。
await t("chapter.blocked 是 stop 级，且给了三个可选项", () => {
  const c = g.gateCheck(policy, "chapter.blocked");
  assert.equal(c.level, "stop", "auto 会让模型替作者改设定");
  assert.equal(c.proceed, false);
  assert.equal(c.requiresDecision, true);
  assert.equal(c.decisions[0].options.length, 3);
  assert.deepEqual(c.decisions[0].options, ["按发现项改掉再定稿", "判定不算问题并记录理由", "退回重写这一章"]);
});

await t("阻断规则排在审读之前——否则会审读→报s2→再审读的死循环", () => {
  const rule = g2.RULES.find((r) => r.id === "chapter-blocked");
  assert.ok(rule, "没有这条规则，阻断项就没人消费，等于蒸发");
  assert.equal(rule.when({ chapterBlocking: 1 }), true);
  assert.equal(rule.when({ chapterBlocking: 0 }), false);
  const i = (id) => g2.RULES.findIndex((r) => r.id === id);
  assert.ok(i("chapter-blocked") < i("chapter-review"), "必须排在 chapter-review 之前，否则又去审一轮");
  assert.ok(i("chapter-blocked") < i("chapter-revise"), "也必须排在改稿之前");
  assert.ok(i("chapter-blocked") < i("chapter-settle"), "带着没答的阻断项不许定稿");
});

await t("阻断项拦得住整卷闸门：不处置就不放行", async () => {
  // 这条防的是最坏的一种：s2 被当成「已经上报过了」而没进未清债，
  // 于是整卷闸门显示「没有未清质量债，可以整卷定稿」。
  const r = await g.recordFinding(ws, BOOK, { chapter: "ch0009", severity: "s2", quote: "q9", note: "未处置的阻断项" });
  assert.equal(r.debt.status, "未处置");
  const gate = await g.debtGate(ws, BOOK);
  assert.equal(gate.passed, false);
  assert.match(gate.detail, /阻断项/);
});

await t("处置阻断项：转为待改，不是删掉——改稿要带着它", async () => {
  const d = await g.dispositionBlocking(ws, BOOK, "ch0009", "按发现项改掉再定稿");
  assert.equal(d.ok, true);
  assert.equal(d.changed, 1);
  assert.equal(d.waived, false);
  assert.equal((await g.blockingFindings(ws, BOOK, "ch0009")).length, 0, "处置过的不该再挡住导演");
  const list = await g.listDebts(ws, BOOK);
  assert.equal(list.entries.find((e) => e.id === d.ids[0]).status, "未处理", "转成普通待办，整卷前仍要结清");
});

await t("处置阻断项：判定不算问题必须写理由", async () => {
  const r = await g.recordFinding(ws, BOOK, { chapter: "ch0010", severity: "s2", quote: "q10", note: "第二条阻断项" });
  const noReason = await g.dispositionBlocking(ws, BOOK, "ch0010", "判定不算问题并记录理由", "  ");
  assert.equal(noReason.ok, false);
  assert.equal(noReason.stage, "reason-required");
  assert.equal((await g.blockingFindings(ws, BOOK, "ch0010")).length, 1, "被拒时不该改动台账");
  const ok = await g.dispositionBlocking(ws, BOOK, "ch0010", "判定不算问题并记录理由", "细纲那一条已改过，此处写法合法");
  assert.equal(ok.ok, true);
  assert.equal(ok.waived, true);
  const list = await g.listDebts(ws, BOOK);
  const entry = list.entries.find((e) => e.id === r.debt.id);
  assert.equal(entry.status, "已豁免");
  assert.match(entry.waiver.reason, /细纲那一条/);
});

await t("处置只动本章：别的章的阻断项不受影响", async () => {
  await g.recordFinding(ws, BOOK, { chapter: "ch0020", severity: "s1", quote: "q20", note: "第二十章的问题" });
  await g.recordFinding(ws, BOOK, { chapter: "ch0021", severity: "s1", quote: "q21", note: "第二十一章的问题" });
  const d = await g.dispositionBlocking(ws, BOOK, "ch0020", "按发现项改掉再定稿");
  assert.equal(d.changed, 1);
  const left = await g.blockingFindings(ws, BOOK, "ch0021");
  assert.equal(left.length, 1, "处置一章不该顺手清掉别章的阻断项");
  await g.dispositionBlocking(ws, BOOK, "ch0021", "判定不算问题并记录理由", "测试用：已确认不是问题");
});

await t("blockingFindings 不带章号时列全书的未处置项", async () => {
  await g.recordFinding(ws, BOOK, { chapter: "ch0030", severity: "s2", quote: "q30", note: "全书范围查得到" });
  const all = await g.blockingFindings(ws, BOOK);
  assert.ok(all.some((e) => e.chapter === "ch0030"));
  assert.ok(all.every((e) => e.status === "未处置"), "只列还没处置的");
  await g.dispositionBlocking(ws, BOOK, "ch0030", "判定不算问题并记录理由", "测试用：已确认不是问题");
});

await fs.rm(path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
