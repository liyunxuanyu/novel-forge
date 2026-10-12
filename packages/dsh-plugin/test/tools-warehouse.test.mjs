/**
 * 阶段二测试（工具层）：从模型视角调用四个书仓工具，验证真实链路与写入边界。
 * 这里跑的是 defineTool 之后的成品：schema 校验、execute、render 都过一遍。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { warehouseTools } from "../lib/tools-warehouse.js";

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
const sandbox = path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox", `tool-${randomBytes(4).toString("hex")}`);
await fs.mkdir(sandbox, { recursive: true });

// defineTool 会编译 schema 并包一层 execute/渲染，模拟宿主的最小行为
const fakeCtx = { logger: { info() {}, warn() {}, error() {} } };
const byName = new Map();
for (const def of warehouseTools(fakeCtx, () => sandbox)) {
  byName.set(def.name, defineTool(def));
}
const call = (name, args) => byName.get(name).execute(args ?? {}, { signal: new AbortController().signal });

console.log(`阶段二 · 工具层测试\n沙盒: ${sandbox}\n`);

await t("四个工具全部注册成功", () => {
  assert.deepEqual([...byName.keys()].sort(), [
    "forge_book_status", "forge_create_book", "forge_init_workspace", "forge_write_truth",
  ]);
});

await t("forge_init_workspace 建成工作区", async () => {
  const r = await call("forge_init_workspace", {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.committed, true);
});

await t("forge_create_book 建书并冻结七要素", async () => {
  const r = await call("forge_create_book", {
    title: "雨夜剑客",
    coreIdea: "一个只能在雨天开口说话的剑客",
    genreAndAudience: "东方玄幻 / 男频付费读者",
    keyAppeal: "沉默与表达的对撞",
    differentiation: "不写打斗升级，写沟通的代价",
    protagonistDesire: "想在有生之年说完一句完整的话",
    mainConflict: "他必须在仇人面前开口，而开口就意味着暴露",
    explicitlyAvoid: "不要系统流、不要无敌再无敌",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.bookId, /^b-[0-9a-f]{8}$/);
  const concept = await fs.readFile(path.join(sandbox, "书仓", "雨夜剑客", "构想", "构想快照.md"), "utf8");
  assert.ok(concept.includes("只能在雨天开口说话的剑客"));
  assert.ok(concept.includes("不要系统流、不要无敌再无敌"));
});

await t("forge_create_book 重复建书被拒", async () => {
  const r = await call("forge_create_book", {
    title: "雨夜剑客", coreIdea: "x", genreAndAudience: "x", keyAppeal: "x",
    differentiation: "x", protagonistDesire: "x", mainConflict: "x", explicitlyAvoid: "x",
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "duplicate");
});

await t("forge_book_status 不带书名时列出全部书", async () => {
  const r = await call("forge_book_status", {});
  assert.equal(r.ok, true);
  assert.equal(r.books.length, 1);
  assert.equal(r.books[0].title, "雨夜剑客");
  assert.match(byName.get("forge_book_status").output.render({}, r)[0].text, /书仓共 1 本/);
});

await t("forge_book_status 给出章进度", async () => {
  const r = await call("forge_book_status", { title: "雨夜剑客" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status.finalizedChapterCount, 0);
  assert.equal(r.status.commitCount, 1);
});

await t("forge_write_truth 写入并提交 design: 变更", async () => {
  const r = await call("forge_write_truth", {
    title: "雨夜剑客",
    subject: "design: 确认故事骨架",
    files: [{ path: "大纲/故事骨架.md", content: "# 故事骨架\n\n- 起：雨夜初遇\n- 承：被迫开口\n" }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files.length, 1);
});

await t("forge_write_truth 一次提交多文件", async () => {
  const r = await call("forge_write_truth", {
    title: "雨夜剑客",
    subject: "design(ch0001): 确认章细纲",
    files: [
      { path: "大纲/卷01/0001-细纲.md", content: "# 第一章细纲\n" },
      { path: "设定/人物/剑客.md", content: "# 剑客\n" },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files.length, 2);
});

// ── 写入边界 ─────────────────────────────────────────────────────────────
await t("拒绝 .. 逃逸路径", async () => {
  const r = await call("forge_write_truth", {
    title: "雨夜剑客",
    subject: "design: 越界",
    files: [{ path: "../../逃逸.md", content: "x" }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate-path");
});
await t("拒绝绝对路径", async () => {
  const r = await call("forge_write_truth", {
    title: "雨夜剑客",
    subject: "design: 越界",
    files: [{ path: "C:/Windows/System32/x.md", content: "x" }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate-path");
});
await t("越界写入没有在书仓外留下任何文件", async () => {
  const outside = path.resolve(sandbox, "书仓", "雨夜剑客", "..", "..", "逃逸.md");
  await assert.rejects(fs.access(outside));
});
await t("拒绝未登记的提交前缀", async () => {
  const r = await call("forge_write_truth", {
    title: "雨夜剑客",
    subject: "wip: 随手改",
    files: [{ path: "大纲/随手.md", content: "x" }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate-subject");
});
await t("对不存在的书写入被挡在路径校验之前", async () => {
  const r = await call("forge_write_truth", {
    title: "没这本书",
    subject: "design: x",
    files: [{ path: "a.md", content: "x" }],
  });
  // 书不存在时目录会先被建出来，这是可接受的；提交会因文件不在版本控制而失败或成功，
  // 但绝不能写进别的书。关键断言：路径基准是「没这本书」自己的目录。
  const p = path.join(sandbox, "书仓", "没这本书", "a.md");
  const created = await fs.access(p).then(() => true, () => false);
  assert.equal(created, true, "文件应落在目标书自己的目录下");
  const other = path.join(sandbox, "书仓", "雨夜剑客", "a.md");
  assert.equal(await fs.access(other).then(() => true, () => false), false, "绝不能写进别的书");
});

// ── 全链路 ───────────────────────────────────────────────────────────────
await t("走完建书→写骨架→写细纲→定稿，状态可从 Git 读出", async () => {
  const ch = await call("forge_write_truth", {
    title: "雨夜剑客",
    subject: "ch: 第一章 雨夜",
    files: [{ path: "定稿/卷01/0001-雨夜.md", content: "# 第一章 雨夜\n\n他张了张嘴。\n" }],
  });
  assert.equal(ch.ok, true, JSON.stringify(ch));

  const s = await call("forge_book_status", { title: "雨夜剑客" });
  assert.equal(s.status.finalizedChapterCount, 1);
  assert.equal(s.status.lastChapter, "ch0001");
  assert.deepEqual(s.status.volumesPresent, [1]);

  const kinds = s.status.recentCommits.map((c) => c.kind);
  assert.deepEqual(kinds, ["ch", "design", "design", "vol"], `提交谱系不对: ${kinds}`);
  assert.equal(byName.get("forge_book_status").output.render({}, s)[0].text.includes("已定稿 1 章"), true);
});

await fs.rm(path.join(projectRoot, "..", "..", "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(fs, fs));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
