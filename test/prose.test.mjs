/**
 * 文笔体检 —— 这一层在问一个很具体的问题：**「AI 味重」这句话能不能变成可以核对的数？**
 *
 * 起因是真机试跑第 1 章。那一稿的实测结果是：
 *
 *   禁用词 0 处　套词 0 处　弱化副词 0 处　总结句 0 处
 *   而它读起来仍然是机器味。
 *
 * 因为它的病是反的——不是「写了不该写的」，是「该写的没写」：
 *
 *   对话占比 3.0%（网文典型 40–60%）
 *   逗号长句占叙述句 42%（真人 74–80%）
 *   整句均长 17.0 字（真人 22–24）
 *   虚词密度 65.4/千字（真人 ≥85）
 *
 * 原来的 ai-flavor.js 只看五类套话，在这篇上一个都没命中——
 * **一份检测器全部通过的稿子，可以是 AI 味最重的那一稿。**
 *
 * 所以这里测三件事：
 *   1. 量出来的数是真的（纯函数、可复算、口径正确）；
 *   2. 该报的报、不该报的不报（有一份校准过的正样本作对照）；
 *   3. 规则真的进了子代理的提示词——量出来却没人看的检测器，等于没有。
 */
import { strict as assert } from "node:assert";
import {
  measureProse, proseFindings, renderProseMetrics, renderProseCandidates,
  renderProseSpec, splitDialogue, BASELINE,
} from "../lib/prose.js";
import { buildDraftTask } from "../lib/materials.js";
import { STEP_SPECS } from "../lib/director.js";
import { liftUnresolved } from "../lib/tools-director.js";

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

// ── 反样本：电报体。短句连排、虚词扫光、零对白。这是第 1 章 v8 的形状。
//    必须写够 600 字以上——短于 BASELINE.minCharsToJudge 的稿子不判，
//    样本不够时统计量没有意义。第一版这里只写了 230 字，全部断言都空转通过。 ──
const TELEGRAPH = [
  "他抬手。开门。进屋。坐下。",
  "桌上有纸。他拿起。看一眼。放下。",
  "窗外有雨。他起身。走到窗边。站住。",
  "雨还在下。他转身。回到桌边。又拿起纸。",
  "这次看慢。纸上有字。字很小。他凑近。",
  "折痕在中间。他顺折痕抹。没抹平。",
  "他放下纸。从口袋摸出存根。摊在台面。",
  "日期在右上角。他盯着看。手指按住。",
  "台面很凉。他把手收回。放进兜里。",
  "门口有脚步。是老陈。老陈看他一眼。",
  "老陈没说话。走到水池边。拧开水龙头。",
  "水声很响。他站在原地。没动。",
  "老陈洗碗。碗碰碗。声音脆。",
  "他低头。看台面。台面有水。",
  "他用袖子擦。擦不干。留一片印。",
  "老陈关水。擦手。看他。",
  "他抬头。对上老陈的眼。",
  "老陈移开目光。看窗外。",
  "窗外雨停。屋檐滴水。一滴一滴。",
  "他开口。声音低。老陈没听清。",
  "老陈问。你说什么。",
  "他没重复。转身。走向门口。",
  "老陈叫他。他停住。没回头。",
  "老陈说一句。他听完。点头。",
  "然后他走。门在身后合上。",
  "老陈站原地。看那扇门。",
  "台面空了。只剩印子。",
  "他走出去。雨后风凉。",
  "他摸口袋。存根还在。",
  "他走到路口。停住。看两边。",
  "左边是回家路。右边不是。",
  "他站很久。最后选左边。",
  "路上没人。路灯亮着。灯下有水洼。",
  "他绕过水洼。继续走。步子是匀速的。",
  "他到楼下。抬头看。三楼的窗黑着。",
  "他上楼。台阶很陡。扶手是铁的。",
  "他掏钥匙。插进锁孔。转半圈。",
  "门开了。屋里有味。是药味。",
  "他没开灯。脱鞋。进屋。",
  "他坐到床沿。掏出存根。摊在膝上。",
  "黑暗里看不清字。他不用看。",
  "他把存根折回去。放进抽屉。关上。",
  "他躺下。闭上眼。雨又开始下。",
].join("\n");

