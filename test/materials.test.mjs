/** 阶段三测试：十段材料与自包含起草任务包。 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as wh from "../lib/warehouse.js";
import * as m from "../lib/materials.js";

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
const ws = path.join(projectRoot, ".test-sandbox", `mat-${randomBytes(4).toString("hex")}`);
await fs.mkdir(ws, { recursive: true });
const BOOK = "雨夜剑客";

console.log(`阶段三 · 十段材料测试\n沙盒: ${ws}\n`);

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
  return path.relative(ws, abs).replace(/\\/g, "/");
}

await t("bookStatus 反映刚建的书", async () => {
  const s = await wh.bookStatus(ws, BOOK);
  assert.equal(s.ok, true);
  assert.equal(s.finalizedChapterCount, 0);
});

await t("十段材料全部到位且顺序固定", async () => {
  await writeInBook("大纲/卷01/ch0001-细纲.md", "# 第一章细纲\n\n他必须在雨里对仇人说出那三个字。\n");
  await writeInBook("定稿/卷01/0000-序章.md", "雨下到第三日的时候，他第一次张嘴。\n");
  await writeInBook("卷账/前情提要.md", "他叫沈昭，左耳有旧伤。\n");
  await writeInBook("设定/人物/沈昭.md", "# 沈昭\n\n只在雨天能说话。沉默三日即失语。\n");
  await writeInBook("设定/地点/听雨楼.md", "# 听雨楼\n\n城中最高的楼，木质，雨天漏水。\n");
  await writeInBook("卷账/伏笔台账.md", "# 伏笔\n\n- 断剑：埋于序章，待收于第 7 章\n");
  await writeInBook("大纲/卷01/卷纲.md", "# 卷纲\n\n卷一目标：沈昭说出第一个字。\n");
  await fs.mkdir(path.join(ws, "书房", "作者记忆"), { recursive: true });
  await fs.writeFile(path.join(ws, "书房", "作者记忆", "文风.md"), "# 文风\n\n短句。少形容词。多用动作推进。\n", "utf8");

  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001");
  assert.equal(pkg.segments.length, 10, `十段材料，实际 ${pkg.segments.length} 段`);
  assert.deepEqual(pkg.segments.map((s) => s.id), m.SEGMENTS.map((s) => s.id));
});

await t("每段材料都带来源路径与内容指纹", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001");
  for (const s of pkg.segments.filter((x) => x.ok)) {
    assert.ok(s.source, `${s.id} 缺来源`);
    assert.match(s.hash, /^[0-9a-f]{16}$/, `${s.id} 缺指纹`);
    assert.ok(s.content.length > 0, `${s.id} 内容为空`);
  }
  const task = pkg.segments.find((s) => s.id === "task");
  assert.match(task.source, /ch0001-细纲\.md$/);
});

await t("作者记忆与书仓真源分开取材", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001");
  const style = pkg.segments.find((s) => s.id === "style");
  assert.match(style.source, /^书房\/作者记忆\//);
  const contract = pkg.segments.find((s) => s.id === "contract");
  assert.match(contract.source, /^书仓\/雨夜剑客\//);
});

await t("材料包指纹稳定：同样输入两次得到同一个哈希", async () => {
  const a = await m.assembleMaterials(ws, BOOK, "ch0001");
  const b = await m.assembleMaterials(ws, BOOK, "ch0001");
  assert.equal(a.packageHash, b.packageHash);
});

await t("来源变了就标过期，不静默沿用旧摘录", async () => {
  const before = await m.assembleMaterials(ws, BOOK, "ch0001");
  await writeInBook("卷账/前情提要.md", "# 前情提要（改过）\n\n他叫沈昭，左耳有旧伤，且欠着一条命。\n");
  const after = await m.assembleMaterials(ws, BOOK, "ch0001", { previous: before.segments });

  assert.deepEqual(after.stale, ["recap"]);
  const recap = after.segments.find((s) => s.id === "recap");
  assert.equal(recap.stale, true);
  assert.match(recap.staleReason, /来源已变/);
  assert.notEqual(after.packageHash, before.packageHash);
});

await t("缺的材料如实报缺，且带原因", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0009");
  assert.ok(pkg.missing.length > 0, "ch0009 没有任何材料，应该全是缺的");
  for (const s of pkg.segments.filter((x) => !x.ok)) {
    assert.ok(s.reason, `${s.id} 缺了但没说为什么`);
  }
});

// ── 自包含任务包 ─────────────────────────────────────────────────────────
await t("任务包含十段的标题，缺的也占位不省略", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0009");
  const task = m.buildDraftTask(pkg);
  for (const seg of m.SEGMENTS) assert.ok(task.includes(seg.name), `任务包缺 ${seg.name}`);
  assert.ok(task.includes("（缺）"), "缺的材料要有显式标记");
});

await t("任务包自包含：真源内容直接进正文区，不只是路径", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001");
  const task = m.buildDraftTask(pkg, { title: "雨夜", targetWords: 2800 });
  assert.ok(task.includes("他必须在雨里对仇人说出那三个字"), "本章任务内容没进任务包");
  assert.ok(task.includes("不要系统流"), "契约红线没进任务包");
  assert.ok(task.includes("只在雨天能说话"), "人物设定没进任务包");
  assert.ok(task.includes("听雨楼"), "场景设定没进任务包");
  assert.ok(task.includes("断剑"), "伏笔台账没进任务包");
  assert.ok(task.includes("短句"), "作者文风记忆没进任务包");
  assert.ok(task.includes("约 2800 字"));
  assert.ok(task.includes("## 本章标题"));
});

await t("任务包声明不需要任何额外上下文", async () => {
  const task = m.buildDraftTask(await m.assembleMaterials(ws, BOOK, "ch0001"));
  assert.ok(task.includes("不需要读任何其他文件"));
  assert.ok(task.includes("不要凭空发明关键设定"));
  assert.ok(task.includes("【存疑】"));
});

await t("带本次指令时追加到任务包", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001", { authorNote: "这一章不许超过 2000 字" });
  const note = pkg.segments.find((s) => s.id === "authorNote");
  assert.equal(note.ok, true);
  assert.equal(note.source, "本次补充");
  const task = m.buildDraftTask(pkg, { extraInstructions: "多用雨声做转场" });
  assert.ok(task.includes("不许超过 2000 字"));
  assert.ok(task.includes("多用雨声做转场"));
});

await t("任务包不泄露宿主路径（只用书仓相对路径）", async () => {
  const task = m.buildDraftTask(await m.assembleMaterials(ws, BOOK, "ch0001"));
  assert.equal(task.includes(projectRoot), false, "任务包里出现了绝对路径");
});

await fs.rm(path.join(projectRoot, ".test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, ".test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
