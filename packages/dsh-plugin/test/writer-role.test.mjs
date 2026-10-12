/**
 * 写手身份层与细纲字段闸门。
 *
 * 这两条是 2026-10-11 才加的，来源见 lib/writer-role.js 与 lib/outline.js
 * 的文件头注释。测试要钉住三件事：
 *
 * 1. 身份层**真的会被渲染进任务包**，且四段齐全（优先级/铁律/怎么写/写作纪律）。
 * 2. 优先级链存在——这是 oh-story `style-resolution.md` 的核心，
 *    缺了它模型分不清身份与本章材料谁压谁（真机上五个起草子代理有三个
 *    当场指出交稿要求自相矛盾）。
 * 3. 字段闸门的**分级取舍**：两个字段硬拦（消融实验证明有效的那两个），
 *    其余软提醒。硬拦这两个是引用，别哪天当成口味又放宽了。
 */
import assert from "node:assert/strict";
import { renderWriterRole, ROLE_ANCHOR } from "../lib/writer-role.js";
import { checkOutline, outlineFieldValue, OUTLINE_FIELDS } from "../lib/outline.js";
import { outlineFixture } from "./helpers/outline-fixture.mjs";

let passed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  catch (e) { failures.push([name, e.message]); process.stdout.write(`  FAIL  ${name}\n          ${e.message}\n`); }
}

// ── 身份层 ────────────────────────────────────────────────────────────────