// ── 正样本：逗号长句、虚词齐全、对白占三成以上。 ──
const CALIBRATED = [
  "老陈把钥匙往台面上一放，说这下你可别再来找我了，我这儿真没地方给你搁东西。",
  "「我没说要搁东西。」",
  "「那你来干什么。」他把窗户推开一条缝，外面的雨声一下子就涌了进来，带着一股潮味，",
  "「上回你说的话我记着呢，你说那个人走的时候，手里是空着的。」",
  "「我说过。」",
  "「你今天又问一遍，是为了什么。」",
  "他没答。台面上那只搪瓷缸子里还留着半缸水，水面上浮着一层灰，边缘结了圈水碱。",
  "老陈顺着他的眼睛看了一眼，把缸子端起来，走到水池边，哗地倒掉了。",
  "「你要问就问，别在这儿站着，像根柱子。」",
  "「他走的时候，穿的是哪一件。」",
  "「灰的，洗得发白那一件，袖口还开了线。」老陈把手在围裙上擦了两下，",
  "「你这个人哪，问话跟锯木头一样，一下一下的，不知道的还以为你在审我。」",
  "他笑了一下，没接话。手从口袋里摸出一张折了两折的存根，摊在台子上，",
  "用指腹按着边角，一点一点抹平了，抹到中间那道折痕的时候停了下来。",
  "「哪儿来的。」",
  "「抽屉里。」",
  "「哪个抽屉。」",
  "「他那个。」",
  "老陈不说话了。灶上那壶水正好开了，哨音细细地响起来，越响越尖，",
  "他伸手把火拧小，哨音就落了下去，剩下一点嘶嘶的气声。",
  "「你要是想找什么，趁早说。」",
  "「我想知道他那天几点走的。」",
  "「十一点多。」",
  "「你怎么知道。」",
  "「因为我送他出去的。」老陈把壶从灶上提下来，手很稳，一滴水都没洒，",
  "「送到门口，他说不用送了，我就站住了。我看着他的背影进了雨里，拐弯就不见了。」",
  "他低下头，看着台面上那张存根。右上角有一行打印的日期，墨色比别处浅，",
  "像是机器快没墨了。他数了两遍，第二遍比第一遍慢。",
  "他把存根又折了回去，压平了，放进了上衣的口袋里，然后就站着没动。",
  "老陈把抹布搭上了架子，湿手上的水甩了甩，转身的时候顺手把窗关上了。",
  "窗框旧了，推起来有点涩，他用了两下才把缝合上，指头上还沾着灰。",
  "他低头看了一眼手指，在裤子上擦了两下，灰没擦掉，就留在那儿了。",
  "「你数什么呢。」",
  "「没数什么。」",
].join("\n");

console.log("文笔体检 · prose.js\n");

// ── 第一组：量得对不对 ──

await t("纯函数：同一段文本量两次，结果逐字节相同", () => {
  assert.equal(JSON.stringify(measureProse(CALIBRATED)), JSON.stringify(measureProse(CALIBRATED)));
  assert.equal(JSON.stringify(measureProse(TELEGRAPH)), JSON.stringify(measureProse(TELEGRAPH)));
});

await t("对白只算引号里的字，叙述里出现的引号不算", () => {
  const { dialogue, narrative } = splitDialogue("他说：「明天别关灯。」然后就走了，没有回头。");
  assert.equal(dialogue, "明天别关灯。");
  assert.equal(narrative.includes("别关灯"), false, "引号里的字不该留在叙述里");
  assert.ok(narrative.includes("然后就走了"), "引号外的字必须留着");
  assert.ok(narrative.includes("没有回头"));
});

await t("对白占比按字数算，不是按条数算", () => {
  const m = measureProse(CALIBRATED);
  assert.ok(m.dialogueCount > 10, `应当识别出多条对白，实际 ${m.dialogueCount}`);
  assert.ok(m.dialogueRatio > 0 && m.dialogueRatio < 1);
  assert.ok(Math.abs(m.dialogueRatio - m.dialogueChars / m.chars) < 1e-9);
});

await t("电报体的虚词密度确实低于校准文本", () => {
  const tel = measureProse(TELEGRAPH);
  const cal = measureProse(CALIBRATED);
  assert.ok(tel.funcDensity < cal.funcDensity,
    `电报体 ${tel.funcDensity.toFixed(1)} 应低于校准文本 ${cal.funcDensity.toFixed(1)}`);
});

await t("逗号长句按「含两个以上逗号的叙述句」计", () => {
  const m = measureProse("他站起来，走到窗边，把窗户推开了。\n他走了。");
  assert.equal(m.sentences, 2);
  assert.equal(Math.round(m.commaLongRatio * 100), 50);
});

