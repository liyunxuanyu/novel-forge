/**
 * 阶段二测试：书仓协议与 Git 状态机。
 * 用真实临时 Git 仓库跑，不 mock —— 状态要从 Git 推导，mock 掉 Git 就什么都没测到。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

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

// 沙盒放项目目录下，不用 %TEMP%。本机 %TEMP% 落在用户家目录内，
// 而 C:\Users\<user> 本身就是一个空的 Git 仓库 —— 用 %TEMP% 会把测试写进真实环境。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(projectRoot, ".test-sandbox", `wf-${randomBytes(4).toString("hex")}`);
await fs.mkdir(sandbox, { recursive: true });
console.log(`阶段二 · 书仓协议测试\n沙盒: ${sandbox}\n`);

const CONCEPT = {
  核心创意: "一个只能在雨天开口说话的剑客",
  "题材与目标读者": "东方玄幻 / 男频付费读者",
  主角核心欲望: "想在有生之年说完一句完整的话",
  主要冲突: "他必须在仇人面前开口，而开口就意味着暴露",
  核心看点: "沉默与表达的对撞",
  差异化方向: "不写打斗升级，写沟通的代价",
  "明确不要什么": "不要系统流、不要无敌无敌再无敌",
  状态: "已确认",
};

// ── 纯函数 ───────────────────────────────────────────────────────────────
await t("parseSubject 解析裸前缀", () => {
  assert.deepEqual(wh.parseSubject("vol: 建书《测试》"), { kind: "vol", scope: null, message: "建书《测试》" });
});
await t("parseSubject 解析带章号 Scope", () => {
  const r = wh.parseSubject("design(ch0003): 确认章细纲");
  assert.equal(r.kind, "design");
  assert.equal(r.scope, "ch0003");
  assert.equal(r.message, "确认章细纲");
});
await t("parseSubject 对非法提交信息返回 null", () => {
  assert.equal(wh.parseSubject("随手写的提交"), null);
  assert.equal(wh.parseSubject(""), null);
  assert.equal(wh.parseSubject(null), null);
});
await t("chapterFromPaths 从定稿路径认章号", () => {
  assert.equal(wh.chapterFromPaths(["定稿/卷01/0007-雨夜.md"]), "ch0007");
  assert.equal(wh.chapterFromPaths(["定稿\\卷02\\0042-x.md", "别的东西"]), "ch0042");
  assert.equal(wh.chapterFromPaths(["契约/作品契约.md"]), null);
  assert.equal(wh.chapterFromPaths([]), null);
});

await t("validateTitle 拦非法书名", () => {
  assert.equal(wh.validateTitle(""), "书名不能为空");
  assert.equal(wh.validateTitle("   "), "书名不能为空");
  assert.ok(wh.validateTitle("a/b"));
  assert.ok(wh.validateTitle("a:b"));
  assert.ok(wh.validateTitle("CON"));
  assert.ok(wh.validateTitle("x".repeat(65)));
});
await t("validateTitle 放行正常书名", () => {
  assert.equal(wh.validateTitle("雨夜剑客"), null);
  assert.equal(wh.validateTitle(" 雨夜剑客 "), null);
});

// ── 初始化工作区 ─────────────────────────────────────────────────────────
let initResult;
await t("initWorkspace 建立目录骨架并完成首次提交", async () => {
  initResult = await wh.initWorkspace(sandbox);
  assert.equal(initResult.ok, true, JSON.stringify(initResult));
  assert.equal(initResult.committed, true);
  assert.ok(existsSync(path.join(sandbox, "书仓")));
  for (const d of wh.STUDIO_DIRS) assert.ok(existsSync(path.join(sandbox, "书房", d)), `缺 书房/${d}`);
});
await t("工作区已是 Git 仓库", async () => assert.equal(await wh.isRepo(sandbox), true));
await t("书房有内容时仍不入库", async () => {
  // 只建空目录测不出来：git 不跟踪空目录，必须有真实文件才能验证忽略规则生效。
  const idea = path.join(sandbox, "书房", "灵感池", "一条脑洞.md");
  await fs.writeFile(idea, "# 一条脑洞\n", "utf8");
  const tracked = await wh.git(["status", "--porcelain"], sandbox);
  assert.equal(tracked.stdout.includes("灵感池"), false, `书房内容出现在待提交列表：${tracked.stdout}`);
  const ignored = await wh.git(["status", "--porcelain", "--ignored"], sandbox);
  assert.match(ignored.stdout, /书房/);
  await fs.rm(idea, { force: true });
});
await t("initWorkspace 幂等：重复调用不重复提交", async () => {
  const again = await wh.initWorkspace(sandbox);
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRepo, true);
  assert.equal(again.committed, false);
});

// ── 建书 ─────────────────────────────────────────────────────────────────
let book;
await t("createBook 建书并做 vol: 首次提交", async () => {
  book = await wh.createBook(sandbox, { title: "雨夜剑客", concept: CONCEPT });
  assert.equal(book.ok, true, JSON.stringify(book));
  assert.match(book.bookId, /^b-[0-9a-f]{8}$/);
});
await t("书仓文件齐备", async () => {
  const p = wh.bookPaths(sandbox, "雨夜剑客");
  for (const f of [p.state, p.concept, p.contract]) assert.ok(existsSync(f), `缺 ${f}`);
  for (const d of [p.outline, p.setting, p.ledger, p.final]) assert.ok(existsSync(d), `缺 ${d}`);
});
await t("首次提交前缀是 vol:", async () => {
  const r = await wh.git(["log", "--format=%s"], sandbox);
  const subjects = r.stdout.trim().split("\n");
  assert.equal(subjects[0], "vol: 建书《雨夜剑客》");
});
await t("构想快照冻结了全部七要素", async () => {
  const p = wh.bookPaths(sandbox, "雨夜剑客");
  const text = await fs.readFile(p.concept, "utf8");
  for (const label of ["题材与目标读者", "核心看点", "差异化方向", "主角核心欲望", "主要冲突", "明确不要什么", "核心创意"]) {
    assert.ok(text.includes(`## ${label}`), `快照缺 ${label}`);
  }
  assert.ok(text.includes("只能在雨天开口说话的剑客"));
  assert.ok(text.includes("只读"));
});
await t("重复建同名书被拒，且不产生第二次 vol: 提交", async () => {
  const before = (await wh.git(["log", "--format=%s"], sandbox)).stdout;
  const dup = await wh.createBook(sandbox, { title: "雨夜剑客", concept: CONCEPT });
  assert.equal(dup.ok, false);
  assert.equal(dup.stage, "duplicate");
  const after = (await wh.git(["log", "--format=%s"], sandbox)).stdout;
  assert.equal(before, after, "重复建书产生了额外提交");
});
await t("非法书名被拒且不落盘", async () => {
  const bad = await wh.createBook(sandbox, { title: "a/b", concept: CONCEPT });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, "validate-title");
});
await t("listBooks 列出已建的书", async () => {
  const books = await wh.listBooks(sandbox);
  assert.equal(books.length, 1);
  assert.equal(books[0].title, "雨夜剑客");
  assert.equal(books[0].bookId, book.bookId);
});

// ── 提交前缀白名单 ───────────────────────────────────────────────────────
await t("commitPaths 拒绝未登记的前缀", async () => {
  const r = await wh.commitPaths(sandbox, ["书仓/雨夜剑客/契约/作品契约.md"], "wip: 随手改");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate-subject");
});
await t("commitPaths 对无变化返回 no-change，不产生空提交", async () => {
  const r = await wh.commitPaths(sandbox, ["书仓/雨夜剑客/契约/作品契约.md"], "design: 空改");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "no-change");
});

// ── 章号两级推导 ─────────────────────────────────────────────────────────
await t("artifactChapter：从未提交的工件返回明确理由", async () => {
  const r = await wh.artifactChapter(sandbox, "书仓/雨夜剑客/大纲/故事骨架.md");
  assert.equal(r.ok, true);
  assert.equal(r.commit, null);
  assert.match(r.reason, /从未提交/);
});
await t("artifactChapter：第一级 —— 从 Commit Scope 认章号", async () => {
  const rel = "书仓/雨夜剑客/大纲/卷01细纲.md";
  await fs.writeFile(path.join(sandbox, rel), "# 卷01 细纲\n", "utf8");
  const c = await wh.commitPaths(sandbox, [rel], "design(ch0003): 确认章细纲");
  assert.equal(c.ok, true, JSON.stringify(c));
  const r = await wh.artifactChapter(sandbox, rel);
  assert.equal(r.chapter, "ch0003");
  assert.equal(r.via, "scope");
  assert.equal(r.kind, "design");
});
await t("artifactChapter：第二级 —— 从定稿路径兜底认章号", async () => {
  const rel = "书仓/雨夜剑客/定稿/卷01/0007-雨夜.md";
  await fs.mkdir(path.dirname(path.join(sandbox, rel)), { recursive: true });
  await fs.writeFile(path.join(sandbox, rel), "# 第七章\n", "utf8");
  const c = await wh.commitPaths(sandbox, [rel], "ch: 第七章 雨夜");
  assert.equal(c.ok, true, JSON.stringify(c));
  const r = await wh.artifactChapter(sandbox, rel);
  assert.equal(r.chapter, "ch0007");
  assert.equal(r.via, "path", "应走路径兜底而不是 Scope");
});
await t("artifactChapter：两级都不命中即无章号，且说明原因", async () => {
  const r = await wh.artifactChapter(sandbox, "书仓/雨夜剑客/契约/作品契约.md");
  assert.equal(r.chapter, null);
  assert.match(r.reason, /不带章号/);
});

// ── 状态查询 ─────────────────────────────────────────────────────────────
await t("bookStatus 从 Git 推导出正确状态", async () => {
  const s = await wh.bookStatus(sandbox, "雨夜剑客");
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.title, "雨夜剑客");
  assert.equal(s.bookId, book.bookId);
  assert.equal(s.schema, wh.SCHEMA_VERSION);
  assert.equal(s.finalizedChapterCount, 1);
  assert.equal(s.lastChapter, "ch0007");
  assert.deepEqual(s.volumesPresent, [1]);
  assert.equal(s.lastCommit.kind, "ch");
});
await t("bookStatus 的 recentCommits 倒序且能解析前缀", async () => {
  const s = await wh.bookStatus(sandbox, "雨夜剑客");
  assert.ok(s.recentCommits.length >= 3);
  assert.equal(s.recentCommits[0].subject, "ch: 第七章 雨夜");
  assert.ok(s.recentCommits.every((c) => c.kind !== null), "有无法解析前缀的提交");
});
await t("bookStatus 对不存在的书返回明确理由", async () => {
  const s = await wh.bookStatus(sandbox, "没有这本书");
  assert.equal(s.ok, false);
  assert.equal(s.stage, "no-book");
});
await t("断连恢复：新建实例查询同一书仓结果一致", async () => {
  const a = await wh.bookStatus(sandbox, "雨夜剑客");
  const mod2 = await import(`../lib/warehouse.js?cachebust=${Date.now()}`);
  const b = await mod2.bookStatus(sandbox, "雨夜剑客");
  assert.deepEqual({ ...a }, { ...b }, "重载模块后状态不一致");
});

// ── 嵌套仓库防护 ─────────────────────────────────────────────────────────
await t("工作区嵌在别的仓库里时被拒绝，不把提交写进别人历史", async () => {
  const outer = path.join(projectRoot, ".test-sandbox", `outer-${randomBytes(3).toString("hex")}`);
  await fs.mkdir(outer, { recursive: true });
  await wh.git(["init", "-q"], outer);
  const inner = path.join(outer, "内层书仓");
  await fs.mkdir(inner, { recursive: true });
  const r = await wh.initWorkspace(inner);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.stage, "nested-in-other-repo");
  assert.match(r.detail, /独立仓库/);
  await fs.rm(outer, { recursive: true, force: true });
});

// ── 收尾 ─────────────────────────────────────────────────────────────────
await fs.rm(sandbox, { recursive: true, force: true });
await fs.rm(path.join(projectRoot, ".test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, ".test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
