/** 阶段七测试：拆书管道。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as dc from "../lib/deconstruct.js";
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
const ws = path.join(projectRoot, ".test-sandbox", `dec-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });

console.log(`阶段七 · 拆书管道测试\n沙盒: ${ws}\n`);

// 原文：每行一个句子，方便按行引用
const SRC = [
  "第一章 他在雨里站了很久。",
  "雨水顺着剑鞘往下淌。",
  "他张开嘴，发不出声音。",
  "守门人看了他一眼，没有问。",
  "三条街外的灯全灭了。",
  "他终于转身，走进巷子。",
  "巷口挂着半截灯笼。",
  "灯笼底下压着一张纸。",
].join("\n");
const LINES = SRC.split("\n");

const META = {
  title: "参考书甲", author: "某作者", edition: "网络版", translator: "",
  acquiredFrom: "作者自备", allowedUses: "自用学习，不外传", basis: "作者声明仅供个人参考", basisKind: "用户声明",
};
const SID = "ref-a";
async function fresh(overrides = {}) {
  return dc.importSource(ws, SID, "ref.txt", SRC, { ...META, ...overrides });
}
const mech = (over = {}) => ({
  kind: "机制向", name: "沉默先于解释",
  statement: "让主角先失去说话能力，再让读者自己拼出代价。",
  appliesWhen: "主角的核心困境与沟通或表达有关时。",
  notAppliesWhen: "困境靠行动而非言语推进时，照搬会拖慢开场。",
  evidence: { chapter: 1, lineStart: 3, lineEnd: 3, quote: LINES[2] },
  ...over,
});

// ── 来源交代 ─────────────────────────────────────────────────────────────
await t("缺来源交代不许导入", async () => {
  const r = await dc.importSource(ws, "ref-x", "a.txt", SRC, { title: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "missing-meta");
  assert.match(r.detail, /author/);
  assert.equal(existsSync(path.join(ws, "书房", "参考", "ref-x")), false, "没通过就不该落盘");
});
await t("声明可核对许可却不给可核对的东西，被拒", async () => {
  const r = await dc.importSource(ws, "ref-y", "a.txt", SRC, { ...META, basisKind: "可核对许可" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-license-evidence");
});
await t("声明错了的依据类型被拒", async () => {
  const r = await dc.importSource(ws, "ref-z", "a.txt", SRC, { ...META, basisKind: "随便说的" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "bad-basis-kind");
});
await t("交代齐全才能导入", async () => {
  const r = await fresh();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lines, 8);
});

// ── 许可闸门 ─────────────────────────────────────────────────────────────
await t("没有范围时谈不了许可", async () => {
  const r = await dc.grantConsent(ws, SID, { provider: "p", model: "m", service: "s" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-range");
});
await t("说不清发往哪个服务，许可不成立", async () => {
  await dc.setPlan(ws, SID, [{ from: 1, to: 8 }], 4);
  const r = await dc.grantConsent(ws, SID, { provider: "p" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-service");
});
await t("没有许可就不许拆第一批", async () => {
  const r = await dc.recordBatch(ws, SID, 0, [mech()]);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-consent");
  assert.match(r.detail, /许可/);
});
await t("许可后可以拆；范围一改，许可自动作废", async () => {
  const c = await dc.grantConsent(ws, SID, { provider: "pix", model: "deepseek", service: "api.ai-pixel.online" });
  assert.equal(c.ok, true);
  assert.ok(c.consent.scopes.length > 0, "许可要记下覆盖哪些范围");
  await dc.setPlan(ws, SID, [{ from: 1, to: 8 }], 4);
  assert.equal(await dc.getConsent(ws, SID), null, "范围变了就得重新许可，不能静默沿用");
});

// ── 标准 1/6：批次切分与恢复 ─────────────────────────────────────────────
await t("批次按每批章数切分，边界是纯函数", () => {
  const b = dc.computeBatches([{ from: 1, to: 20 }], 5);
  assert.equal(b.length, 4);
  assert.deepEqual(b[0], { index: 0, chapter: null, from: 1, to: 5, size: 5 });
  assert.deepEqual(b[3], { index: 3, chapter: null, from: 16, to: 20, size: 5 });
});
await t("零头不足一批也单独成批，不丢章", () => {
  const b = dc.computeBatches([{ from: 1, to: 22 }], 5);
  assert.equal(b.length, 5);
  assert.deepEqual(b[4], { index: 4, chapter: null, from: 21, to: 22, size: 2 });
});
await t("多段范围拼起来依次编号", () => {
  const b = dc.computeBatches([{ from: 1, to: 3 }, { from: 10, to: 12 }], 2);
  assert.deepEqual(b.map((x) => [x.from, x.to]), [[1, 2], [3, 3], [10, 11], [12, 12]]);
  assert.deepEqual(b.map((x) => x.index), [0, 1, 2, 3]);
});
await t("非法范围被丢掉而不是变成垃圾批次", () => {
  const b = dc.computeBatches([{ from: 5, to: 1 }, { from: 0, to: 3 }, { from: 2, to: 4 }], 3);
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].from, b[0].to], [2, 4]);
});
await t("批次数写得不合法时被拒", async () => {
  const r = await dc.setPlan(ws, SID, [{ from: 9, to: 2 }], 3);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "bad-range");
  const r2 = await dc.setPlan(ws, SID, [], 3);
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, "no-ranges");
});
await t("给没导入过的库定计划 → 先报 no-source，不假装", async () => {
  const r = await dc.setPlan(ws, "从没导入过", [{ from: 1, to: 3 }], 2);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-source");
});

await t("重新实例化（模拟会话重启）也能算出下一批", async () => {
  await dc.setPlan(ws, SID, [{ from: 1, to: 8 }], 4);
  await dc.grantConsent(ws, SID, { provider: "pix", model: "deepseek", service: "api.ai-pixel.online" });
  const p = await dc.getProgress(ws, SID);
  assert.equal(p.totalBatches, 2);
  assert.equal(p.doneBatches, 0);
  assert.equal(p.next.index, 0);
  assert.equal(p.complete, false);
});

// ── 标准 3：证据核验 ─────────────────────────────────────────────────────
await t("摘录与原文逐字一致 → 核验通过", () => {
  const r = dc.verifyEvidence(LINES, { lineStart: 3, lineEnd: 3, quote: LINES[2] });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "verified");
});
await t("跨多行的摘录也对得上", () => {
  const r = dc.verifyEvidence(LINES, { lineStart: 2, lineEnd: 4, quote: LINES.slice(1, 4).join("\n") });
  assert.equal(r.ok, true);
});
await t("摘录是编的 → 核验失败，并把原文实际内容摆出来", () => {
  const r = dc.verifyEvidence(LINES, { lineStart: 3, lineEnd: 3, quote: "他大声喊了出来。" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "mismatch");
  assert.equal(r.actual, LINES[2]);
  assert.match(r.detail, /对不上/);
});
await t("行号越界 → 明确报越界，不静默通过", () => {
  const r = dc.verifyEvidence(LINES, { lineStart: 999, quote: "随便" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "out-of-range");
  assert.match(r.detail, /只有 8 行/);
});
await t("行号从 0 开始会被拒（从 1 数）", () => {
  assert.equal(dc.verifyEvidence(LINES, { lineStart: 0, quote: "x" }).reason, "bad-line");
});
await t("没给摘录被拒", () => {
  assert.equal(dc.verifyEvidence(LINES, { lineStart: 1, quote: "  " }).reason, "no-quote");
});

// ── 标准 3：机制完整性 ───────────────────────────────────────────────────
await t("缺「不适用条件」的机制被拒", () => {
  const v = dc.validateMechanism(mech({ notAppliesWhen: "" }));
  assert.equal(v.ok, false);
  assert.match(v.detail, /notAppliesWhen/);
  assert.match(v.detail, /照搬/, "要说清为什么不能只写适用条件");
});
await t("三种机制类别都认", () => {
  for (const kind of dc.MECHANISM_KINDS) {
    assert.equal(dc.validateMechanism(mech({ kind })).ok, true, `${kind} 应当合法`);
  }
});
await t("不认识的类别被拒", () => {
  assert.equal(dc.validateMechanism(mech({ kind: "随便什么" })).ok, false);
});
await t("缺摘录或行号被逐项点出来", () => {
  const v = dc.validateMechanism({ name: "x", kind: "机制向", statement: "y", appliesWhen: "z", notAppliesWhen: "w", evidence: {} });
  assert.equal(v.ok, false);
  assert.match(v.detail, /lineStart/);
  assert.match(v.detail, /quote/);
});

// ── 标准 1/2：记批次 ────────────────────────────────────────────────────
await t("记下第一批，进度推进到下一批", async () => {
  const r = await dc.recordBatch(ws, SID, 0, [mech()]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.batchIndex, 0);
  assert.equal(r.ids.length, 1);
  assert.equal(r.remaining, 1);
  assert.equal(r.complete, false);
  const p = await dc.getProgress(ws, SID);
  assert.equal(p.doneBatches, 1);
  assert.equal(p.next.index, 1);
});
await t("标准 1：中断后按进度接着拆，不靠记忆", async () => {
  const p = await dc.getProgress(ws, SID);
  assert.equal(p.next.index, 1);
  assert.deepEqual([p.next.from, p.next.to], [5, 8]);
});
await t("跳批被拒：不是当前该做的那一批", async () => {
  const r = await dc.recordBatch(ws, SID, 5, [mech()]);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "not-next-batch");
  assert.match(r.detail, /第 1 批/);
});
await t("一批里有一条证据不过，整批不落盘", async () => {
  const before = (await dc.listMechanisms(ws, SID)).length;
  const r = await dc.recordBatch(ws, SID, 1, [mech({ name: "好的一条" }), mech({ name: "编的一条", evidence: { lineStart: 3, quote: "他大声喊了出来。" } })]);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "evidence-rejected");
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].name, "编的一条");
  assert.match(r.detail, /整体不落盘/);
  assert.equal((await dc.listMechanisms(ws, SID)).length, before, "半批落盘会让进度账和实际内容对不上");
});
await t("一条都不拆出来也被拒", async () => {
  const r = await dc.recordBatch(ws, SID, 1, []);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-batch");
});
await t("全部拆完后报告完成，再拆被拒", async () => {
  const r = await dc.recordBatch(ws, SID, 1, [mech({ name: "第二条" })]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.complete, true);
  const again = await dc.recordBatch(ws, SID, 2, [mech()]);
  assert.equal(again.ok, false);
  assert.equal(again.stage, "all-done");
});

// ── 标准 5：机制落书房不进书仓 ───────────────────────────────────────────
await t("机制落在书房，不进书仓", async () => {
  const ms = await dc.listMechanisms(ws, SID);
  assert.equal(ms.length, 2);
  const rel = path.relative(ws, path.join(ws, "书房", "参考", SID, "机制"));
  assert.ok(!rel.includes("书仓"), "机制不该出现在书仓");
  assert.equal(existsSync(path.join(ws, "书仓")), false, "拆书不该逼你建书仓");
});
await t("机制卡带着证据与两类适用条件", async () => {
  const [m] = await dc.listMechanisms(ws, SID);
  assert.equal(m.status, "候选", "机制生成本身不入正式计划");
  assert.equal(m.evidence.quote, LINES[2]);
  assert.equal(m.evidence.lineStart, 3);
  assert.ok(m.appliesWhen && m.notAppliesWhen);
  assert.ok(m.version >= 1);
});

// ── 标准 4：版本化 ───────────────────────────────────────────────────────
await t("重拆必须写理由", async () => {
  const r = await dc.bumpVersion(ws, SID, "");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "reason-required");
});
await t("重拆版本 +1，进度清零，旧版本留痕", async () => {
  const r = await dc.bumpVersion(ws, SID, "重读一遍，发现这条机制只在前三章成立");
  assert.equal(r.ok, true);
  assert.equal(r.version, 2);
  assert.equal(r.previous, 1);
  assert.match(r.history[0].reason, /前三章/);
  const p = await dc.getProgress(ws, SID);
  assert.equal(p.doneBatches, 0, "重拆要从头来");
  assert.equal(p.version, 2);
  const ms = await dc.listMechanisms(ws, SID);
  assert.equal(ms.length, 2, "旧版本不删——当初怎么想的不能丢");
  assert.equal(ms[0].version, 1, "旧机制还标着旧版本");
});

await t("按类别筛选机制，三类各取所需", async () => {
  // 重拆后进度清零，先把三种类别各补一条进去再验筛选
  await dc.grantConsent(ws, SID, { provider: "pix", model: "deepseek", service: "api.ai-pixel.online" });
  const trio = ["角色向", "机制向", "结构向"].map((kind, i) =>
    mech({ kind, name: `${kind}一条`, statement: `${kind} 的机制陈述。` }));
  await dc.recordBatch(ws, SID, 0, [trio[0], trio[1], trio[2]]);

  const all = await dc.listMechanisms(ws, SID);
  assert.equal(all.length, 5, `实际 ${all.length} 条：重拆后两条旧机制仍在，加上这一批三条`);
  for (const kind of dc.MECHANISM_KINDS) {
    const got = await dc.listMechanisms(ws, SID, { kind });
    assert.ok(got.length >= 1, `${kind} 应当查得到`);
    assert.ok(got.every((m) => m.kind === kind), "筛选不许混进别的类别");
  }
  const onlyRole = await dc.listMechanisms(ws, SID, { kind: "角色向" });
  assert.equal(onlyRole.length, 1);
  assert.equal(onlyRole[0].name, "角色向一条");
});
await fs.rm(path.join(projectRoot, ".test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, ".test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