// ── 第二组：该报的报、不该报的不报 ──

await t("电报体：报出「电报体（过度压缩）」，且不打 s1/s2", () => {
  const f = proseFindings(measureProse(TELEGRAPH));
  const tel = f.find((x) => x.id === "telegram");
  assert.ok(tel, `没报电报体，实际报了：${f.map((x) => x.id).join(", ")}`);
  assert.equal(tel.severity, "s3", "表达层问题不该跟人物崩坏抢阻断级别");
  assert.ok(tel.note.includes("虚词密度"), "说明里要给数字，不能只说「AI 味重」");
});

await t("电报体：报出对白占比过低", () => {
  const f = proseFindings(measureProse(TELEGRAPH));
  assert.ok(f.some((x) => x.id === "low-dialogue"));
});

await t("校准过的正样本：不报电报体、不报句子偏碎、不报对白过低", () => {
  const f = proseFindings(measureProse(CALIBRATED));
  const bad = f.filter((x) => ["telegram", "choppy", "low-dialogue", "short-sentences"].includes(x.id));
  assert.deepEqual(bad.map((x) => x.id), [], `正样本被误报：${bad.map((x) => `${x.id}(${x.note.slice(0, 40)})`).join(" / ")}`);
});

await t("正样本的每一项都落在真人基线区间里", () => {
  const m = measureProse(CALIBRATED);
  assert.ok(m.dialogueRatio >= BASELINE.dialogueRatio.floor, `对白 ${(m.dialogueRatio * 100).toFixed(1)}%`);
  assert.ok(m.sentenceAvg >= BASELINE.sentence.floor, `整句 ${m.sentenceAvg.toFixed(1)} 字`);
  assert.ok(m.commaAvg >= BASELINE.commaSeg.lo && m.commaAvg <= BASELINE.commaSeg.hi, `逗号间 ${m.commaAvg.toFixed(1)} 字`);
  assert.ok(m.commaLongRatio >= BASELINE.commaLongRatio.floor, `逗号长句 ${(m.commaLongRatio * 100).toFixed(1)}%`);
  assert.ok(m.funcDensity >= BASELINE.funcDensity.floor, `虚词 ${m.funcDensity.toFixed(1)}/千字`);
});

await t("太短的稿子不判——样本不够，统计量没有意义", () => {
  assert.deepEqual(proseFindings(measureProse("他走了。")), []);
  assert.equal(measureProse("").chars, 0);
});

await t("工程词泄漏进正文：报 s2，且这批真出过事", () => {
  // 第 1 章 v4 的末行是「〔未处置〕…」，v5 的末行是「〔说明〕…」，两次都进了定稿路径。
  // 摘除逻辑只在模型恰好用那个记号时有效——这一层与记号无关。
  const dirty = CALIBRATED + "\n\n细纲里这一章的情节点已经写完了，本章任务达成。";
  const f = proseFindings(measureProse(dirty));
  const leak = f.find((x) => x.id === "engineering-leak");
  assert.ok(leak, "正文里出现「细纲」「情节点」「本章任务」必须报");
  assert.equal(leak.severity, "s2");
  assert.ok(leak.note.includes("细纲"));
});

await t("逐字复读：相邻两行一模一样要报", () => {
  const dup = CALIBRATED + "\n他把壶从灶上提下来。\n他把壶从灶上提下来。";
  const f = proseFindings(measureProse(dup));
  assert.ok(f.some((x) => x.id === "verbatim-repeat"));
});

await t("截断：正文没以句末标点收尾要报 s2", () => {
  const cut = CALIBRATED + "\n他伸手去够那只";
  const f = proseFindings(measureProse(cut));
  assert.ok(f.some((x) => x.id === "truncated"));
});

await t("破折号与否定翻转句都要报", () => {
  const f = proseFindings(measureProse(CALIBRATED + "\n他停下——不是累，是不敢。"));
  assert.ok(f.some((x) => x.id === "em-dash"));
  assert.ok(f.some((x) => x.id === "negative-flip"));
});

