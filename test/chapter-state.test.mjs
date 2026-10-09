/** 阶段三测试：章节流程状态机。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as cs from "../lib/chapter-state.js";

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
const ws = path.join(projectRoot, ".test-sandbox", `chap-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";
const V = 1;

console.log(`阶段三 · 章节状态机测试\n沙盒: ${ws}\n`);

// ── 章号 ─────────────────────────────────────────────────────────────────
await t("chapterKey 补齐四位", () => {
  assert.equal(cs.chapterKey(1), "ch0001");
  assert.equal(cs.chapterKey(42), "ch0042");
  assert.equal(cs.chapterKey(1234), "ch1234");
});
await t("chapterKey 拒绝非法章号", () => {
  for (const bad of [0, -1, 1.5, "a", null]) assert.throws(() => cs.chapterKey(bad), `应拒绝 ${bad}`);
});
await t("parseChapterKey 往返", () => {
  assert.equal(cs.parseChapterKey("ch0007"), 7);
  assert.equal(cs.parseChapterKey("随便"), null);
  assert.equal(cs.parseChapterKey("ch07"), null, "必须是四位");
});

// ── 迁移守卫（纯函数）─────────────────────────────────────────────────────
await t("canTransition：任意态可重起草纲", () => {
  assert.equal(cs.canTransition(null, "draft_outline").ok, true);
  assert.equal(cs.canTransition("已定稿", "draft_outline").ok, true);
});
await t("canTransition：无细纲时不能直接确认", () => {
  const r = cs.canTransition(null, "confirm_outline");
  assert.equal(r.ok, false);
  assert.match(r.reason, /还没有任何流程状态/);
});
await t("canTransition：已确认的细纲不能重复确认", () => {
  assert.equal(cs.canTransition("细纲已确认", "confirm_outline").ok, false);
});
await t("canTransition：未备料不能起草", () => {
  assert.equal(cs.canTransition("细纲已确认", "build_draft_task").ok, false);
});
await t("canTransition：未知迁移被拒", () => {
  assert.equal(cs.canTransition("待审", "no_such_action").ok, false);
});

// ── 正常流水线 ───────────────────────────────────────────────────────────
const K = cs.chapterKey(1);
await t("落候选细纲 → 细纲待确认", async () => {
  const r = await cs.advance(ws, BOOK, K, V, "draft_outline");
  assert.equal(r.ok, true);
  assert.equal(r.to.stage, "细纲待确认");
});
await t("候选细纲文件落在草稿区，不在书仓", async () => {
  const s = await cs.readState(ws, BOOK, K);
  assert.ok(s);
  assert.ok(existsSync(path.join(ws, "草稿", BOOK, K, "状态.json")));
});
await t("确认细纲 → 细纲已确认，并记住提交", async () => {
  const r = await cs.advance(ws, BOOK, K, V, "confirm_outline", (s, d) => {
    s.outline = { confirmed: true, commit: "abc1234" };
    d.commit = "abc1234";
  }, "abc1234");
  assert.equal(r.ok, true);
  const s = await cs.readState(ws, BOOK, K);
  assert.equal(s.stage, "细纲已确认");
  assert.equal(s.outline.commit, "abc1234");
  assert.equal(s.history.at(-1).commit, "abc1234");
});
await t("备料 → 已备料", async () => {
  await cs.advance(ws, BOOK, K, V, "assemble_materials", (s) => { s.materials = { assembled: true, at: new Date().toISOString() }; });
  const s = await cs.readState(ws, BOOK, K);
  assert.equal(s.stage, "已备料");
});
await t("组装材料包 → 起草任务包 → 待审", async () => {
  await cs.advance(ws, BOOK, K, V, "build_draft_task", (s) => { s.draftTask = { built: true, at: new Date().toISOString() }; });
  assert.equal((await cs.readState(ws, BOOK, K)).stage, "起草中");
  await cs.advance(ws, BOOK, K, V, "import_draft", (s) => {
    s.draft = { version: 1, latest: "稿件/v1.md", commit: null };
  });
  assert.equal((await cs.readState(ws, BOOK, K)).stage, "待审");
});
await t("未派发审读就不能回写发现项", async () => {
  const r = await cs.recordFindings(ws, BOOK, K, V, { covered: ["x"], findings: [] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /不能执行 "record_findings"/);
});
await t("审读有发现项 → 待改", async () => {
  await cs.advance(ws, BOOK, K, V, "dispatch_review");
  const r = await cs.recordFindings(ws, BOOK, K, V, {
    covered: ["人物与关系", "情节与因果"],
    findings: [{ quote: "他张了张嘴", note: "这句没有交代他为什么张不开" }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pass, false);
  assert.equal(r.to.stage, "待改");
  const s = await cs.readState(ws, BOOK, K);
  assert.equal(s.review.findings, 1);
  assert.equal(s.review.passed, false);
});
await t("改稿后重新进入审读，最终待定稿", async () => {
  await cs.advance(ws, BOOK, K, V, "import_draft", (s) => { s.draft.version += 1; s.draft.latest = "稿件/v2.md"; });
  await cs.advance(ws, BOOK, K, V, "dispatch_review");
  const r = await cs.recordFindings(ws, BOOK, K, V, {
    covered: ["人物与关系", "情节与因果", "文风与表达"],
    findings: [],
    summary: "三条已处理，复审无新增问题",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pass, true);
  assert.equal(r.to.stage, "待定稿");
});
await t("定稿入档 → 已定稿", async () => {
  await cs.advance(ws, BOOK, K, V, "settle", (s) => { s.settlement = { prepared: true, commit: "def5678" }; }, "def5678");
  const s = await cs.readState(ws, BOOK, K);
  assert.equal(s.stage, "已定稿");
  assert.equal(s.settlement.commit, "def5678");
});

// ── 空审通过闸门（本阶段最重要的一条）─────────────────────────────────────
const K2 = cs.chapterKey(2);
await t("空审通过被拒绝：既无发现项也无覆盖维度", async () => {
  await cs.advance(ws, BOOK, K2, V, "draft_outline");
  await cs.advance(ws, BOOK, K2, V, "confirm_outline");
  await cs.advance(ws, BOOK, K2, V, "assemble_materials");
  await cs.advance(ws, BOOK, K2, V, "build_draft_task");
  await cs.advance(ws, BOOK, K2, V, "import_draft");
  await cs.advance(ws, BOOK, K2, V, "dispatch_review");

  const r = await cs.recordFindings(ws, BOOK, K2, V, { findings: [], covered: [] });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-review");
  assert.match(r.detail, /空审通过被拒绝/);
  const s = await cs.readState(ws, BOOK, K2);
  assert.equal(s.stage, "审读中", "被拒后状态必须原地不动");
});
await t("给了覆盖维度的零发现项可以放行", async () => {
  const r = await cs.recordFindings(ws, BOOK, K2, V, { findings: [], covered: ["全量审读"] });
  assert.equal(r.ok, true);
  assert.equal(r.pass, true);
  assert.equal(r.to.stage, "待定稿");
});
await t("发现项缺 quote 或 note 被拒", async () => {
  const K3 = cs.chapterKey(3);
  await cs.advance(ws, BOOK, K3, V, "draft_outline");
  await cs.advance(ws, BOOK, K3, V, "confirm_outline");
  await cs.advance(ws, BOOK, K3, V, "assemble_materials");
  await cs.advance(ws, BOOK, K3, V, "build_draft_task");
  await cs.advance(ws, BOOK, K3, V, "import_draft");
  await cs.advance(ws, BOOK, K3, V, "dispatch_review");
  const bad = await cs.recordFindings(ws, BOOK, K3, V, { findings: [{ note: "有问题" }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, "finding-invalid");
  assert.equal((await cs.readState(ws, BOOK, K3)).stage, "审读中");
});

// ── 越权迁移被挡住 ───────────────────────────────────────────────────────
await t("没备料直接定稿被挡", async () => {
  const K4 = cs.chapterKey(4);
  await cs.advance(ws, BOOK, K4, V, "draft_outline");
  const r = await cs.advance(ws, BOOK, K4, V, "settle");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "transition");
  assert.match(r.detail, /不能执行/);
});

// ── 恢复 ─────────────────────────────────────────────────────────────────
await t("中断后重读状态仍完整（模拟会话重启）", async () => {
  const mod2 = await import(`../lib/chapter-state.js?cb=${Date.now()}`);
  const s = await mod2.readState(ws, BOOK, K);
  assert.equal(s.stage, "已定稿");
  assert.equal(s.outline.commit, "abc1234");
  assert.ok(s.history.length >= 6, `历史只剩 ${s.history.length} 条`);
  assert.deepEqual(s.history.map((h) => h.action).slice(0, 3), ["draft_outline", "confirm_outline", "assemble_materials"]);
});
await t("listChapterStates 按章号升序列出全部章节", async () => {
  const list = await cs.listChapterStates(ws, BOOK);
  assert.deepEqual(list.map((s) => s.chapter), ["ch0001", "ch0002", "ch0003", "ch0004"]);
  assert.equal(list[0].stage, "已定稿");
});

await fs.rm(path.join(projectRoot, ".test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, ".test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
