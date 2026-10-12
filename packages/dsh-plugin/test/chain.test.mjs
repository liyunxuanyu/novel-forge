/**
 * 阶段十 · A 层：离线全链实测。
 *
 * 用一个按步骤作答的假引擎，把整条导演链从建书跑到整卷结算，
 * 验的是**控制流能不能撑住一整本书**，而不是单个工具对不对。
 *
 * 门禁分级（照 lib/gates.js 的 DEFAULT_POLICY 断言）：
 *   design.skeleton / design.volume_layout   stop —— 作者拍板
 *   chapter.outline_confirm … chapter.revise auto —— 自动放行
 *   chapter.settle / volume.settle          stop —— 作者拍板
 * A-5 要验的就是：stop 的每一次都真停住了，auto 的每一次都没多问。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { warehouseTools } from "../lib/tools-warehouse.js";
import { directorTools } from "../lib/tools-director.js";
import { fanoutTools } from "../lib/tools-fanout.js";
import { chapterTools } from "../lib/tools-chapter.js";
import * as wh from "../lib/warehouse.js";
import { fakeExec } from "./helpers/fake-parent.mjs";
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
const ws = path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox", `chain-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "全链试炼";
const VOL = 1;
const CHAPTERS = [1, 2, 3];

const logger = { info() {}, warn() {}, error() {} };

/** 按 meta.name 判别步骤的假引擎。每章审读两轮：先给一条发现项，再零发现项。 */
let reviewSeq = 0;
const engine = {
  calls: [],
  failNext: false,
  start(spec) {
    engine.calls.push(spec);
    if (engine.failNext) {
      engine.failNext = false;
      return { id: "boom", result: Promise.reject(new Error("网络断了")), async dispose() {} };
    }
    const name = String(spec.meta?.name ?? "");
    const prompt = String(spec.args?.prompt ?? "");
    let value;
    if (name.includes("outline")) {
      const n = /第 (\d+) 章/.exec(prompt)?.[1] ?? "?";
      value = outlineFixture({ title: `试炼${n}`, constraints: ["〔硬〕沈昭在本章必须开口说出第一个字。", "〔软〕保留雨声。", "〔自由〕收尾自定。"] });
    } else if (name.includes("review")) {
      reviewSeq += 1;
      value = reviewSeq % 2 === 1
        ? JSON.stringify([{ quote: "沈昭张口。", note: "节奏偏慢，删掉重复的雨声描写" }])
        : JSON.stringify([]);
    } else if (name.includes("revise")) {
      value = "沈昭张口，声音比雨还轻。";
    } else {
      value = "沈昭张口。";
    }
    return { id: `run-${engine.calls.length}`, result: Promise.resolve({ stopReason: "completed", value: { done: [value], failed: [] }, agentsStarted: 1 }), async dispose() {} };
  },
};
const ctx = { logger, get: (n) => (n === "workflowEngine" ? engine : undefined) };

function register(list) {
  const map = new Map();
  for (const def of list) map.set(def.name, defineTool(def));
  return (n, a) => {
    const t = map.get(n);
    if (!t) throw new Error(`没有工具 ${n}`);
    return t.execute(a ?? {}, fakeExec());
  };
}
const call = register([...warehouseTools(ctx, () => ws), ...fanoutTools(ctx, () => ws), ...chapterTools(ctx, () => ws), ...directorTools(ctx, () => ws)]);
const next = () => call("forge_director_next", { title: BOOK });

console.log(`阶段十 · 离线全链测试\n沙盒: ${ws}\n`);

const seen = [];
let observedEngineFailure = false;

/** 走一步，同时把「停 / 不停」记下来供 A-5 复查。 */
async function step(label) {
  const n = await next();
  assert.equal(n.ok, true, `${label}: ${JSON.stringify(n)}`);
  seen.push({ label, node: n.node, proceed: n.proceed, chapter: n.chapter });
  return n;
}