await t("每条发现项都带「这是信号不是判决」，不许把统计量当判决书", () => {
  const f = proseFindings(measureProse(TELEGRAPH));
  const stat = f.filter((x) => ["telegram", "choppy", "short-sentences", "low-dialogue", "sparse-function-words"].includes(x.id));
  assert.ok(stat.length > 0);
  for (const x of stat) {
    assert.ok(/这是统计信号，不是判决/.test(x.note), `${x.id} 缺少免责口径`);
    assert.ok(/不要为了凑数字注水/.test(x.note), `${x.id} 缺少反投机口径`);
  }
});

await t("体检报告不能崩：空输入、只有空白、只有标点都要能渲染", () => {
  for (const s of ["", "   ", "。", "\n\n\n"]) {
    const txt = renderProseMetrics(measureProse(s));
    assert.equal(typeof txt, "string");
    assert.ok(txt.length > 0);
  }
});

// ── 第三组：规则真的进了提示词（量出来没人看 = 没有） ──

await t("写作纪律同时含正向要求、禁止清单、和「欢迎这样写」", () => {
  const spec = renderProseSpec({ genre: "悬疑推理" });
  assert.ok(spec.includes("逗号长句"), "缺少句长要求");
  assert.ok(spec.includes("对白是正文的主干"), "缺少对白要求");
  assert.ok(spec.includes("一个场景至少开三路感官"), "缺少感官要求");
  assert.ok(spec.includes("欢迎这样写"), "只给禁令会让模型把禁令最大化执行成什么都不写");
  assert.ok(spec.includes("明确不要"), "缺少禁止清单");
  assert.ok(spec.includes("不要把每个细纲单元机械扩成同一种结构"), "缺少防匀速叙事");
  assert.ok(spec.includes("只写动作、不写内心") && spec.includes("不等于"), "缺少〔硬〕与文笔的调和");
  assert.ok(spec.includes("悬疑推理"));
});

await t("本书自己的写法条目存在时：只在它说到的那一点上优先，其余照通用要求", () => {
  const spec = renderProseSpec({ styleBrief: "本书不用成语。" });
  assert.ok(spec.includes("本书不用成语。"));
  assert.ok(spec.indexOf("本书不用成语。") > spec.indexOf("欢迎这样写"));
  assert.ok(spec.includes("它压过上面任何一条通用要求"), "写法条目要说清它优先");
  // 这句话是 A/B 试跑逼出来的：一条局部偏好「段末落在短句上」被读成整篇文风的许可证，
  // 起草子代理自述「116 个段落的末句都落在短句上」，逗号长句占比因此停在 36%。
  assert.ok(spec.includes("它没提到的地方，一律照上面的通用要求写"), "不写这句，局部偏好会吃掉整篇");
  assert.ok(spec.includes("不是说全篇都用短句"), "要点名最常见的那个误读");
});

await t("句子长度必须有正反对照实例，不能只有形容词", () => {
  const spec = renderProseSpec({});
  assert.ok(spec.includes("反面（逗号长句只占三成"), "缺少写坏的样子");
  assert.ok(spec.includes("正面（逗号长句占七成半"), "缺少写对的样子");
  assert.ok(spec.includes("他抬手。开门。进屋。坐下。"), "反面例子要具体");
  assert.ok(spec.includes("他抬手把门推开，进屋先站在门口听了一下雨"), "正面例子要具体");
});

await t("起草任务包（导演链的正文来源）里必须有写作纪律", () => {
  const materials = {
    book: "试跑本", chapter: "ch0001",
    segments: [
      { id: "task", name: "本章任务", describe: "d", ok: true, content: "他听见自己的遗言。", source: "s", hash: "h" },
      { id: "style", name: "文风基准", describe: "d", ok: true, content: "冷硬，不解释。", source: "s", hash: "h" },
    ],
  };
  const task = buildDraftTask(materials, { title: "试跑本", targetWords: 3000, genre: "悬疑推理" });
  assert.ok(task.includes("## 写作纪律"), "起草任务包缺写作纪律——这正是第 1 章写成电报体的原因");
  assert.ok(task.includes("冷硬，不解释。"), "书自己的写法条目要进简报");
  assert.ok(task.indexOf("## 写作纪律") > task.indexOf("本章任务"), "纪律该在材料之后、动笔之前");
  assert.ok(task.includes("交稿要求"));
});

await t("材料包里没有文风段时，写作纪律照样在（不能因为它缺就整段消失）", () => {
  const materials = { book: "B", chapter: "ch0001", segments: [
    { id: "task", name: "本章任务", describe: "d", ok: true, content: "x", source: "s", hash: "h" },
  ] };
  const task = buildDraftTask(materials, {});
  assert.ok(task.includes("## 写作纪律"));
});