await t("四段齐全：优先级链、铁律、怎么写、写作纪律", async () => {
  const role = renderWriterRole({ genre: "悬疑推理", styleBrief: "" });
  assert.ok(role.includes(ROLE_ANCHOR), "第一段必须是优先级链");
  assert.match(role, /## 二、铁律/);
  assert.match(role, /## 三、怎么写/);
  assert.match(role, /## 写作纪律/);
  // 换行必须真的生效：曾经因为把数组塞进待 join 的数组，
  // 内层被 Array.toString() 用逗号连接，整份身份塌成一长串 `,,` 夹着的字。
  // 它不报错，只是没法读——所以这条断言专门盯换行。
  assert.equal(role.includes(",,下"), false, "换行被吃掉了");
  assert.ok(role.split("\n").length > 60, "身份层被压成了一两行");
});

await t("优先级链写明基线数字不是判分线", async () => {
  // 这条是 oh-story style-resolution.md 里最该抄的一句：
  // reference 里的阈值不使默认写法升级为作者不可覆盖的规则。
  // 我们自己就是活例子——曾一路压模型「克制、别过头」，而正文读着发闷。
  const role = renderWriterRole({});
  assert.ok(role.includes("选样依据，不是判分线"), "必须明写基线数字不是判分线");
  assert.ok(role.includes("只有**同一维度**上出现分歧时才比高低"), "必须按维度取值，不整份覆盖");
});

await t("开局、姿态、收尾三条禁令都在", async () => {
  // 这三条原本一条都没有，于是：环境描写开场、跳进他人内心、章末升华。
  const role = renderWriterRole({});
  assert.ok(role.includes("禁大段环境描写或背景复盘开场"), "缺开局禁令");
  assert.ok(role.includes("默认深度限知"), "缺叙述姿态默认");
  assert.ok(role.includes("禁升华总结"), "缺收尾禁令");
  assert.ok(role.includes("禁章末预告"), "缺章末预告禁令");
});

await t("烈度反保守：宁过火不平淡，不是一路压着", async () => {
  // 我们原来给的是「克制、别过头」，方向是反的。
  const role = renderWriterRole({});
  assert.ok(role.includes("宁过火不平淡"), "烈度方向不能反");
  assert.equal(role.includes("克制优先"), false, "不该再压烈度");
});

await t("新增物三级与两条配套禁令都在", async () => {
  // 真机上三份草稿为了把篇幅写满，各自发明了第三个声音的身份。
  const role = renderWriterRole({});
  assert.ok(role.includes("下一章需不需要知道它存在过"), "缺判定标准");
  assert.ok(role.includes("严禁为填表加人"), "缺禁补内容的禁令");
  assert.ok(role.includes("也不拿新增物补字数"), "缺禁凑字数的禁令");
});

await t("格式铁律：禁空行、禁分隔线、禁省略号当停顿", async () => {
  const role = renderWriterRole({});
  assert.ok(role.includes("只允许一个换行符"), "缺单换行铁律");
  assert.ok(role.includes("不得出现空行"), "缺禁空行");
  assert.ok(role.includes("不用加粗、斜体、`---` 分隔线"), "缺禁分隔线");
  assert.ok(role.includes("不要用省略号和破折号当万能停顿"), "缺标点铁律");
});

await t("正文元信息隔离是铁律，不是事后检测", async () => {
  const role = renderWriterRole({});
  assert.ok(role.includes("正文元信息隔离"));
  assert.ok(role.includes("比上回那三秒开火更疼"), "要给出可照抄的正反例");
});

await t("不许发明材料之外的名字、地名、法则", async () => {
  // 真机上出过三份草稿各自造主角名字的事。
  const role = renderWriterRole({});
  assert.ok(role.includes("一个字都不要发明"));
});

// ── 细纲字段闸门 ──────────────────────────────────────────────────────────

await t("合规细纲放行", async () => {
  const r = checkOutline(outlineFixture());
  assert.equal(r.ok, true, JSON.stringify(r.hardMissing));
  assert.equal(r.hardMissing.length, 0);
});

await t("目标情绪缺了 → 硬拦", async () => {
  const body = outlineFixture().split("\n").filter((l) => !l.startsWith("- 目标情绪：")).join("\n");
  const r = checkOutline(body);
  assert.equal(r.ok, false);
  assert.equal(r.hardMissing.length, 1);
  assert.equal(r.hardMissing[0].key, "目标情绪");
  assert.equal(r.hardMissing[0].why, "absent");
});

await t("主角目标/关键选择缺了 → 硬拦", async () => {
  const body = outlineFixture().split("\n").filter((l) => !l.startsWith("- 主角目标/关键选择：")).join("\n");
  const r = checkOutline(body);
  assert.equal(r.ok, false);
  assert.deepEqual(r.hardMissing.map((m) => m.key), ["主角目标/关键选择"]);
});

await t("硬字段写了占位符同样拦：写了 [待补充] 等于没写", async () => {
  // 占位符比空着更坏——它看起来像填过了。
  const body = outlineFixture()
    .replace("- 目标情绪：戒备 → 被迫承认自己在替人挡", "- 目标情绪：[待补充]")
    .replace("- 主角目标/关键选择：他要保住那份口供；必须选择当众开口而不是私下交人",
             "- 主角目标/关键选择：〔待补充〕");
  const r = checkOutline(body);
  assert.equal(r.ok, false, "占位符必须被当成没写");
  assert.equal(r.hardMissing.length, 2);
  assert.ok(r.hardMissing.every((m) => m.why === "placeholder"));
});

await t("其余七个字段缺了只软提醒，不拦", async () => {
  // 这条钉的是取舍本身。oh-story 的消融实验说：只补那两个字段，
  // 正文收益与补满全部字段不可区分——那就不该拿其余七个挡流程。
  const r = checkOutline("# 第一章\n\n- 目标情绪：戒备→承认\n- 主角目标/关键选择：保住口供\n");
  assert.equal(r.ok, true, "软字段不该拦住确认");
  assert.equal(r.softMissing.length, 7, `应当报 7 个软缺失，实际 ${r.softMissing.length}`);
});

await t("硬字段认三种写法：行首、**加粗**、小标题成段", async () => {
  assert.equal(outlineFieldValue("- 目标情绪：a→b", "目标情绪"), "a→b");
  assert.equal(outlineFieldValue("- **目标情绪**：a→b", "目标情绪"), "a→b");
  assert.equal(outlineFieldValue("### 目标情绪\n\na→b\n\n### 下一个", "目标情绪"), "a→b");
});

await t("「核心事件」不能被「本章禁止提前释放」误认", async () => {
  // 两行都含「事件/释放」，正则一旦没锚定行首就会串。
  const body = "- 核心事件：x\n- 本章禁止提前释放：不揭露幕后者";
  assert.equal(outlineFieldValue(body, "核心事件"), "x");
  assert.equal(outlineFieldValue(body, "本章禁止提前释放"), "不揭露幕后者");
});

await t("九个字段里恰好两个硬字段", async () => {
  const hard = OUTLINE_FIELDS.filter((f) => f.hard).map((f) => f.key);
  assert.deepEqual(hard, ["目标情绪", "主角目标/关键选择"]);
  assert.equal(OUTLINE_FIELDS.length, 9, "字段清单应与参考项目的九个必填字段对应");
});

process.stdout.write(`\n  通过 ${passed}，失败 ${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);