await t("A-1 建书后导演指向骨架，且骨架是人工闸门", async () => {
  assert.equal((await call("forge_init_workspace", {})).ok, true);
  const r = await call("forge_create_book", {
    title: BOOK,
    coreIdea: "剑客开口", genreAndAudience: "男频武侠", keyAppeal: "一句话改变关系",
    differentiation: "不用系统流", protagonistDesire: "说出第一句话", mainConflict: "沉默与开口",
    explicitlyAvoid: "不要系统流、不要升级流",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const n = await step("建书后");
  assert.equal(n.node, "design.skeleton");
  assert.equal(n.proceed, false, "骨架必须等人拍板");
});

await t("A-1 四件设计工件走 fan-out 落真源", async () => {
  const plan = await call("forge_fanout_plan", { title: BOOK });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const bodies = {
    skeleton: "# 故事骨架\n\n## 第一部 追求\n沈昭要开口。\n\n## 索引\n\n- 人物 / 沈昭\n",
    worldbook: "## 人物｜沈昭\n\n剑客，沉默。\n",
    layout: "## 第 1 卷（第 1–3 章）｜雨落\n",
    "volume-plan": "## 卷一目标\n沈昭开口。\n",
  };
  for (const artifact of Object.keys(bodies)) {
    const cand = await call("forge_artifact_candidate", { title: BOOK, artifact, body: bodies[artifact] });
    assert.equal(cand.ok, true, `${artifact} 候选：${JSON.stringify(cand)}`);
    const conf = await call("forge_confirm_artifact", { title: BOOK, artifact });
    assert.equal(conf.ok, true, `${artifact} 确认：${JSON.stringify(conf)}`);
  }
});

await t("A-1 设计齐了之后导演才肯开第一章", async () => {
  const n = await step("设计齐");
  assert.equal(n.node, "chapter.outline_confirm", JSON.stringify(n));
  assert.equal(n.chapter, 1);
  assert.equal(n.proceed, true, "细纲是 auto，不该多问");
});

/** 跑完一章。每一步都断言门禁等级跟 DEFAULT_POLICY 一致。 */
async function driveChapter(num) {
  let n = await step(`ch${num} 细纲`);
  assert.equal(n.node, "chapter.outline_confirm", `第 ${num} 章实际 ${n.node}`);
  assert.equal(n.proceed, true, "章细纲是 auto");
  const outline = await call("forge_director_run", { title: BOOK, context: { outlineBrief: "沈昭开口", volumePlan: "卷一：开口", contract: "不许凭空虚构设定。" } });
  assert.equal(outline.ok, true, JSON.stringify(outline));
  assert.ok(outline.done[0].includes("〔硬〕"), "细纲要带约束等级标记");
  assert.equal((await call("forge_outline_draft", { title: BOOK, chapter: num, volume: VOL, body: outline.done[0] })).ok, true);
  assert.equal((await call("forge_confirm_outline", { title: BOOK, chapter: num, volume: VOL })).ok, true);

  n = await step(`ch${num} 备料`);
  assert.equal(n.proceed, true, `第 ${num} 章细纲确认后应放行，实际 ${n.node}`);
  assert.equal((await call("forge_assemble_materials", { title: BOOK, chapter: num, volume: VOL })).ok, true);

  n = await step(`ch${num} 起草`);
  assert.equal(n.proceed, true);

  // 第 2 章故意让引擎炸一次：链必须降级而不是崩，引擎恢复后重试要能接着走。
  if (num === 2) {
    engine.failNext = true;
    const boom = await call("forge_director_run", { title: BOOK, context: { taskText: "写第2章" } });
    assert.equal(boom.ok, false, "引擎炸了不能算成功");
    assert.equal(boom.stage, "run-threw", JSON.stringify(boom));
    assert.match(boom.detail, /网络断了/);
    observedEngineFailure = true;
  }

  const draft = await call("forge_director_run", { title: BOOK, context: { taskText: `写第${num}章` } });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  // 落稿是导演自己做的（director-auto.test.mjs 盯着这一跳）。这里再补一次
  // forge_import_draft 会写成 v2，而审读子代理读的是 latest —— 等于拿一份
  // 重复稿去审，还把真正的 v1 挤成了历史版本。

  let body = draft.done[0];
  for (let round = 1; round <= 3; round++) {
    n = await step(`ch${num} 审读${round}`);
    assert.equal(n.proceed, true, `第 ${num} 章审读第 ${round} 轮应放行，实际 ${n.node}`);
    const rev = await call("forge_director_run", { title: BOOK, context: { draftText: body } });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    const parsed = JSON.parse(rev.done[0]);
    // 派审读也是导演自己做的：跑完这一步状态已经在「审读中」，发现项才回写得进去。
    // 这里再手动派一次会被状态机拒（dispatch_review 只允许从「待审」出发），
    // 而重复派还会把改稿轮次多记一遍。
    const rec = await call("forge_record_findings", {
      title: BOOK, chapter: num, covered: ["结构", "文风", "对话"],
      findings: parsed.map((p) => ({ quote: p.quote, note: p.note, dimension: "结构" })),
      summary: parsed.length === 0 ? "复审通过" : "发现一处问题",
    });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    if (parsed.length === 0) {
      // 回写完才算走完审读：必须重新问一次导演拿新节点。
      const after = await step(`ch${num} 审读通过后`);
      return settleChapter(num, after, body);
    }
    const fixed = await call("forge_director_run", { title: BOOK, context: { findings: parsed, draftText: body } });
    assert.equal(fixed.ok, true, JSON.stringify(fixed));
    body = fixed.done[0];
  }
  throw new Error(`第 ${num} 章三轮审读还没过`);
}

async function settleChapter(num, n, body) {
  assert.equal(n.node, "chapter.settle", `第 ${num} 章审读通过后应停在定稿，实际 ${n.node}`);
  assert.equal(n.proceed, false, "定稿必须等人拍板");
  const st = await call("forge_settle_chapter", { title: BOOK, chapter: num, chapterTitle: `第${num}章 试炼`, body });
  assert.equal(st.ok, true, JSON.stringify(st));
}

await t("A-1 逐章跑通：细纲→备料→起草→审读→改稿→复审→定稿", async () => {
  for (const n of CHAPTERS) await driveChapter(n);
});

await t("A-3 章号连续：定稿目录里是 0001/0002/0003，不跳号不重号", async () => {
  const st = await call("forge_book_status", { title: BOOK });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.status.finalizedChapterCount, 3, `定稿数不对：${st.status.finalizedChapterCount}`);
  const dir = path.join(ws, "书仓", BOOK, "定稿", `卷0${VOL}`);
  const files = (await fs.readdir(dir)).sort();
  assert.equal(files.length, 3, `定稿文件数不对：${JSON.stringify(files)}`);
  assert.deepEqual(files.map((f) => f.slice(0, 6)), ["ch0001", "ch0002", "ch0003"], `章号跳号了：${JSON.stringify(files)}`);
});

await t("A-5 引擎中途炸过一次，整条链没受影响", async () => {
  assert.equal(observedEngineFailure, true, "第 2 章那次引擎故障没真的发生");
  const st = await call("forge_book_status", { title: BOOK });
  assert.equal(st.status.finalizedChapterCount, 3, "引擎炸过之后三章照样定稿");
});

await t("A-4 三章写完，导演转去整卷结算（stop）", async () => {
  let n = await step("三章后");
  if (n.node === "debt.settle") {
    assert.equal(n.proceed, false, "质量债闸门是 stop");
    const debts = await call("forge_list_debts", { title: BOOK });
    assert.equal(debts.ok, true, JSON.stringify(debts));
    for (const d of debts.open ?? debts.debts ?? []) {
      const r = await call("forge_settle_debt", { title: BOOK, id: d.id, action: "已处理", how: "全链测试直接结清" });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    n = await step("清债后");
  }
  assert.equal(n.node, "volume.settle", `实际 ${n.node}`);
  assert.equal(n.proceed, false, "整卷结算是 stop");
});

await t("A-5 stop 的每次都停住了，auto 的每次都没多问", async () => {
  const stopNodes = new Set(["design.skeleton", "design.volume_layout", "chapter.settle", "volume.settle", "debt.settle"]);
  for (const s of seen) {
    if (stopNodes.has(s.node)) {
      assert.equal(s.proceed, false, `${s.label} 命中 stop 节点 ${s.node} 却放行了`);
    } else {
      assert.equal(s.proceed, true, `${s.label} 命中 auto 节点 ${s.node} 却多问了一句`);
    }
  }
  for (const n of ["design.skeleton", "chapter.settle", "volume.settle"]) {
    assert.ok(seen.some((s) => s.node === n && s.proceed === false), `${n} 一次都没停过`);
  }
});

await t("A-1 整卷结算落真源，导演自动往前走", async () => {
  const r = await call("forge_settle_volume", { title: BOOK, volume: VOL, summary: "卷一完成：沈昭开口。" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const n = await step("结算后");
  assert.equal(n.ok, true);
  assert.notEqual(n.node, "volume.settle", "不能卡在同一处反复要结算");
});

await t("A-2 中断后从 Git 与状态机接着走，不重跑已完成步骤", async () => {
  const fresh = register([...warehouseTools(logger, () => ws), ...chapterTools(logger, () => ws), ...directorTools(logger, () => ws)]);
  const st = await fresh("forge_book_status", { title: BOOK });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.status.finalizedChapterCount, 3, "重启后仍认得已定稿三章");
  const n = await fresh("forge_director_next", { title: BOOK });
  assert.equal(n.ok, true, JSON.stringify(n));
  assert.notEqual(n.chapter, 1, "重启后不该回到第 1 章");
});

await t("A-1 收尾：书仓里留下完整可复盘的提交谱系", async () => {
  const st = await wh.bookStatus(ws, BOOK);
  const kinds = new Set(st.recentCommits.map((c) => wh.parseSubject(c.subject)?.kind).filter(Boolean));
  for (const k of ["vol", "design", "ch"]) {
    assert.ok(kinds.has(k), `缺少 ${k}: 提交，实际有 ${[...kinds]}`);
  }
});

await fs.rm(ws, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}