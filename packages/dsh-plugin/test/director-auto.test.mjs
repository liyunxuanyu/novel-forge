/**
 * 导演链的「自己走完这一步」测试。
 *
 * 这一层在问一个很具体的问题：**导演跑完一步之后，下一步能不能直接接着跑。**
 *
 * 试跑时发现有两跳是断的，而且断法一样——导演把子代理的结果转回调用方就算完事，
 * 该落的盘没落、该声明的状态没声明，于是每章每轮都得有人手动补一次：
 *
 *   1. 起草跑完，稿子没落进草稿区。而下一条规则要的正是 state.draft.latest
 *      （审读子代理读的是盘上的稿）。→ 每章补一次 forge_import_draft。
 *   2. 审读跑完，状态没推进到「审读中」。而 forge_record_findings 只在
 *      「审读中／待改／待定稿」下可执行。→ 每轮补一次 forge_dispatch_review，
 *      补漏了整轮发现项全被挡在门外。
 *
 * 两处都是「工具本身是好的，接起来才漏」——单测每个工具都过，链条照样断。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { directorTools, liftUnresolved } from "../lib/tools-director.js";
import { chapterTools } from "../lib/tools-chapter.js";
import { gateTools } from "../lib/tools-gates.js";
import { RULES } from "../lib/director.js";
import * as wh from "../lib/warehouse.js";
import * as cs from "../lib/chapter-state.js";
import { outlineFixture } from "./helpers/outline-fixture.mjs";

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
const ws = path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox", `dauto-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";
const KEY = "ch0001";

console.log(`导演链 · 自动闭环测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: {
    核心创意: "雨夜才能开口的剑客", 题材与目标读者: "玄幻", 核心看点: "沉默的代价",
    差异化方向: "写沟通", 主角核心欲望: "说完一句话", 主要冲突: "开口即暴露",
    明确不要什么: "不要系统流",
  },
});

const bookBase = wh.bookPaths(ws, BOOK).base;
async function writeInBook(rel, content) {
  const abs = path.join(bookBase, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

await writeInBook("大纲/故事骨架.md", "# 故事骨架\n\n## 索引\n\n- 沈昭（人物）\n");
await writeInBook("大纲/分卷布局.md", "## 第 1 卷（第 1–2 章）｜雨落\n");
await writeInBook("大纲/卷01/卷纲.md", "# 卷一规划\n\n卷末必须让沈昭说出第一个字。\n");
await writeInBook("契约/作品契约.md", "# 作品契约\n\n红线：不许出现系统提示音。\n");
await writeInBook("大纲/卷01/ch0001-细纲.md", "# 第一章细纲\n\n〔硬〕他必须在雨里对仇人开口。\n");
await writeInBook("设定/人物/沈昭.md", "# 沈昭\n\n只在雨天能说话。\n");

await cs.advance(ws, BOOK, KEY, 1, "draft_outline");
await cs.advance(ws, BOOK, KEY, 1, "confirm_outline");
await cs.advance(ws, BOOK, KEY, 1, "assemble_materials");

const BODY = "雨下了三天。\n他站在门口，没进去。\n";
const FINDINGS = JSON.stringify([
  { dimension: "人物", quote: "他站在门口", note: "为什么不进去没交代" },
]);

/** 假引擎：只会按剧本交回一份正文或一份发现项。 */
function fakeRuntime(body) {
  const engine = {
    start() {
      return {
        id: "round-1",
        agentsStarted: 1,
        result: Promise.resolve({ stopReason: "completed", value: { done: [body], failed: [] } }),
        dispose() {},
      };
    },
  };
  return () => ({ engine, subagents: null, maxTokens: 65536 });
}

function toolsWith(body) {
  const byName = new Map();
  const ctx = { logger: { info() {}, warn() {}, error() {} } };
  for (const def of directorTools(ctx, () => ws, fakeRuntime(body))) byName.set(def.name, defineTool(def));
  // 回写发现项在章节工具集里，不在导演工具集里 —— 链条跨两个工具集，
  // 测试就得把两边的真家伙都装上，否则测的是我拼出来的假链条。
  for (const def of chapterTools(ctx, () => ws)) byName.set(def.name, defineTool(def));
  // 闸门答复在门禁工具集里。改稿到顶之后导演会停，只有作者答复能放行 ——
  // 这条链要把「停 → 答复 → 继续」整段走一遍，就得装上真家伙。
  for (const def of gateTools(ctx, () => ws)) byName.set(def.name, defineTool(def));
  // exec.agent 必须给：派子代理要有个父级，而且引擎要读 parent.session 定沙箱策略。
  return (n, a) => byName.get(n).execute(a ?? {}, { agent: { session: { id: "test-session" } }, signal: new AbortController().signal });
}

