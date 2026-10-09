/** 阶段三测试（工具层）：一章从细纲走到定稿的完整链路。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { chapterTools } from "../lib/tools-chapter.js";
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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `pipe-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

const byName = new Map();
for (const def of chapterTools({ logger: { info() {}, warn() {}, error() {} } }, () => ws)) {
  byName.set(def.name, defineTool(def));
}
const call = (name, args) => byName.get(name).execute(args ?? {}, { signal: new AbortController().signal });

console.log(`阶段三 · 章节流水线测试\n沙盒: ${ws}\n`);

// ── 前置：建书并铺好真源 ─────────────────────────────────────────────────
await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: { 核心创意: "雨夜才能开口的剑客", 题材与目标读者: "玄幻", 核心看点: "沉默的代价", 差异化方向: "写沟通", 主角核心欲望: "说完一句话", 主要冲突: "开口即暴露", "明确不要什么": "不要系统流" },
});
const bookBase = wh.bookPaths(ws, BOOK).base;
async function writeInBook(rel, content) {
  const abs = path.join(bookBase, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
await writeInBook("卷账/前情提要.md", "他叫沈昭，左耳有旧伤。\n");
await writeInBook("设定/人物/沈昭.md", "# 沈昭\n\n只在雨天能说话。沉默三日即失语。\n");
await writeInBook("设定/地点/听雨楼.md", "# 听雨楼\n\n城中最高的楼，木质，雨天漏水。\n");
await writeInBook("卷账/伏笔台账.md", "# 伏笔\n\n- 断剑：待收于第 7 章\n");
await writeInBook("大纲/卷01/卷纲.md", "# 卷纲\n\n卷一目标：沈昭说出第一个字。\n");

// ── 状态查询 ─────────────────────────────────────────────────────────────
await t("还没有章节时，状态查询给出明确指引而不是空结果", async () => {
  const r = await call("forge_chapter_status", { title: BOOK });
  assert.equal(r.ok, true);
  assert.deepEqual(r.chapters, []);
  assert.match(byName.get("forge_chapter_status").output.render({}, r)[0].text, /还没有任何章节流程记录/);
});

// ── 细纲 ─────────────────────────────────────────────────────────────────
await t("落候选细纲 → 细纲待确认（草稿区，不是真源）", async () => {
  const r = await call("forge_outline_draft", {
    title: BOOK, chapter: 1, volume: 1,
    body: "# 第一章 雨夜\n\n〔硬〕沈昭在雨中对仇人开口。\n〔自由〕过程可以慢。\n",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.chapter, "ch0001");
  assert.ok(existsSync(path.join(ws, "草稿", BOOK, "ch0001", "候选细纲.md")));
  assert.equal(existsSync(path.join(bookBase, "大纲", "卷01", "ch0001-细纲.md")), false, "候选细纲不该直接进真源");
});

await t("未确认细纲时不能组装材料", async () => {
  const r = await call("forge_assemble_materials", { title: BOOK, chapter: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "outline-not-confirmed");
});

await t("确认细纲 → 一次 design(ch0001): 提交", async () => {
  const r = await call("forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(existsSync(path.join(bookBase, "大纲", "卷01", "ch0001-细纲.md")));
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "design(ch0001): 确认章细纲");
});

await t("细纲确认后不能重复确认", async () => {
  const r = await call("forge_confirm_outline", { title: BOOK, chapter: 1, volume: 1 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /不能执行/);
});

// ── 备料 ─────────────────────────────────────────────────────────────────
await t("组装十段材料，逐段带来源", async () => {
  const r = await call("forge_assemble_materials", { title: BOOK, chapter: 1, volume: 1, authorNote: "结尾别收太满" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.segments.length, 10);
  const task = r.segments.find((s) => s.id === "task");
  assert.ok(task.ok, "本章任务段应该找得到");
  assert.match(task.source, /ch0001-细纲\.md$/);
  assert.ok(r.missing.includes("prevChapter"), "ch0001 没有上一章，应当如实报缺");
  const note = r.segments.find((s) => s.id === "authorNote");
  assert.equal(note.ok, true);
  assert.ok(r.packageHash);
});

// ── 任务包 ───────────────────────────────────────────────────────────────
let taskText = "";
await t("任务包自包含：子代理零上下文可写", async () => {
  const r = await call("forge_draft_task", { title: BOOK, chapter: 1, chapterTitle: "雨夜", targetWords: 2800 });
  assert.equal(r.ok, true, JSON.stringify(r));
  taskText = r.task;
  assert.ok(taskText.includes("沈昭在雨中对仇人开口"), "本章任务内容缺失");
  assert.ok(taskText.includes("不要系统流"), "契约红线缺失");
  assert.ok(taskText.includes("只在雨天能说话"), "人物设定缺失");
  assert.ok(taskText.includes("听雨楼"), "场景设定缺失");
  assert.ok(taskText.includes("断剑"), "伏笔台账缺失");
  assert.ok(taskText.includes("结尾别收太满"), "作者本次指令缺失");
  assert.equal(taskText.includes(projectRoot), false, "任务包泄露了绝对路径");
});

await t("任务包如实标出缺的段，不假装齐全", () => {
  assert.ok(taskText.includes("上一章结尾（缺）"), "上一章缺了却没标出来");
  assert.ok(taskText.includes("若本章必须用到它，先停下来问"), "缺段没有给模型正确指引");
});

// ── 导稿 ─────────────────────────────────────────────────────────────────
const DRAFT_V1 = "雨下到第四日。\n\n沈昭站在听雨楼三层的窗前，看着下面那群举火把的人。\n";
const DRAFT_V2 = DRAFT_V1 + "\n他张了张嘴。\n";
await t("导入初稿 → 待审，版本从 1 起", async () => {
  const r = await call("forge_import_draft", { title: BOOK, chapter: 1, body: DRAFT_V1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, 1);
  assert.ok(existsSync(path.join(ws, "草稿", BOOK, "ch0001", "稿件", "v1.md")));
});

await t("再导一稿 → 版本递增到 2，旧稿保留", async () => {
  const r = await call("forge_import_draft", { title: BOOK, chapter: 1, body: DRAFT_V2 });
  assert.equal(r.ok, true);
  assert.equal(r.version, 2);
  assert.ok(existsSync(path.join(ws, "草稿", BOOK, "ch0001", "稿件", "v1.md")));
  assert.ok(existsSync(path.join(ws, "草稿", BOOK, "ch0001", "稿件", "v2.md")));
});

await t("空正文被拒", async () => {
  const r = await call("forge_import_draft", { title: BOOK, chapter: 2, body: "   " });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-body");
});

// ── 审读闸门 ─────────────────────────────────────────────────────────────
await t("没派发审读就回写发现项，被状态机挡住", async () => {
  const r = await call("forge_record_findings", { title: BOOK, chapter: 1, covered: ["人物与关系"], findings: [] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /不能执行/);
});

await t("空审通过被拒绝：既无发现项也无覆盖维度", async () => {
  const s = await call("forge_chapter_status", { title: BOOK, chapter: 1 });
  assert.equal(s.chapters[0].stage, "待审");
  // 先走到审读中
  const st = await import("../lib/chapter-state.js");
  await st.advance(ws, BOOK, "ch0001", 1, "dispatch_review");

  const r = await call("forge_record_findings", { title: BOOK, chapter: 1, covered: [], findings: [] });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-review");
  assert.match(r.detail, /空审通过被拒绝/);
  const after = await call("forge_chapter_status", { title: BOOK, chapter: 1 });
  assert.equal(after.chapters[0].stage, "审读中", "被拒后状态必须原地不动");
});

await t("有发现项 → 待改", async () => {
  const r = await call("forge_record_findings", {
    title: BOOK, chapter: 1,
    covered: ["人物与关系", "文风与表达"],
    findings: [{ quote: "举火把的人", note: "没交代是谁、为什么来", dimension: "情节与因果" }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.passed, false);
  assert.equal(r.nextStage, "待改");
});

// ── 定稿闸门 ─────────────────────────────────────────────────────────────
await t("有待改问题时不能直接定稿", async () => {
  const r = await call("forge_settle_chapter", { title: BOOK, chapter: 1, chapterTitle: "雨夜" });
  assert.equal(r.ok, false);
  assert.match(r.detail, /不能执行/);
  assert.equal(existsSync(path.join(bookBase, "定稿", "卷01", "ch0001-雨夜.md")), false, "不该留下定稿文件");
});

// ── 改稿 → 复审 → 定稿 ──────────────────────────────────────────────────
await t("改稿后复审零发现项（给了覆盖维度）→ 待定稿", async () => {
  await call("forge_import_draft", { title: BOOK, chapter: 1, body: DRAFT_V2 + "\n他张了张嘴，说出一个字。\n" });
  const st = await import("../lib/chapter-state.js");
  await st.advance(ws, BOOK, "ch0001", 1, "dispatch_review");
  const r = await call("forge_record_findings", {
    title: BOOK, chapter: 1,
    covered: ["人物与关系", "情节与因果", "文风与表达", "全量审读"],
    findings: [],
    summary: "断剑伏笔按期出现，无新增问题",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.passed, true);
  assert.equal(r.nextStage, "待定稿");
});

await t("定稿入档 → 一次 ch: 提交，书仓章数 +1", async () => {
  const r = await call("forge_settle_chapter", { title: BOOK, chapter: 1, chapterTitle: "雨夜", allowShort: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bookStatus.finalizedChapterCount, 1);
  assert.equal(r.bookStatus.lastChapter, "ch0001");
  assert.deepEqual(r.bookStatus.volumesPresent, [1]);
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "ch: ch0001 雨夜");
});

await t("定稿文件落在 定稿/卷NN/chNNNN-章名.md", () => {
  assert.ok(existsSync(path.join(bookBase, "定稿", "卷01", "ch0001-雨夜.md")));
});

// ── 提交谱系 ─────────────────────────────────────────────────────────────
await t("整章在 Git 上留下可复盘的谱系", async () => {
  const log = await wh.git(["log", "--format=%s", "--", "书仓/雨夜剑客/大纲/卷01/ch0001-细纲.md"], ws);
  assert.match(log.stdout.trim(), /^design\(ch0001\): 确认章细纲$/m);
  const s = await call("forge_chapter_status", { title: BOOK, chapter: 1 });
  assert.equal(s.chapters[0].settled, true);
  assert.equal(s.chapters[0].outlineConfirmed, true);
  assert.equal(s.chapters[0].materialsAssembled, true);
  assert.equal(s.chapters[0].draftVersion, 3);
});

// ── 恢复 ─────────────────────────────────────────────────────────────────
await t("中断后重读状态完整（模拟会话重启）", async () => {
  const mod2 = await import(`../lib/tools-chapter.js?cb=${Date.now()}`);
  const tools2 = new Map();
  for (const def of mod2.chapterTools({ logger: { info() {}, warn() {}, error() {} } }, () => ws)) {
    tools2.set(def.name, defineTool(def));
  }
  const r = await tools2.get("forge_chapter_status").execute({ title: BOOK, chapter: 1 }, { signal: new AbortController().signal });
  assert.equal(r.ok, true);
  assert.equal(r.chapters[0].stage, "已定稿");
});

await fs.rm(path.join(projectRoot, "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, "..", ".forge-test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