await t("起草步骤的输出要求指向写作纪律，并挡住「只写动作=短句流水账」", () => {
  const p = STEP_SPECS.draft.build({ book: "B", chapter: 1, volume: 1 }, { taskText: "任务包正文" }).prompt;
  assert.ok(p.includes("任务包正文"));
  assert.ok(p.includes("写作纪律"));
  assert.ok(p.includes("短句流水账"));
});

await t("审读步骤拿得到正文体检，而且明确说这只是候选", () => {
  const p = STEP_SPECS.review.build({ book: "B", chapter: 1 }, { draftText: CALIBRATED }).prompt;
  assert.ok(p.includes("正文体检"));
  assert.ok(p.includes("对白占比") || p.includes("对话占比"));
  assert.ok(p.includes("只作候选，不作判决"));
  assert.ok(p.includes("已核对，不算问题"), "要给审读者留出「看过了，不算问题」的出口");
});

await t("改稿步骤同时拿到写作纪律和上一稿的体检数字，且带上反投机规则", () => {
  const p = STEP_SPECS.revise.build(
    { book: "B", chapter: 1 },
    { draftText: TELEGRAPH, findings: [{ note: "n", quote: "q" }], outlineBrief: "o" },
  ).prompt;
  assert.ok(p.includes("写作纪律"));
  assert.ok(p.includes("上一稿的体检结果"));
  assert.ok(p.includes("不要把正常的长句拆成短句串"));
  assert.ok(p.includes("改表达、不改事实"));
  assert.ok(p.includes("不是唯一目标"), "改稿输出要求必须挡住「为凑指标注水」");
});

await t("体检不会把审读/改稿的必填输入搞丢（缺正文仍要拦住）", () => {
  const spec = { requires: STEP_SPECS.review.requires };
  assert.deepEqual(spec.requires, ["draftText"]);
});

// ── 第四组：机器候选发现项必须进提示词并被要求逐条表态 ──
//    只打印体检表是不够的：审读者可以扫一眼数字再写「文风尚可」。
//    proseFindings 一度就是个没有任何调用点的导出函数。

await t("机器候选：重项排前面，轻项也列出来", () => {
  const txt = TELEGRAPH + "\n\n细纲里的情节点已经写完了，本章任务达成。";
  const r = renderProseCandidates(measureProse(txt));
  const items = r.split("\n").filter((l) => l.startsWith("- ["));
  assert.ok(items.length >= 2, `候选太少：${items.length}`);
  assert.match(items[0], /^- \[s2\]/, `最重的没排第一：${items[0]}`);
  assert.ok(items.some((l) => /\[s3\]/.test(l)), "轻项也要列出来");
});

await t("机器候选：干净稿子也要说清「这不等于没问题」", () => {
  const r = renderProseCandidates(measureProse(CALIBRATED));
  assert.match(r, /没报出可疑项/);
  assert.match(r, /这不等于没问题/, "否则「零发现」会被读成「没问题」");
});

await t("机器候选：逐条不重复免责口径，免得把数字淹掉", () => {
  const r = renderProseCandidates(measureProse(TELEGRAPH));
  const items = r.split("\n").filter((l) => l.startsWith("- ["));
  assert.ok(items.length > 0);
  for (const l of items) {
    assert.ok(!/这是统计信号，不是判决/.test(l), `逐条抄了口径：${l.slice(0, 60)}`);
    assert.ok(l.length < 300, `单条太长会把数字淹掉：${l.length} 字`);
  }
  assert.match(r, /误报的代价高于漏报/, "总纲要说清为什么数字不是判决");
});

await t("免责要逐条紧贴数字给，不能只在开头声明一次", () => {
  // 参考项目的做法是每条数字后面紧跟一条反例（「5~15 处」后紧跟「偶发且贴合人设合法」）。
  // 只在节标题统一声明的问题是：读到第 7 条时早忘了第 1 条的口头豁免。
  const r = renderProseCandidates(measureProse(TELEGRAPH));
  const caveats = r.split("\n").filter((l) => l.includes("什么时候不算"));
  assert.ok(caveats.length >= 3, `逐条免责太少：${caveats.length} 条`);
  assert.match(r, /什么时候不算：.*刻意的冷硬文体/s);
});