// ── 规则表：稿子没落盘时不许去派审读 ─────────────────────────────────────
await t("规则表：起草中指向重起草，只有待审/审读中才指向审读", () => {
  const draftRule = RULES.find((r) => r.id === "chapter-draft");
  const reviewRule = RULES.find((r) => r.id === "chapter-review");
  assert.equal(draftRule.when({ chapterStage: "起草中" }), true, "起草中没有规则认领，导演会一路落到整卷结算上去");
  assert.equal(
    reviewRule.when({ chapterStage: "起草中" }), false,
    "稿子还没落盘就派审读，审读子代理只会拿到一份不存在的 draftText",
  );
  assert.equal(reviewRule.when({ chapterStage: "待审" }), true);
  assert.equal(reviewRule.when({ chapterStage: "审读中" }), true);
});

// ── 第一跳：起草自己落稿 ────────────────────────────────────────────────
const call = toolsWith(BODY);

await t("起草步骤自己把稿子落进草稿区：状态 → 待审，正文在盘上", async () => {
  const r = await call("forge_director_run", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.done.length, 1, "正文没交回调用方");

  const s = await cs.readState(ws, BOOK, KEY);
  assert.equal(s.stage, "待审", "稿子没落盘，状态还停在起草中");
  assert.equal(s.draft.version, 1);
  assert.equal(s.draft.latest, "稿件/v1.md");

  const abs = path.join(ws, "草稿", BOOK, KEY, "稿件", "v1.md");
  assert.equal(await fs.readFile(abs, "utf8"), BODY, "盘上的正文和子代理交回的不一致");
  assert.match(r.detail, /已自动落稿 v1/);
});

await t("目标字数同时落库：篇幅闸门不是死的", async () => {
  const s = await cs.readState(ws, BOOK, KEY);
  assert.equal(s.draftTask?.built, true, "draftTask 没记，checkChapterLength 拿不到 target 会静默放行");
  assert.equal(s.draftTask.targetWords, 3000);
  assert.equal(s.draft.short, undefined);
});

// ── 第二跳：审读自己声明已派出 ──────────────────────────────────────────
await t("审读步骤自己声明「已派出」：状态 → 审读中，发现项才回写得进去", async () => {
  const call2 = toolsWith(FINDINGS);
  const r = await call2("forge_director_run", { title: BOOK, dimensions: ["人物"] });
  assert.equal(r.ok, true, JSON.stringify(r));

  const s = await cs.readState(ws, BOOK, KEY);
  assert.equal(s.stage, "审读中", "没声明派审读，record_findings 会被状态机挡在门外");
  assert.equal(s.review.dispatched, true);
  assert.deepEqual(s.review.dimensions, ["人物"]);
  assert.equal(s.review.revisions, 1, "轮次没数上，改稿上限就时灵时不灵");
});

