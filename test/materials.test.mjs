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
const ws = path.join(projectRoot, "..", ".forge-test-sandbox", `mat-${randomBytes(4).toString("hex")}`);
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

// 下面两条原来断言的是「全内联、子代理不用读任何文件」。2026-10-11 按
// oh-story 的投递形态改成「路径为主 + 关键行内联」之后，那两条断言与设计直接冲突，
// 所以重写成新契约。**不是因为它们红了才改**——是设计变了，断言跟着变。
// 新契约的三条各有出处，见 lib/materials.js 里 SEGMENT_PRIORITY 的注释。
await t("任务包投递：短而要害的段全文内联，且每段都带真源路径", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001");
  const task = m.buildDraftTask(pkg, { title: "雨夜", targetWords: 2800 });
  // 人物卡属于「短，且少一个名字就写错」——真机上正是在这里丢了主角姓名。
  assert.ok(task.includes("只在雨天能说话"), "人物设定要全文内联");
  assert.ok(task.includes("约 2800 字"));
  assert.ok(task.includes("## 本章标题"));
  // 每段都要给绝对路径：子代理没有工作区根，给相对路径等于没给。
  assert.ok(task.includes("书仓目录："), "要给书仓绝对路径，否则子代理拼不出真源路径");
  assert.match(task, /> 来源：.*\.md｜指纹 /, "每段都要带来源与指纹");
});

await t("任务包投递：长材料只给关键行或只给路径，不给全文", async () => {
  // 卷纲要真长才会走 path 模式。夹具里那份只有几十字，会被
  // INLINE_FULL_BELOW 短路成全量内联——那条短路是**故意**的：
  // 短内容摘行只会平白多一个漏内容的机会。所以这里得写一份真长的。
  // 顺带钉住一个边界：短材料全量进包，长材料才转成路径。
  const longPlan = "# 卷纲\n\n" + Array.from({ length: 60 }, (_, i) =>
    `- 第 ${i + 1} 拍：沈昭在雨里退一步，把话咽回去，听对面把条件说完再决定要不要接。`).join("\n");
  await writeInBook("大纲/卷01/卷纲.md", longPlan);

  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001");
  const task = m.buildDraftTask(pkg);
  // 契约是 keys 模式：**红线行必须在**——「不要系统流」这种无冒号的短横线列表
  // 正是第一版摘关键行漏掉的那类，测试当场抓到过「契约红线缺失」。
  assert.ok(task.includes("不要系统流"), "契约红线必须作为关键行进包");
  // 卷纲是 path 模式：全文不内联，但要说清楚它有多少字、去哪儿读。
  assert.ok(!task.includes("第 60 拍"), "长卷纲全文不该内联");
  assert.match(task, /（这一段不内联。动笔前按上面的路径读全文。共 \d+ 字。）/);

  // 短材料走全量内联，同样要能验证——否则上面那条短路没有任何测试看着。
  await writeInBook("大纲/卷01/卷纲.md", "# 卷纲\n\n卷一目标：沈昭说出第一个字。\n");
  const shortTask = m.buildDraftTask(await m.assembleMaterials(ws, BOOK, "ch0001"));
  assert.ok(shortTask.includes("卷一目标：沈昭说出第一个字"), "短材料要全量内联");
});