await t("审读提示词要求逐条表态，且明确禁止整条略过", () => {
  const p = STEP_SPECS.review.build({ book: "B", chapter: 1 }, { draftText: TELEGRAPH }).prompt;
  assert.match(p, /机器候选发现项/);
  assert.match(p, /不许整条略过/, "没这句，审读者可以合法地一条都不看");
  assert.match(p, /已核对，不算问题：/, "要给「核对过、不算问题」留出写法");
  assert.match(p, /对话占比只有 3%/, "要把试跑那次翻车的具体数字写给他们看");
});

// ── 第五组：任务包要求的末尾标记，摘除器必须真的认得 ──
//    这一组是防漂移用的。任务包写在 materials.js，摘除器写在 tools-director.js，
//    两处各改各的，已经漂过两次：
//      第一次 词不对——prompt 写〔未处置〕，子代理回〔说明〕；
//      第二次 括号不对——起草任务包写【存疑】，摘除器只认〔〕。
//    第二次是在 A/B 试跑里漂出来的：起草子代理老老实实照做，
//    那一行「【存疑】第三个声音的身份未交代……」就落在正文末尾，准备进定稿。

const minimalMaterials = () => ({
  book: "B", chapter: "ch0001",
  segments: [{ id: "task", name: "本章任务", describe: "d", ok: true, content: "x", source: "s", hash: "h" }],
});

await t("起草任务包要求的末尾标记，摘除器必须认得（两处不能各写各的）", () => {
  const task = buildDraftTask(minimalMaterials(), {});
  const found = /用「([【〔\[［][^】〕\]］]+[】〕\]］])」标示/.exec(task);
  assert.ok(found, "任务包应当写明末尾标记的写法；改了措辞，这条测试要跟着改");
  const marker = found[1];

  const r = liftUnresolved(`他站在门口。\n\n${marker}第三个人的身份未交代，按细纲留接口。`);
  assert.equal(r.body.includes(marker), false,
    `任务包要求的 ${marker} 没被摘掉——它会一路走进定稿`);
  assert.equal(r.body.trim(), "他站在门口。");
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /第三个人的身份未交代/);
});

await t("交稿要求不能自相矛盾：正文里不许有交代性的话，正文之后那一行必须写", () => {
  // A/B 试跑的五个起草子代理里有三个当场指出这两条打架，三个都挑了「不写说明」——
  // 于是本该交上来的未处置说明全丢了。改措辞之前，这条测试先钉住「不许再打架」。
  const task = buildDraftTask(minimalMaterials(), {});
  const req = task.slice(task.indexOf("## 交稿要求"));
  assert.match(req, /中间不要插标题、小标题、交代、说明或统计/, "正文内部要禁干净");
  assert.match(req, /\*\*但你必须写\*\*/, "正文之后那一行要明确要求写，不能只说「可以标」");
  assert.match(req, /会被自动摘掉/, "要告诉它那一行不会污染正文，否则它为了保正文会省掉这一行");
  assert.match(req, /没有拿不准的地方，就不要凑这一行/, "免得每章都硬凑一条说明");
});

await t("改稿提示词要求的末尾标记，同一套摘除器也要认得", () => {
  const p = STEP_SPECS.revise.build(
    { book: "B", chapter: 1 },
    { draftText: "x", findings: [], outlineBrief: "o" },
  ).prompt;
  const found = /用一行\s*`?([〔【\[［][^〕】\]］]+[〕】\]］])`?\s*开头/.exec(p);
  assert.ok(found, "改稿提示词里应当写明末尾标记的写法");
  const r = liftUnresolved(`正文一句。\n\n${found[1]}发现项 3 与〔硬〕冲突，保留了硬约束。`);
  assert.equal(r.body.includes(found[1]), false);
  assert.equal(r.notes.length, 1);
});

await t("括号样式换了也照样摘——不许把括号写死", () => {
  for (const mark of ["〔说明〕", "【存疑】", "[TODO]", "［备注］"]) {
    const r = liftUnresolved(`正文一句。\n\n${mark}留给作者看的话。`);
    assert.equal(r.body.includes(mark), false, `${mark} 没被摘掉`);
    assert.equal(r.notes.length, 1, `${mark} 应当被记成一条说明`);
  }
});

await t("正文中间的方括号标签不能误删——只从结尾往前扫", () => {
  const body = "【他记得】那天下雨。\n他站在门口。";
  const r = liftUnresolved(body);
  assert.equal(r.notes.length, 0);
  assert.equal(r.body, body, "中间的标签是正文的一部分");
});

