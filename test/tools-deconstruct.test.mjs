/** 阶段七测试：拆书工具层。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { deconstructTools } from "../lib/tools-deconstruct.js";

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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `dtool-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });

const LINES = [
  "雨下了三天。", "他站在门口，没进去。", "守门人认得他，假装不认得。",
  "巷子尽头有盏灯。", "灯是灭的。", "他把伞收了。",
  "第三天雨停了。", "他还是没说话。", "后来他走了，谁也不知道他去哪。",
].join("\n");

let captured = null;
const makeCtx = (reply) => ({
  logger: { info() {}, warn() {}, error() {} },
  get: (n) => (n === "workflowEngine" ? {
    start(spec) {
      captured = spec;
      return { id: "r1", result: Promise.resolve({ stopReason: "completed", value: { done: [{ id: "batch", ok: true, text: reply(spec.args.jobs[0].prompt) }], failed: [] } }), async dispose() {} };
    },
  } : undefined),
});
const makeNoCtx = () => ({ logger: { info() {} }, get: () => undefined });

const META = {
  title: "雨巷", author: "某作者", translator: "", edition: "网络版",
  acquiredFrom: "作者自备", allowedUses: "自用学习", basis: "作者声明仅供个人参考", basisKind: "用户声明",
};
const SID = "ref-t";
const importArgs = (over = {}) => ({ sourceId: SID, filename: "a.txt", content: LINES, ...META, ...over });
const mechJson = (over = {}) => ({
  kind: "机制向", name: "雨作为沉默的计时器",
  statement: "把天气当沉默的刻度，让读者不用旁白就知道时间在走。",
  appliesWhen: "主角的困境与时间或沉默有关时。",
  notAppliesWhen: "节奏要快时，用天气计时会拖慢推进。",
  evidence: { chapter: 1, lineStart: 1, lineEnd: 1, quote: LINES.split("\n")[0] },
  ...over,
});

const build = (ctx) => {
  const m = new Map();
  for (const d of deconstructTools(ctx, () => ws)) m.set(d.name, defineTool(d));
  return m;
};
const call = (M, name, a) => M.get(name).execute(a ?? {}, { signal: new AbortController().signal });
const text = (M, name, r) => M.get(name).output.render({}, r)[0].text;

console.log(`阶段七 · 拆书工具层测试\n沙盒: {ws}\n`.replace("{ws}", ws));

// ── 来源 ─────────────────────────────────────────────────────────────────
await t("缺来源交代：宿主 schema 就先拦下，根本进不到 execute", async () => {
  const M = build(makeNoCtx());
  await assert.rejects(
    () => call(M, "forge_ref_import", { sourceId: SID, filename: "a.txt", content: LINES, title: "雨巷" }),
    /missing required property "author"/,
  );
  assert.equal(existsSync(path.join(ws, "书房", "参考", SID)), false, "没过就不该落盘");
});
await t("必填项都在但依据类型留空，模块层再挡一道", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_import", importArgs({ basisKind: "   " }));
  assert.equal(r.ok, false);
  assert.equal(r.stage, "bad-basis-kind");
  assert.equal(existsSync(path.join(ws, "书房", "参考", SID)), false);
});
await t("库 id 不合法被拒", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_import", importArgs({ sourceId: "../逃逸" }));
  assert.equal(r.ok, false);
  assert.equal(r.stage, "bad-source-id");
});
await t("导入成功并报告行数", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_import", importArgs());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lines, 9);
  assert.match(text(M, "forge_ref_import", r), /依据类型「用户声明」/);
});

// ── 许可 ─────────────────────────────────────────────────────────────────
await t("没许可就拆第一批被挡", async () => {
  const M = build(makeNoCtx());
  const plan = await call(M, "forge_ref_plan", { sourceId: SID, ranges: [{ start: 1, end: 4 }], batchLines: 2 });
  assert.equal(plan.ok, true, `定计划本身就该成功：${JSON.stringify(plan)}`);
  assert.equal(plan.batches.length, 2, "start/end 应当真的切成两批");
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-consent");
  assert.match(text(M, "forge_ref_batch", r), /许可/);
});
await t("改范围会作废许可并提醒", async () => {
  const M = build(makeNoCtx());
  await call(M, "forge_ref_consent", { sourceId: SID, provider: "pix", model: "deepseek", service: "api.ai-pixel.online" });
  const r = await call(M, "forge_ref_plan", { sourceId: SID, ranges: [{ start: 1, end: 9 }], batchLines: 3 });
  assert.equal(r.consentCleared, true);
  assert.match(text(M, "forge_ref_plan", r), /作废/);
  const s = await call(M, "forge_ref_status", { sourceId: SID });
  assert.equal(s.consented, false);
});

// ── 拆一批 ───────────────────────────────────────────────────────────────
const ensureConsent = async () => {
  await call(build(makeNoCtx()), "forge_ref_consent", { sourceId: SID, provider: "pix", model: "deepseek", service: "api.ai-pixel.online" });
};

await t("拆一批：任务文本带绝对行号，行号起点与批次对齐", async () => {
  await ensureConsent();
  const M = build(makeCtx(() => JSON.stringify([mechJson()])));
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.batchIndex, 0);
  assert.deepEqual([r.from, r.to], [1, 3]);
  assert.equal(r.ids.length, 1);
  assert.match(captured.args.jobs[0].prompt, /^1\t雨下了三天。$/m, "第一行必须以绝对行号 1 打头");
  assert.match(captured.args.jobs[0].prompt, /^3\t守门人认得他，假装不认得。$/m);
  assert.match(captured.args.jobs[0].prompt, /notAppliesWhen/, "任务文本要点名要求写不适用条件");
});

await t("任务文本带上来源交代，不只给行号", async () => {
  assert.match(captured.args.jobs[0].prompt, /《雨巷》/);
  assert.match(captured.args.jobs[0].prompt, /某作者/);
});

await t("摘录编造 → 整批作废，进度不动", async () => {
  await ensureConsent();
  const M = build(makeCtx(() => JSON.stringify([mechJson({ name: "编的", evidence: { lineStart: 2, quote: "他去买了把伞。" } })])));
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "evidence-rejected");
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].detail, /原文第 2 行起实际是/, "要把原文实际内容摆出来，让人自己判");
  const s = await call(build(makeNoCtx()), "forge_ref_status", { sourceId: SID });
  assert.equal(s.doneBatches, 1, "作废的批次不该计入进度");
  assert.equal(s.mechanismCount, 1);
});

await t("模型输出裹着代码围栏也能抠出来", async () => {
  await ensureConsent();
  const M = build(makeCtx(() => "拆完了，结果如下：\n```json\n" + JSON.stringify([mechJson()]) + "\n```\n以上。"));
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, true, JSON.stringify(r));
});
await t("模型输出里没有数组 → 明确报错并附输出开头", async () => {
  await ensureConsent();
  const M = build(makeCtx(() => "这一段我看不出有什么可复用的机制。"));
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-array");
  assert.match(r.detail, /看不出有什么可复用/, "要把输出开头带回来，便于判断是不是该换个说法重试");
});
await t("一条机制都没拆出来也算失败，不静默成功", async () => {
  await ensureConsent();
  const M = build(makeCtx(() => "[]"));
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-batch");
});
await t("没有引擎时不崩，给出可读说明", async () => {
  await ensureConsent();
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-engine");
});

// ── 进度 ─────────────────────────────────────────────────────────────────
await t("进度可查：做完几批、下一批、机制数", async () => {
  const M = build(makeNoCtx());
  const s = await call(M, "forge_ref_status", { sourceId: SID });
  assert.equal(s.doneBatches, 2, `实际 ${s.doneBatches}/${s.totalBatches}`);
  assert.equal(s.totalBatches, 3);
  assert.equal(s.nextFrom, 7);
  assert.equal(s.nextTo, 9);
  assert.equal(s.mechanismCount, 2, "前两批各交回一条；被拒那批不计数");
  assert.match(text(M, "forge_ref_status", s), /下一批：第 7–9 行/);
});
await t("不带 sourceId 时列出全部参考库", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_status", {});
  assert.equal(r.ok, true);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].sourceId, SID);
  assert.match(text(M, "forge_ref_status", r), /ref-t/);
});
await t("拆完最后一批后报告完成", async () => {
  await ensureConsent();
  const M = build(makeCtx(() => JSON.stringify([mechJson({ name: "第三条" })])));
  const r = await call(M, "forge_ref_batch", { sourceId: SID });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.complete, true);
  const s = await call(build(makeNoCtx()), "forge_ref_status", { sourceId: SID });
  assert.equal(s.complete, true);
  assert.match(text(M, "forge_ref_status", s), /全部拆完/);
});

// ── 查机制 ───────────────────────────────────────────────────────────────
await t("查机制带证据、两类适用条件与版本", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_mechanisms", { sourceId: SID });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3, `实际 ${r.count} 条：三批各一条，被拒那批没进账`);
  const m = r.mechanisms[0];
  assert.equal(m.quote, LINES.split("\n")[0]);
  assert.equal(m.lineStart, 1);
  assert.equal(m.version, 1);
  assert.equal(m.status, "候选", "机制生成本身不进正式计划");
  assert.match(text(M, "forge_ref_mechanisms", r), /适用：/);
  assert.match(text(M, "forge_ref_mechanisms", r), /别用：/);
});
await t("按类别筛选机制", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_mechanisms", { sourceId: SID, kind: "角色向" });
  assert.equal(r.count, 0);
  const bad = await call(M, "forge_ref_mechanisms", { sourceId: SID, kind: "乱填" });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, "bad-kind");
});

// ── 重拆 ─────────────────────────────────────────────────────────────────
await t("重拆必须写理由", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_redeconstruct", { sourceId: SID, reason: "" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "reason-required");
});
await t("重拆版本 +1、进度清零、旧机制保留", async () => {
  const M = build(makeNoCtx());
  const r = await call(M, "forge_ref_redeconstruct", { sourceId: SID, reason: "换个角度重读，前三章的机制更关键" });
  assert.equal(r.version, 2);
  assert.equal(r.previous, 1);
  const s = await call(M, "forge_ref_status", { sourceId: SID });
  assert.equal(s.doneBatches, 0);
  assert.equal(s.version, 2);
  assert.equal(s.mechanismCount, 3, `实际 ${s.mechanismCount} 条，旧版本机制不该被删`);
});

// ── 边界 ─────────────────────────────────────────────────────────────────
await t("拆书全程没有逼人建书仓", () => {
  assert.equal(existsSync(path.join(ws, "书仓")), false);
});
await t("库 id 非法时各工具都挡住，不碰文件系统", async () => {
  const M = build(makeNoCtx());
  for (const name of ["forge_ref_plan", "forge_ref_consent", "forge_ref_status", "forge_ref_batch", "forge_ref_mechanisms", "forge_ref_redeconstruct"]) {
    const r = await call(M, name, {
      sourceId: "a/b", ranges: [{ start: 1, end: 2 }], reason: "x",
      provider: "p", model: "m", service: "s", kind: "机制向",
    });
    assert.equal(r.ok, false, `${name} 应当拒绝非法 id`);
    assert.equal(r.stage, "bad-source-id");
  }
});

await fs.rm(path.join(projectRoot, "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, "..", ".forge-test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