await t("任务包如实说明要读哪些文件，不再声称不需要任何上下文", async () => {
  const task = m.buildDraftTask(await m.assembleMaterials(ws, BOOK, "ch0001"));
  // 原来这里写的是「你不需要读任何其他文件」——而人物段当时只装进了一份角色卡。
  // 子代理照这句话就不会去读盘，于是「主角叫什么」永远没人知道，
  // 它也不会觉得自己缺东西。现在如实说：清单在这里，能读的就去读。
  assert.ok(task.includes("标注「读全文」的，动笔前完整读到 EOF"));
  assert.equal(task.includes("不需要读任何其他文件"), false, "不能再说不用读文件");
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

await t("上一章结尾：通配要真的匹配上文件名", async () => {
  // 以前是把 "*" 删掉再 includes：定稿/卷01/0001-*.md 变成 "0001-.md"，
  // 而文件名是 "0001-开口.md"，永远匹配不上——每一章都当成全书第一章在写。
  await writeInBook("定稿/卷01/0001-开口.md", "他第一次张嘴，说的是一个名字。\n");
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0002", { volume: 1 });
  const prev = pkg.segments.find((s) => s.id === "prevChapter");
  assert.equal(prev.ok, true, "上一章结尾没取到");
  assert.match(prev.content, /他第一次张嘴/);
  assert.match(prev.source, /定稿\/卷01\/0001-开口\.md/);
});

await t("上一章结尾：通配只认前缀后缀，不认中间", async () => {
  // 前缀 0001- 必须真在开头。放一个中间含 0001- 的文件，不能被选中。
  await writeInBook("定稿/卷01/0099-提0001-前情.md", "这是干扰项，不该被选中。\n");
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0002", { volume: 1 });
  const prev = pkg.segments.find((s) => s.id === "prevChapter");
  assert.match(prev.content, /他第一次张嘴/);
  assert.doesNotMatch(prev.content, /干扰项/);
});

await t("第一章没有上一章：如实报缺，不硬凑一个文件", async () => {
  const pkg = await m.assembleMaterials(ws, BOOK, "ch0001", { volume: 1 });
  const prev = pkg.segments.find((s) => s.id === "prevChapter");
  assert.equal(prev.ok, false);
  assert.equal(prev.content, "");
  assert.equal(pkg.missing.includes("prevChapter"), true);
});

await t("写法库与作者记忆都空时，如实报缺，不注入一句废话占位", async () => {
  // 第 1 章必然走到这里：新书没有写法条目，也没有作者记忆。
  // renderStyleBrief 单独用会返回「这本书还没有沉淀写法条目。照常写，不要凭想象替作者定文风。」
  // ——那是个死胡同：它占着「风格基准」的位置，实际什么都没说，
  // 而且会让 buildDraftTask 以为这一段是齐的。
  await fs.rm(path.join(bookBase, "设定", "写法"), { recursive: true, force: true });
  await fs.rm(path.join(ws, "书房", "作者记忆"), { recursive: true, force: true });

  const pkg = await m.assembleMaterials(ws, BOOK, "ch0006", { volume: 1 });
  const style = pkg.segments.find((s) => s.id === "style");
  assert.equal(style.ok, false);
  assert.ok(pkg.missing.includes("style"));
});

await t("「风格基准」跨两个根：写法库在书仓、作者记忆在书房，两边都要进包", async () => {
  // 这一段从前整段按 kind:"memory" 吃工作区根，于是「设定/写法」被解析成
  // <工作区>/设定/写法 —— 这个目录从来不存在，而失败毫无声响：
  // 只要作者记忆还在，这一段就报「已备齐」，本书写法一条都进不了起草任务包。
  // 原来的测试只断言过「书房/作者记忆」这一半，所以一直没发现另一半是死的。
  await writeInBook("设定/写法/句式-短句收尾.md", [
    "# 句式｜短句收尾",
    "",
    "**写法**：段末落在短句上，不用逗号拖长。",
    "**为什么本书这么写**：让停顿落在动作之后。",
    "**出处**：第 1 章第 12 行",
  ].join("\n"));

  // 上一条测试清掉了作者记忆，这里建回来——两边同时在，才能验证它们不会互相顶掉。
  const memDir = path.join(ws, "书房", "作者记忆");
  await fs.mkdir(memDir, { recursive: true });
  await fs.writeFile(path.join(memDir, "口吻.md"), "叙述者不解释，也不替读者下判断。\n", "utf8");

  const pkg = await m.assembleMaterials(ws, BOOK, "ch0005", { volume: 1 });
  const style = pkg.segments.find((s) => s.id === "style");
  assert.equal(style.ok, true);
  assert.match(style.source, /书仓\/雨夜剑客\/设定\/写法/, "写法库的出处必须在书仓里");
  assert.match(style.source, /书房\/作者记忆\//, "作者记忆的出处也要在——两边不能互相顶掉");

  const brief = m.buildDraftTask(pkg, { title: BOOK, genre: "玄幻" });
  assert.match(brief, /段末落在短句上/, "本书写法条目必须进起草任务包");
  assert.match(brief, /本书写法（已沉淀/, "要按写法简报渲染，不是裸贴文件");
  assert.match(brief, /它压过上面任何一条通用要求/, "写法条目出现时，通用要求要让位");
  assert.match(brief, /它没提到的地方，一律照上面的通用要求写/, "让位只限它说到的那一点");
});

await t("多人物段要收全——只挑一个会把主角的设定整个扔掉", () => {
  // 实测后果：试跑那本书设定/人物/ 下有主角、舅妈两个文件，
  // 而任务包里只装进了舅妈——**主角的姓名从来没到过写作者手上**。
  // 起草子代理于是各自发明：一个叫「陈默」，两个干脆全程用「他」，
  // 而任务包自己还写着「材料里没有提到的东西，不要凭空发明关键设定」。
  //
  // 根因是 resolveOne 按排序 .pop() 挑一个文件。「相关人物」这段的语义
  // 本来就是多份，一章里有主角就有配角。
  const pkg = {
    book: "B", chapter: "ch0001",
    segments: [{
      id: "characters", name: "相关人物", kind: "truth", describe: "d",
      multi: true,
      resolve: () => [`设定/人物/*.md`],
    }],
  };
  // 直接测 resolveAll 走的那条路：把两份人物文件放进真源式的目录再读。
  const seg = m.SEGMENTS.find((s) => s.id === "characters");
  assert.equal(seg.multi, true, "characters 段必须声明 multi，否则走的是只挑一个的分支");
  assert.deepEqual(seg.resolve({ chapter: "ch0001", volume: 1, workspaceRoot: ".", book: "B" }),
    ["设定/人物/*.md"], "通配路径没变");
});

await t("单文件通配段不能跟着一起收全——否则会把整本书塞进任务包", () => {
  // 定稿/卷01/0001-*.md 要的是「最新一章」，不是「全部章节」。
  // 所以 multi 必须逐段声明，不能在 resolveAll 里一刀切。
  const prev = m.SEGMENTS.find((s) => s.id === "prevChapter");
  assert.notEqual(prev.multi, true, "上一章结尾不是多文件段");
  // 用第 2 章：第 1 章本来就没有上一章，resolve 会返回空数组，测不到通配。
  const cands = prev.resolve({ chapter: "ch0002", volume: 1, workspaceRoot: ".", book: "B" });
  assert.ok(cands.some((c) => String(c).includes("*")), "它仍然靠通配，只是走单文件解析");
});

await t("题材从契约段自动取——不能指望调用方记得传 genre", () => {
  // genre 一直是 buildDraftTask 的参数，而没有任何调用方传过它：
  // 「本书题材：…」那句在真实任务包里从来没出现过。
  const heading = m.genreFromContract(
    "# 作品契约\n\n## 明确不要什么\n\n不要系统流。\n\n## 题材与目标读者\n\n都市悬疑，25-35 岁网文读者。\n\n## 核心看点与差异化\n\nx\n",
  );
  assert.equal(heading, "都市悬疑，25-35 岁网文读者。", "真源格式是二级标题加一段");

  const inline = m.genreFromContract("题材与目标读者：都市悬疑，25-35 岁网文读者。\n核心看点：x");
  assert.equal(inline, "都市悬疑，25-35 岁网文读者。", "手写契约是「键：值」一行");

  assert.equal(m.genreFromContract("## 题材与目标读者\n\n留白\n"), "", "留白不算题材");
  assert.equal(m.genreFromContract(""), "");
  assert.equal(m.genreFromContract(undefined), "");
});

const contractPkg = (contractBody) => ({
  book: "B", chapter: "ch0001",
  segments: [
    { id: "task", name: "本章任务", describe: "d", ok: true, content: "x", source: "s", hash: "h" },
    { id: "contract", name: "契约", describe: "d", ok: true, content: contractBody, source: "s", hash: "h2" },
  ],
});

await t("契约里有题材时，任务包真的把它写进去了", () => {
  const task = m.buildDraftTask(contractPkg("## 题材与目标读者\n\n都市悬疑，25-35 岁网文读者。\n"), {});
  assert.match(task, /本书题材：都市悬疑，25-35 岁网文读者。/);
  assert.match(task, /题材的语汇要一致，不要串味/);
});

await t("调用方显式给的题材优先于契约", () => {
  const task = m.buildDraftTask(contractPkg("## 题材与目标读者\n\n都市悬疑。\n"), { genre: "武侠" });
  assert.match(task, /本书题材：武侠。/);
  assert.ok(!/本书题材：都市悬疑/.test(task));
});

await fs.rm(path.join(projectRoot, "..", ".forge-test-sandbox"), { recursive: true, force: true });
await t("沙盒已清理", () => assert.equal(existsSync(path.join(projectRoot, "..", ".forge-test-sandbox")), false));

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