await t("紧跟着回写发现项：不需要调用方补任何一步", async () => {
  const r = await call("forge_record_findings", {
    title: BOOK, chapter: 1, covered: ["人物"],
    findings: [{ dimension: "人物", quote: "他站在门口", note: "为什么不进去没交代" }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = await cs.readState(ws, BOOK, KEY);
  assert.equal(s.stage, "待改", "发现项没落进流程状态");
  assert.equal(s.review.findings, 1);
  assert.equal(s.review.items[0].quote, "他站在门口");
});

// ── 失败形状 ────────────────────────────────────────────────────────────
await t("落稿失败是结构化失败，且失败形状里没有 undefined", async () => {
  const noCh = await cs.importDraft(ws, BOOK, "ch0099", 1, { body: "有正文。" });
  assert.equal(noCh.ok, false);
  assert.equal(noCh.stage, "no-chapter");

  const empty = await cs.importDraft(ws, BOOK, KEY, 1, { body: "   " });
  assert.equal(empty.ok, false);
  assert.equal(empty.stage, "empty-body");

  // undefined 不是无损 JSON，宿主会把整次调用判成 invalid output —— 而 JSON.stringify
  // 会静默丢掉这些键，所以只能逐个字段查。
  for (const v of [noCh, empty]) {
    for (const [k, val] of Object.entries(v)) assert.notEqual(val, undefined, `${k} 是 undefined`);
  }
});

await t("已经派过审读的章再跑审读：不重复计轮次", async () => {
  // 模拟「派了审读但子代理结果没回来」——按真源重跑一轮是正确恢复，
  // 但不能把轮次重复数一遍（那会让改稿上限提前触发）。
  const before = (await cs.readState(ws, BOOK, KEY)).review.revisions;
  await cs.advance(ws, BOOK, KEY, 1, "import_draft");
  const call3 = toolsWith(FINDINGS);
  const r = await call3("forge_director_run", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = await cs.readState(ws, BOOK, KEY);
  assert.equal(after.stage, "审读中");
  assert.equal(after.review.revisions, before + 1, "第二轮审读的轮次没数上");
});

// ── 第三跳：改稿也自己落稿 ──────────────────────────────────────────────
await t("改稿步骤也自己落稿：v2 在盘上，latest 指向它", async () => {
  const rec = await call("forge_record_findings", {
    title: BOOK, chapter: 1, covered: ["人物"],
    findings: [{ dimension: "人物", quote: "他站在门口", note: "为什么不进去没交代" }],
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));

  const FIXED = "雨下了三天。\n他站在门口，没进去。\n他最后还是进去了。\n";
  const call4 = toolsWith(FIXED);
  // 发现项不用手喂：autoFillContext 从流程状态里取（那是另一条测试盯着的）。
  const r = await call4("forge_director_run", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.detail, /已自动落稿 v2/);

  const s = await cs.readState(ws, BOOK, KEY);
  assert.equal(s.stage, "待审", "改稿没落盘，latest 还指着上一版——再审一轮只会把改掉的问题重报一遍");
  assert.equal(s.draft.version, 2);
  assert.match(s.draft.origin, /改稿子代理/);
  const abs = path.join(ws, "草稿", BOOK, KEY, "稿件", "v2.md");
  assert.equal(await fs.readFile(abs, "utf8"), FIXED);
});

// ── 第四跳：〔未处置〕说明不能跟着正文进定稿 ────────────────────────────
// 改稿者被要求「〔硬〕优先于发现项」，两条都不能满足时用一行〔未处置〕说明。
// 那是给作者看的话，但它只有返回值这一个渠道——不摘就会一路走进定稿。
// 真机上第 1 章 v4 的末行就是它。
await t("改稿者留下的〔未处置〕说明被摘出来，不进正文，也不丢", async () => {
  // 上一条测试把这一章留在「待审」，先派一轮审读才允许回写发现项。
  const d = await call("forge_dispatch_review", { title: BOOK, chapter: 1 });
  assert.equal(d.ok, true, JSON.stringify(d));
  const rec = await call("forge_record_findings", {
    title: BOOK, chapter: 1, covered: ["人物"],
    findings: [{ dimension: "人物", quote: "他最后还是进去了", note: "进去得太顺" }],
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));

  // 这一章在本文件里已经改满三轮，导演会停在 chapter.revise_exhausted 上。
  // 顺路把「闸门停 → 作者答复 → 导演放行」走一遍，别绕过它。
  const dec = await call("forge_gate_decide", {
    title: BOOK, chapter: 1, node: "chapter.revise_exhausted", choice: "再改一轮并放宽标准",
  });
  assert.equal(dec.ok, true, JSON.stringify(dec));
  assert.equal(dec.grantedExtraRounds, 1);
  const nxt = await call("forge_director_next", { title: BOOK });
  assert.equal(nxt.node, "chapter.revise", "答复之后导演必须重新放行改稿");
  assert.equal(nxt.proceed, true);

  const BODY = "雨下了三天。\n他站在门口，没进去。\n他最后还是进去了。\n";
  const NOTE = "〔未处置〕发现项 3：细纲〔硬〕不写他在数什么，与该项要求的「给一个具体所指」不能并存，已保留〔硬〕。";
  const call5 = toolsWith(`${BODY}${NOTE}\n`);
  const r = await call5("forge_director_run", { title: BOOK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.detail, /已自动落稿 v3/);
  assert.match(r.detail, /1 条未处置说明/, "摘出来的说明必须报给调用方，不能默默丢掉");
  assert.match(r.detail, /保留〔硬〕/);

  const abs = path.join(ws, "草稿", BOOK, KEY, "稿件", "v3.md");
  const onDisk = await fs.readFile(abs, "utf8");
  assert.equal(onDisk, BODY.replace(/\s+$/, ""), "〔未处置〕是给作者的话，不是正文，不能跟着进定稿");
  assert.doesNotMatch(onDisk, /〔未处置〕/);
});

await t("liftUnresolved：换一个标记（〔说明〕）也照样摘走", () => {
  // 真机上第二次翻车就是这个：prompt 里写〔未处置〕，子代理回的是〔说明〕，
  // 只认一个标记等于把「模型会不会照着我给的词写」当成了正确性前提。
  const alt = "正文一。\n正文二。\n〔说明〕发现项 10 不阻断，留待作者表态。\n";
  const r = liftUnresolved(alt);
  assert.deepEqual(r.notes, ["发现项 10 不阻断，留待作者表态。"]);
  assert.equal(r.body, "正文一。\n正文二。");
});

await t("liftUnresolved：正文中间的〔未处置〕不误删，摘干净了也不交空正文", () => {
  const mid = "他说：「〔未处置〕这四个字我见过。」\n后面还有正文。\n";
  assert.equal(liftUnresolved(mid).body, mid, "中间出现的多半是对话或引文，不能删");

  const onlyNote = "〔未处置〕发现项 1：撞了〔硬〕。\n";
  const r = liftUnresolved(onlyNote);
  assert.equal(r.notes.length, 1);
  assert.equal(r.body, onlyNote, "摘干净了宁可原样还回去，也不能把正文变成空字符串");

  const two = "正文。\n\n〔未处置〕第一条。\n〔未处置〕第二条。\n";
  const r2 = liftUnresolved(two);
  assert.deepEqual(r2.notes, ["第一条。", "第二条。"]);
  assert.equal(r2.body, "正文。");
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`\n${f.name}\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}