await t("摘干净了要原样还回去：宁可让长度闸门报短，也不能交一篇空稿", () => {
  const r = liftUnresolved("〔说明〕就这一行。");
  assert.equal(r.body, "〔说明〕就这一行。");
  assert.equal(r.notes.length, 1, "说明本身不能因为兜底而消失");
});

await t("对白语气词只数引号内的，叙述里的「呢」不算", () => {
  const m = measureProse("「你吃饭了。」\n他把呢子大衣挂上，呢绒面子还沾着水。");
  assert.equal(m.dialogueParticles, 0, "叙述里的「呢」不能算成对白口气");
  assert.equal(measureProse("「你吃饭了没有呢。」").dialogueParticles, 1);
  assert.equal(measureProse("「走不走嘛？」").dialogueParticles, 1, "嘛也是口气");
});

await t("对白有量但没气口，要单独报一条——这和「对话太少」是两种病", () => {
  const bare = Array.from({ length: 10 }, () => "「不行。」").join("\n");
  const m = measureProse(TELEGRAPH + "\n" + bare);
  assert.equal(m.dialogueParticles, 0);
  const f = proseFindings(m).find((x) => x.id === "dialogue-flat");
  assert.ok(f, "10 句口令式对白应当被报出来");
  assert.equal(f.severity, "s4");
});

await t("对白里只要有一个语气词，就不报「没口气」", () => {
  const bare = Array.from({ length: 10 }, (_, i) => (i === 3 ? "「不行呢。」" : "「不行。」")).join("\n");
  const m = measureProse(TELEGRAPH + "\n" + bare);
  assert.equal(m.dialogueParticles, 1);
  assert.equal(proseFindings(m).some((x) => x.id === "dialogue-flat"), false);
});

await t("只有两三句对白时不报「没口气」——样本太小，报了是噪音", () => {
  const m = measureProse(TELEGRAPH + "\n「不行。」");
  assert.equal(m.dialogueCount, 1);
  assert.equal(proseFindings(m).some((x) => x.id === "dialogue-flat"), false);
});

await t("写作纪律教「动作串带虚词」，不能只教人把句号换成逗号", () => {
  // 这条是从 oh-story 的 writing-craft:376 来的。A/B 试跑里 B 组把逗号长句写到 66.7%，
  // 虚词却只有 71.7——因为它写的是逗号清单，句子拉长了，虚词没上去。
  const spec = renderProseSpec({});
  assert.match(spec, /要用虚词接出先后和因果，不能写成逗号清单/);
  assert.match(spec, /逗号清单：「舅妈收了录音机/);
  assert.match(spec, /先把录音机收进里屋/, "要给接起来的写法，不能只说别写清单");
});

await t("写作纪律有「对白要带口气」，点明全章不能一个语气词都没有", () => {
  const spec = renderProseSpec({});
  assert.match(spec, /全章对白不能一个语气词都没有/);
  assert.match(spec, /读起来不是冷硬，是屋里没人在说话/);
});

await t("写作纪律规定单独成行的短句只留给重拍", () => {
  assert.match(renderProseSpec({}), /单独成行的短句只留给章尾、反转、情绪峰值/);
});

await t("体检表要打出对白口气，否则审读者看不见这一项", () => {
  const r = renderProseMetrics(measureProse(TELEGRAPH + "\n" + Array.from({ length: 10 }, () => "「不行。」").join("\n")));
  assert.match(r, /对白口气 0 处 ⚠/);
});

