/** 阶段六测试：开书 fan-out 的依赖调度、候选/真源分离、一致性检查。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as fo from "../lib/fanout.js";
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
const ws = path.join(projectRoot, ".test-sandbox", `fan-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

console.log(`阶段六 · fan-out 测试\n沙盒: ${ws}\n`);

await wh.initWorkspace(ws);
await wh.createBook(ws, {
  title: BOOK,
  concept: { 核心创意: "x", 题材与目标读者: "x", 核心看点: "x", 差异化方向: "x", 主角核心欲望: "x", 主要冲突: "x", "明确不要什么": "x" },
});
const bookBase = wh.bookPaths(ws, BOOK).base;

// ── 标准 1：依赖分层 ─────────────────────────────────────────────────────
await t("依赖分层：骨架 -> (世界书 || 分卷布局) -> 卷规划", () => {
  const { rounds, stuck } = fo.planRounds();
  assert.deepEqual(rounds, [["skeleton"], ["layout", "worldbook"], ["volume-plan"]]);
  assert.deepEqual(stuck, []);
});
await t("同一层里的工件互不依赖", () => {
  const { rounds } = fo.planRounds();
  for (const round of rounds) {
    for (const id of round) {
      const a = fo.ARTIFACT_BY_ID[id];
      assert.ok(a.deps.every((d) => !round.includes(d)), `${id} 的依赖 ${a.deps} 不该和它同层`);
    }
  }
});

// ── 标准 6：幂等 ─────────────────────────────────────────────────────────
await t("刚建书：只有骨架能立刻派，其余都卡在依赖上", async () => {
  const p = await fo.pendingArtifacts(ws, BOOK);
  assert.deepEqual(p.landed, []);
  assert.deepEqual(p.ready.map((x) => x.id), ["skeleton"]);
  assert.deepEqual(p.blocked.map((x) => x.id), ["layout", "worldbook", "volume-plan"]);
  assert.deepEqual(p.blocked.find((x) => x.id === "volume-plan").waitingOn, ["skeleton", "layout"]);
});

async function land(artifactId, body) {
  const r = await fo.confirmArtifact(ws, BOOK, artifactId, body);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

await t("刚建书时，设定目录是空的，不算世界书已落真源", async () => {
  assert.ok(existsSync(path.join(bookBase, "设定")), "书仓骨架里确实有空的设定目录");
  const p = await fo.pendingArtifacts(ws, BOOK);
  assert.ok(!p.landed.includes("worldbook"), "空目录不该被当成已落真源");
});

await t("确认前真源里没有骨架", () => {
  assert.equal(existsSync(path.join(bookBase, "大纲", "故事骨架.md")), false);
});

await t("骨架落真源后：世界书与分卷布局同时就绪，卷规划仍卡着", async () => {
  await land("skeleton", "# 故事骨架\n\n## 索引\n- 人物 / 沈昭\n- 地点 / 听雨楼\n");
  const p = await fo.pendingArtifacts(ws, BOOK);
  assert.deepEqual(p.landed, ["skeleton"]);
  assert.deepEqual(p.ready.map((x) => x.id).sort(), ["layout", "worldbook"]);
  assert.deepEqual(p.blocked.map((x) => x.id), ["volume-plan"]);
});

await t("确认骨架产生一次 design: 提交", async () => {
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "design: 确认故事骨架");
});

await t("布局也落真源后：卷规划与世界书同时就绪（两者互不依赖，可并行）", async () => {
  await land("layout", "## 第 1 卷（第 1–20 章）｜雨落\n");
  const p = await fo.pendingArtifacts(ws, BOOK);
  assert.deepEqual(p.ready.map((x) => x.id).sort(), ["volume-plan", "worldbook"]);
  assert.deepEqual(p.blocked, []);
});

await t("已落真源的工件不会被重复派发（幂等）", async () => {
  const p = await fo.pendingArtifacts(ws, BOOK);
  assert.ok(!p.ready.some((x) => x.id === "skeleton"));
  assert.ok(!p.ready.some((x) => x.id === "layout"));
  assert.deepEqual(p.landed.sort(), ["layout", "skeleton"]);
});

// ── 标准 4：候选与真源分离 ───────────────────────────────────────────────
await t("候选落在草稿区，不进真源", () => {
  const c = fo.candidatePath(ws, BOOK, "skeleton");
  assert.ok(c.includes("草稿"), `候选路径 ${c} 不在草稿区`);
  assert.ok(!c.includes("书仓"), "候选路径不该在书仓里");
});

// ── 世界书按条目拆分 ─────────────────────────────────────────────────────
await t("世界书一次产出多份条目，按标题拆成多文件", async () => {
  const body = [
    "## 人物｜沈昭",
    "",
    "只在雨天能说话。",
    "",
    "## 地点｜听雨楼",
    "",
    "城中最高的楼。",
    "",
    "## 规则｜沉默三日即失语",
    "",
    "沉默满三日就永久失语。",
    "",
  ].join("\n");
  const r = await land("worldbook", body);
  assert.equal(r.files.length, 3);
  assert.ok(r.files.includes("设定/人物/沈昭.md"));
  assert.ok(r.files.includes("设定/地点/听雨楼.md"));
  assert.ok(r.files.includes("设定/规则/沉默三日即失语.md"));
  assert.ok(existsSync(path.join(bookBase, "设定", "人物", "沈昭.md")));
  const log = await wh.git(["log", "-1", "--format=%s"], ws);
  assert.equal(log.stdout.trim(), "design: 确认世界书");
});

await t("世界书里没有条目标题就拒绝落真源", async () => {
  const r = await fo.confirmArtifact(ws, BOOK, "worldbook", "没有标题的散文");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-entries");
});

// ── 标准 3：一致性检查 ───────────────────────────────────────────────────
await t("骨架索引里的实体在世界书里都有 → 一致", async () => {
  const r = await fo.consistencyCheck(ws, BOOK);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.consistent, true);
  assert.equal(r.indexCount, 2);
  assert.equal(r.worldbookCount, 3);
  assert.match(r.detail, /全部在世界书里有条目/);
});

await t("骨架提到但世界书没有的实体 → 报缺失", async () => {
  await land("skeleton", "# 故事骨架\n\n## 索引\n- 人物 / 沈昭\n- 地点 / 听雨楼\n- 人物 / 断剑\n");
  const r = await fo.consistencyCheck(ws, BOOK);
  assert.equal(r.consistent, false);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].name, "断剑");
  assert.match(r.detail, /1 个缺失/);
});

await t("同名但类型对不上 → 报类型不符", async () => {
  await land("skeleton", "# 故事骨架\n\n## 索引\n- 物品 / 听雨楼\n");
  const r = await fo.consistencyCheck(ws, BOOK);
  assert.equal(r.consistent, false);
  assert.equal(r.typeMismatch.length, 1);
  assert.match(r.typeMismatch[0].note, /类型对不上/);
});

await t("世界书里多出来的条目也报出来", async () => {
  await land("skeleton", "# 故事骨架\n\n## 索引\n- 人物 / 沈昭\n");
  const r = await fo.consistencyCheck(ws, BOOK);
  assert.ok(r.extra.length > 0);
  assert.ok(r.extra.some((e) => e.name === "听雨楼"));
});

await t("骨架里没有索引节就拒绝核对，不瞎猜", async () => {
  await land("skeleton", "# 故事骨架\n\n没有索引这一节。\n");
  const r = await fo.consistencyCheck(ws, BOOK);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-index");
  assert.match(r.detail, /索引/);
});

await t("没有骨架时一致性检查给出明确指引", async () => {
  const ws2 = path.join(projectRoot, ".test-sandbox", `fan2-${randomBytes(3).toString("hex")}`);
  await fs.mkdir(ws2, { recursive: true });
  await wh.initWorkspace(ws2);
  await wh.createBook(ws2, {
    title: "另一本",
    concept: { 核心创意: "x", 题材与目标读者: "x", 核心看点: "x", 差异化方向: "x", 主角核心欲望: "x", 主要冲突: "x", "明确不要什么": "x" },
  });
  const r = await fo.consistencyCheck(ws2, "另一本");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-skeleton");
  await fs.rm(ws2, { recursive: true, force: true });
});

// ── 索引解析 ─────────────────────────────────────────────────────────────
await t("索引解析：认「- 类型 / 名称」", () => {
  const r = fo.parseSkeletonIndex("# 骨架\n\n## 索引\n- 人物 / 沈昭\n- 地点 / 听雨楼\n\n## 别的\n- 人物 / 不该算\n");
  assert.equal(r.found, true);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[0], { type: "人物", name: "沈昭" });
});
await t("索引解析：没有索引节就返回 found:false", () => {
  assert.equal(fo.parseSkeletonIndex("# 骨架\n\n没索引\n").found, false);
});
await t("索引解析：没类型的行不算，类型紧贴斜杠也算", () => {
  const r = fo.parseSkeletonIndex("## 索引\n- 沈昭\n- 这行是散文不是条目\n- 人物/沈昭\n");
  assert.equal(r.entries.length, 1, "只有「人物/沈昭」这一行算条目");
  assert.deepEqual(r.entries[0], { type: "人物", name: "沈昭" });
});
await t("索引解析：不认识的类型不算（避免污染世界书类型表）", () => {
  const r = fo.parseSkeletonIndex("## 索引\n- 情绪 / 恐惧\n- 人物 / 沈昭\n");
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].type, "人物");
});

// ── 边界 ─────────────────────────────────────────────────────────────────
await t("未知工件被拒", async () => {
  const r = await fo.confirmArtifact(ws, BOOK, "不存在", "内容");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "unknown-artifact");
});
await t("空内容被拒", async () => {
  const r = await fo.confirmArtifact(ws, BOOK, "volume-plan", "   ");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty-body");
});
await t("卷规划落真源后，全部工件都齐了", async () => {
  await land("volume-plan", "# 卷一 卷纲\n\n本卷目标：沈昭开口。\n");
  const p = await fo.pendingArtifacts(ws, BOOK);
  assert.deepEqual(p.landed.sort(), ["layout", "skeleton", "volume-plan", "worldbook"]);
  assert.deepEqual(p.ready, []);
  assert.deepEqual(p.blocked, []);
});

await fs.rm(path.join(projectRoot, ".test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, ".test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