await t("段落均匀度：认得出病态均匀，但真实草稿远在另一侧", () => {
  // 反样本：每段都是三句、长度几乎一样——「按细纲机械扩写」的形状。
  const uniform = Array.from({ length: 26 }, (_, i) => [
    `他看见了第 ${i + 1} 样东西。`,
    "那东西放在角落里，蒙着一层薄薄的灰。",
    "他没有伸手去碰，只是看了很久。",
  ].join("")).join("\n\n");
  const mu = measureProse(uniform);
  assert.ok(mu.narrativeParagraphs >= BASELINE.minParagraphsToJudge);
  assert.ok(mu.paraCv < BASELINE.paraCv.floor, `反样本 CV=${mu.paraCv.toFixed(3)} 没被认成均匀`);
  assert.ok(proseFindings(mu).some((f) => f.id === "uniform-paragraphs"), "应当报平均用力");

  // 正样本：单句独段 + 长段铺陈交错。
  const varied = [
    "他没动。",
    "屋里没有人说话，只有屋顶那处漏在滴，一滴，一滴，滴在搪瓷盆里，声音比雨小，比静大。",
    "他把手电换了只手。",
    "光扫过墙上的照片，照片里的三个人都在笑，笑的时间不一样：一个在笑，另外两个是被拍到的人。",
    "他走过去。",
    "照片下面压着一只搪瓷缸子，缸沿磕掉了一块，露出底下的黑铁。缸子里插着半支烟，烟头是湿的。",
    "烟是刚掐的。掐烟的人刚走。",
  ].concat(Array.from({ length: 22 }, (_, i) =>
    `他把第 ${i + 1} 个抽屉拉开，又关上，关的时候特意用手托着，免得响。`)).join("\n\n");
  const mv = measureProse(varied);
  assert.equal(proseFindings(mv).some((f) => f.id === "uniform-paragraphs"), false,
    `参差正样本 CV=${mv.paraCv.toFixed(3)} 被误报成平均用力`);

  // 段数不够不判：三段两段谈不上均匀，那只是短章。
  const tiny = measureProse("他没动。\n\n屋里没有人说话，只有滴水声。\n\n烟是刚掐的。\n\n他走过去。\n");
  assert.ok(tiny.narrativeParagraphs < BASELINE.minParagraphsToJudge);
  assert.equal(proseFindings(tiny).some((f) => f.id === "uniform-paragraphs"), false);
});

await t("段落均匀度是烟雾报警器不是门禁：十个真实草稿都远在下限之外", () => {
  // 把这条写死，是为了以后有人想把它升级成 s2 时，先看见它并不真的分得开真实稿子。
  assert.ok(BASELINE.paraCv.floor < 0.3, "阈值一旦升到 0.3 量级就会开始误伤正常草稿");
  assert.match(renderProseMetrics(measureProse(CALIBRATED)), /叙述段长离散 \d\.\d{3}/);
});

await t("动作清单：双门槛要一起满足，而且按段不按句", () => {
  // 判据与 40 个动词表来自 oh-story 的 check-ai-patterns.js:93-95（MIT）。
  // 我先试过不要词表的「零虚词」代理，它把并列描写误报成清单、在新臂上报得更多，
  // 方向是反的。换成真源判据后，它在全部 11 个真实样本上一处都不响——
  // 所以正样本必须在这里用构造稿证明它确实会响。
  const list = "他伸手拿起那盘磁带，翻过来看了看，转身递给舅妈，放下，又拿起，再放下。";
  // 接在 TELEGRAPH 后面凑过 minCharsToJudge —— proseFindings 对短稿直接放行，
  // 几百字的构造稿根本走不到判据那一步。
  const m = measureProse(TELEGRAPH + "\n\n" + list);
  assert.ok(m.actionListCount >= 1, "构造的动作清单段没被认出来");
  assert.ok(m.actionListWorst.verbs >= 5 && m.actionListWorst.seps >= 4, "双门槛要同时满足");
  assert.ok(proseFindings(m).some((f) => f.id === "action-list"), "应当报动作清单");

  // 分隔符够、动词不够，不报：这是写法讲究，不是清单。
  const noVerb = "他把灯拿起，放在桌上，看了看，又拿起，放下，走开，关门，坐下。";
  const m2 = measureProse(TELEGRAPH + "\n\n" + noVerb);
  assert.equal(m2.actionListCount, 0, "分隔符多但动作动词不足，不能报");

  // 动词够、分隔符不够，不报：那只是一句话里有几个动作。
  const noSep = "他伸手拿起磁带转身递给舅妈放下。";
  const m3 = measureProse(TELEGRAPH + "\n\n" + noSep);
  assert.equal(m3.actionListCount, 0, "动词多但没有逗号串联，不能报");

  // 正常稿子不响。
  assert.equal(proseFindings(measureProse(CALIBRATED)).some((f) => f.id === "action-list"), false);
});

await t("动作清单按段统计，不是按句", () => {
  // 真源注释写的是「同一段连续堆叠」。同一段里五个动词，拆成五句就不算清单了。
  const samePara = "他伸手，拿起，走向门口，停下，回头看了看，放下。";
  const m = measureProse(TELEGRAPH + "\n\n" + samePara);
  assert.ok(m.actionListCount >= 1, "同段堆叠应当被报出来");
});

// ── 汇总 ──
console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
