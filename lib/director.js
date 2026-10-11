/**
 * 自动导演 —— 决策层。
 *
 * 这一层是纯函数式的：给定书仓（Git）+ 章节状态 + 门禁策略，推出"现在该做什么"。
 * 不含任何模型调用，因此可以完全测试。真正的派发在 tools-director 里，
 * 它只是把这个决策喂给 workflow 的子代理。
 *
 * 之所以能这么写，是因为阶段二立过一条规矩：状态从 Git 推导。
 * 导演因此不需要自己的记忆——断电重启后重新推导一次，结论必须完全相同。
 */
import path from "node:path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { LAYOUT, bookPaths, bookStatus, validateTitle, commitPaths } from "./warehouse.js";
import { listChapterStates, chapterKey, MAX_REVISION_ROUNDS, reviewRoundsOf, reviseWaiverOf } from "./chapter-state.js";
import { loadPolicy, gateCheck, listDebts } from "./gates.js";
import { measureProse, renderProseMetrics, renderProseCandidates, renderProseGaps } from "./prose.js";
import { renderWriterRole } from "./writer-role.js";
import { genreFromContract } from "./materials.js";

const DEFAULT_CHAPTERS_PER_VOLUME = 20;
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 阿拉伯数字或中文数字都认。一到九十九够卷号用了。 */
export function toNumber(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  const i = s.indexOf("十");
  if (i < 0) {
    let n = 0;
    for (const ch of s) {
      if (CN_DIGITS[ch] === undefined) return NaN;
      n = n * 10 + CN_DIGITS[ch];
    }
    return n;
  }
  const head = s.slice(0, i);
  const tail = s.slice(i + 1);
  const tens = head === "" ? 1 : CN_DIGITS[head];
  if (tens === undefined) return NaN;
  const ones = tail === "" ? 0 : CN_DIGITS[tail[0]];
  if (ones === undefined) return NaN;
  return tens * 10 + ones;
}

/**
 * 解析分卷布局。认得这些写法：
 *   「## 第一卷｜雨落」              → 第 1 卷，标题「雨落」
 *   「## 第 2 卷（第 21–40 章）｜风起」 → 第 2 卷，章范围 21~40
 * 解析不出任何卷就返回空数组，导演会停在 design.volume_layout 上等人。
 */
export function parseVolumeLayout(text) {
  const out = [];
  const re = /^#{1,4}[ \t]*第[ \t]*([0-9]+|[零一二三四五六七八九十]+)[ \t]*卷[ \t]*(.*)$/gm;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    const volume = toNumber(m[1]);
    if (!Number.isInteger(volume) || volume < 1) continue;
    let rest = (m[2] ?? "").trim();

    const rangeMatch = /第[ \t]*(\d+)[ \t]*[–\-—~～至到][ \t]*(\d+)[ \t]*章/.exec(rest);
    let from = null;
    let to = null;
    if (rangeMatch) {
      from = Number(rangeMatch[1]);
      to = Number(rangeMatch[2]);
      rest = rest.replace(rangeMatch[0], "");
    }
    rest = rest.replace(/[（(][ \t]*[）)]/g, "").trim();
    rest = rest.replace(/^[｜|·、 \t]+/, "").replace(/[｜|·、 \t]+$/, "").trim();
    out.push({ volume, title: rest, from, to });
  }
  return out.sort((a, b) => a.volume - b.volume);
}

/**
 * 某一章属于第几卷。
 * 布局给了章范围就按范围；布局完全没给范围就按每卷固定章数推。
 * 布局给了范围却没覆盖到这一章 → 返回 null：这是「规划没跟上」，
 * 导演必须停下来让人补，不能自己瞎猜一个卷号。
 */
export function volumeOfChapter(chapterNum, volumes, perVolume = DEFAULT_CHAPTERS_PER_VOLUME) {
  const numbered = (volumes ?? []).filter((v) => v.from !== null && v.to !== null);
  if (numbered.length > 0) {
    const hit = numbered.find((v) => chapterNum >= v.from && chapterNum <= v.to);
    if (hit) return hit.volume;
    const maxTo = Math.max(...numbered.map((v) => v.to));
    if (chapterNum > maxTo) return null; // 布局没覆盖到这里
  }
  return Math.max(1, Math.ceil(chapterNum / perVolume));
}

export function volumeEnd(volume, volumes, perVolume = DEFAULT_CHAPTERS_PER_VOLUME) {
  if (volume === null || volume === undefined) return null;
  const hit = (volumes ?? []).find((v) => v.volume === volume);
  if (hit && hit.to !== null) return hit.to;
  return volume * perVolume;
}

/**
 * 卷结算标记。没有它，导演每轮都会重新提出 volume.settle，然后永远走不到下一章。
 * 落盘位置 书仓/<书>/卷账/卷NN/结算.md，提交前缀 vol:。
 */
export function volumeSettlePath(workspaceRoot, bookTitle, volume) {
  return path.join(bookPaths(workspaceRoot, bookTitle).base, "卷账", `卷${String(volume).padStart(2, "0")}`, "结算.md");
}

export async function settledVolumes(workspaceRoot, bookTitle) {
  const base = path.join(bookPaths(workspaceRoot, bookTitle).base, "卷账");
  let names = [];
  try {
    names = await fs.readdir(base);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^卷(\d+)$/.exec(name);
    if (m && existsSync(path.join(base, name, "结算.md"))) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

export async function markVolumeSettled(workspaceRoot, bookTitle, volume, summary = "") {
  const abs = volumeSettlePath(workspaceRoot, bookTitle, volume);
  if (existsSync(abs)) {
    return { ok: false, stage: "already-settled", detail: `卷 ${volume} 已经结算过了，别重复提交。` };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const bs = await bookStatus(workspaceRoot, bookTitle);
  await fs.writeFile(
    abs,
    `# 卷 ${volume} 结算\n\n${summary || "本卷已定稿入档。"}\n\n- 结算时全书已定稿章数：${bs.finalizedChapterCount}\n- 结算时间：${new Date().toISOString()}\n`,
    "utf8",
  );
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
  const commit = await commitPaths(workspaceRoot, [rel], `vol: 卷${String(volume).padStart(2, "0")} 结算`);
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };
  return { ok: true, volume, commit: commit.commit };
}

/** 推导导演状态。全部来自 Git 与草稿区，不读任何缓存。 */
export async function deriveState(workspaceRoot, bookTitle) {
  const err = validateTitle(String(bookTitle ?? "").trim());
  if (err) return { ok: false, stage: "validate-title", detail: err };

  const bs = await bookStatus(workspaceRoot, bookTitle);
  if (!bs.ok) return bs;

  const base = bookPaths(workspaceRoot, bookTitle).base;
  const skeletonExists = existsSync(path.join(base, LAYOUT.outline, "故事骨架.md"));
  const layoutPath = path.join(base, LAYOUT.outline, "分卷布局.md");
  const volumes = existsSync(layoutPath) ? parseVolumeLayout(await fs.readFile(layoutPath, "utf8")) : [];

  const chapters = await listChapterStates(workspaceRoot, bookTitle);
  const lastChapter = bs.lastChapter ? Number(String(bs.lastChapter).replace("ch", "")) : 0;
  const debts = await listDebts(workspaceRoot, bookTitle, { status: "未处理" });

  return {
    ok: true,
    book: bookTitle,
    skeletonExists,
    hasVolumeLayout: volumes.length > 0,
    volumes,
    chapters,
    finalizedChapterCount: bs.finalizedChapterCount,
    lastChapter,
    nextChapter: lastChapter + 1,
    openDebts: debts.open,
    // 阻断项要按章查，所以把条目本身也带上，不只是一个计数。
    debtEntries: debts.entries,
    settled: await settledVolumes(workspaceRoot, bookTitle),
    policy: await loadPolicy(workspaceRoot, bookTitle),
    commitCount: bs.commitCount,
  };
}

/** 决策规则表。按优先级从上往下，第一条命中的就是下一步。 */
export const RULES = [
  { id: "need-skeleton", when: (s) => !s.skeletonExists, node: "design.skeleton", kind: "design", target: "故事骨架" },
  { id: "need-layout", when: (s) => !s.hasVolumeLayout, node: "design.volume_layout", kind: "design", target: "分卷布局" },

  // 卷级闸门必须排在章节规则前面。volumeComplete 已经要求「没有在途章节」，
  // 所以不会抢在没写完的章前面；反过来若排在后面，卷一写完就会直接跳去开下一章，
  // volume.settle 和整卷前的质量债闸门将永远不触发——它们会变成死代码。
  { id: "blocked-debt", when: (s) => s.volumeComplete && s.openDebts > 0, node: "debt.settle", kind: "gate", target: "质量债" },
  { id: "volume-settle", when: (s) => s.volumeComplete && s.openDebts === 0, node: "volume.settle", kind: "volume", target: "整卷" },

  { id: "layout-gap", when: (s) => s.chapterVolume === null, node: "design.volume_layout", kind: "design", target: "分卷布局（没覆盖到下一章）" },

  // 阻断项优先于本章所有后续步骤，包括 chapter-review。
  // 放在 review 后面会出现正反馈：审读报 s2 → 落「未处置」→ 导演仍命中
  // chapter-review → 再审 → 同一个问题再报一次 s2。审读子代理每轮都以为
  // 自己上报过了，状态看着也正常，但那一章永远走不到改稿——无声空转，
  // 比崩溃难发现得多。
  { id: "chapter-blocked", when: (s) => s.chapterBlocking > 0, node: "chapter.blocked", kind: "gate", target: "本章阻断项" },

  { id: "chapter-outline", when: (s) => s.chapterStage === null || s.chapterStage === "细纲待确认", node: "chapter.outline_confirm", kind: "chapter", step: "outline" },
  { id: "chapter-materials", when: (s) => s.chapterStage === "细纲已确认", node: "chapter.materials", kind: "chapter", step: "materials" },
  { id: "chapter-draft", when: (s) => ["已备料", "起草中"].includes(s.chapterStage), node: "chapter.draft", kind: "chapter", step: "draft" },
  // 「待审」「审读中」都在内：会话若死在 forge_dispatch_review 与
  // forge_record_findings 之间，章节就卡在这个阶段。这里若不覆盖它，没有一条
  // 章节规则命中，导演会一路落到非章节规则上去（多半是整卷结算）——
  // 正好毁掉「中断后按真源接着走」这条保证。子代理的结果活不过一次崩溃，
  // 重派一轮审读才是正确恢复，不是浪费。
  //
  // 但**不覆盖「起草中」**：那表示稿子已经写出来、却还没落进草稿区，正文只
  // 存在于某个子代理的返回值里，崩溃之后就没了。这时候能做的只有重起草
  // （落在上一条规则上），派审读只会拿到一份不存在的 draftText。
  { id: "chapter-review", when: (s) => ["待审", "审读中"].includes(s.chapterStage), node: "chapter.review", kind: "chapter", step: "review" },
  // 到顶规则必须排在 chapter-revise 前面：改满上限后再自动派一轮，就是死循环。
  // 作者在闸门上放过「再改一轮」时，上限按 reviseWaiver 临时加高——加的是轮数，
  // 不是把闸门关掉：这一轮改完再到顶，还会再问一次。
  {
    id: "chapter-revise-exhausted",
    when: (s) => s.chapterStage === "待改" && s.reviewRounds >= MAX_REVISION_ROUNDS + s.reviseWaiver,
    node: "chapter.revise_exhausted", kind: "chapter",
  },
  { id: "chapter-revise", when: (s) => s.chapterStage === "待改", node: "chapter.revise", kind: "chapter", step: "revise" },
  { id: "chapter-settle", when: (s) => s.chapterStage === "待定稿", node: "chapter.settle", kind: "chapter", step: "settle" },

  { id: "next-chapter", when: () => true, node: "chapter.outline_confirm", kind: "chapter", step: "outline" },
];

export function evaluate(state, chapterNum) {
  const key = chapterKey(chapterNum);
  const s = state.chapters.find((c) => c.chapter === key) ?? null;

  const volume = volumeOfChapter(chapterNum, state.volumes);
  const end = volumeEnd(volume, state.volumes);

  // 「本卷写完」的判据是：刚定稿的那一章就是本卷最后一章，且手上没有在途章节。
  const finished = state.lastChapter;
  const finishedVolume = volumeOfChapter(finished || 1, state.volumes);
  const finishedEnd = volumeEnd(finishedVolume, state.volumes);
  // 已结算的卷不再重复提请定稿——否则导演会对着 volume.settle 无限循环。
  const alreadySettled = (state.settled ?? []).includes(finishedVolume);
  const volumeComplete = finished > 0 && finishedEnd !== null && finished >= finishedEnd && s === null && !alreadySettled;

  const ctx = {
    ...state,
    chapterStage: s?.stage ?? null,
    // 本章还没处置的阻断项。以前没有这个计数，于是「审读报 s2 → 结论蒸发 →
    // 导演仍在审读中 → 再审一轮」变成无声死循环。详见 gates.js 的 recordFinding。
    chapterBlocking: (state.debtEntries ?? []).filter(
      (e) => e.status === "未处置" && String(e.chapter ?? "") === key,
    ).length,
    reviewRounds: reviewRoundsOf(s),
    reviseWaiver: reviseWaiverOf(s),
    chapterState: s,
    chapterVolume: volume,
    volumeComplete,
  };

  const rule = RULES.find((r) => {
    try {
      return Boolean(r.when(ctx));
    } catch {
      return false;
    }
  });
  const gate = gateCheck(state.policy, rule.node);

  return {
    ok: true,
    rule: rule.id,
    node: rule.node,
    kind: rule.kind,
    step: rule.step ?? null,
    target: rule.target ?? `第 ${chapterNum} 章`,
    chapter: chapterNum,
    chapterKey: key,
    volume,
    volumeEnd: end,
    volumeComplete,
    alreadySettledVolume: alreadySettled,
    gate,
    proceed: gate.proceed,
    reason: gate.proceed
      ? `${rule.node} 是 auto 级，自动推进。`
      : `${rule.node} 是 ${gate.level} 级门禁：${gate.stopReason}`,
  };
}

/** 导演此刻该做什么。优先接着推进在途章节，没有就开下一章。 */
export async function nextAction(workspaceRoot, bookTitle) {
  const state = await deriveState(workspaceRoot, bookTitle);
  if (!state.ok) return state;

  const inFlight = state.chapters.find((c) => c.stage !== null && c.stage !== "已定稿");
  const target = inFlight ? Number(String(inFlight.chapter).replace("ch", "")) : state.nextChapter;

  const action = evaluate(state, target);
  return {
    ...action,
    book: bookTitle,
    finalizedChapterCount: state.finalizedChapterCount,
    openDebts: state.openDebts,
    hasVolumeLayout: state.hasVolumeLayout,
  };
}

/**
 * 一次并行轮次能派哪些活。看板：当前章还没到的步骤都能提前排上，
 * 因为它们之间没有依赖——这是 fan-out 的全部价值。
 */
export function parallelPlan(action) {
  const ahead = {
    outline: ["materials", "draft", "review"],
    materials: ["draft", "review"],
    draft: ["review"],
    review: [],
    revise: [],
    settle: [],
  };
  const fanOutable = (action.kind === "chapter" && action.step === "outline") || action.kind === "design";
  if (!fanOutable) return { canFanOut: false, steps: [action.step ?? action.node] };
  return { canFanOut: true, steps: [action.step ?? action.node, ...(ahead[action.step] ?? [])] };
}

/**
 * 每个步骤该派什么样的子代理，以及给它什么。
 *
 * 这是导演的「施工单」。返回的 prompt 必须自包含——子代理拿不到本会话的上下文，
 * 也不该去读什么文件。需要真源内容的地方，调用方先把内容塞进 extra。
 */
/**
 * 作者的闸门答复，渲染成给子代理看的一段。
 *
 * 为什么非要把这段塞进施工单：发现项的 note 是写给**作者**看的，里面常常
 * 列着「请二选一：A 或 B」。改稿子代理拿不到答复，就只能自己挑一个——
 * 真机上第 1 章 v10 挑中的正是作者否掉的那一支，于是 d0007（第 14 章的
 * 回收路径被写死）连着两版原样留着，而它交回时没留〔未处置〕：它以为自己办完了。
 *
 * 选项名与理由都要给。只给「按发现项改掉再定稿」不足以执行——具体动作
 * （「删掉『靠前两个字先没了』」）写在作者的理由里。
 */
function renderGateDecisions(decisions) {
  const list = Array.isArray(decisions) ? decisions.filter((d) => d && String(d.choice ?? "").trim()) : [];
  if (list.length === 0) return "";
  const lines = [
    "## 作者已经拍板的处置（**优先于发现项里的任何并列选项**）",
    "",
    "下面每条都是作者在闸门上亲自选的。发现项的说明里若写着「二选一」「或」"
      + "之类的并列方案，**以这里的答复为准**，不要自己挑一个省事的。",
    "",
  ];
  for (const d of list) {
    lines.push(`- ${d.node}：**${d.choice}**`);
    const note = String(d.note ?? "").trim();
    if (note) lines.push(`  作者的理由与具体做法：${note}`);
  }
  return lines.join("\n");
}

export const STEP_SPECS = {
  outline: {
    role: "章细纲起草子代理",
    needsModel: true,
    // 不含 outlineBrief：细纲起草者是「提方案」的人，逼调用方先把本章目标定好，
    // 等于把它该干的活干了。卷纲与契约是它的锚，必须给。
    requires: ["volumePlan", "contract"],
    outputHint: "候选细纲正文（Markdown），每条约束前标〔硬〕〔软〕〔自由〕",
    build: (a, x) => ({
      prompt: [
        `你是一位长篇网络小说的章细纲起草者。这是《${a.book}》的第 ${a.chapter} 章，属于第 ${a.volume} 卷。`,
        "",
        "## 本章要完成的事",
        x.outlineBrief ?? "（调用方未给出本章目标，请据卷纲与上一章结尾自行拟定）",
        "",
        "## 本卷规划",
        x.volumePlan ?? "（调用方未提供卷纲原文）",
        "",
        "## 上一章结尾",
        x.prevChapter ?? "（本章是全书第一章，没有上一章）",
        "",
        "## 必须遵守的契约红线",
        x.contract ?? "（调用方未提供）",
        "",
        "## 伏笔台账",
        x.foreshadow ?? "（调用方未提供）",
        "",
        "## 输出要求",
        "1. 直接给细纲正文，不要解释你怎么想的。",
        "2. 每条约束前标等级：〔硬〕必须成立，违反就是 bug；〔软〕尽量满足；〔自由〕可以发挥。",
        "3. 细纲要具体到场景、动作、对话要点，不要写「推进剧情」这种空话。",
        "4. 不要发明任何关键设定：材料里没有的名字、地名、法则一律不出现。",
        "",
        // 字段清单照 oh-story `references/workflow-outline.md` 的细纲模板搬。
        // 真机上我们原来的细纲只有「任务／约束／场景」三块，正文写作要用的
        // 目标情绪、主角关键选择、章尾落点全都没有——写手只能自己猜，
        // 猜出来五份草稿五个样。模板必须发到起草者手上，不能靠它自觉。
        "## 必须写全的字段",
        "",
        "用 `- 字段名：内容` 的行式写，一个不漏：",
        "",
        "- 核心事件：一句话",
        "- 字数目标：{X} 字",
        "- 字数口径：visible_chars_v1",
        "- 单元ID/位置：卷纲剧情单元 ID；单元内第几拍",
        "- 目标情绪：**具体情绪的前状态→后状态**，例如「戒备→被迫承认自己在听」。",
        "  不得只写「紧张」「压抑」这种标签。",
        "- 主角目标/关键选择：主角本章要什么；必须做出的判断或选择。",
        "- 章首钩子：一句话钩住读者的具体内容",
        "- 爽点：低压/过场章可写「无显性爽点，功能是…」，但仍须给读者一个往下看的理由",
        "- 本章禁止提前释放：**只写本章特有的三五条**，卷级禁忌不逐章复读；没有写「无」",
        "",
        "**其中「目标情绪」与「主角目标/关键选择」两条不许留 `[待补充]`。**",
        "这两个字段是拿隔离实验验过的：只补它们两个，正文收益与补满全部字段不可区分；",
        "而它们空着，写手只能自己编一个情绪方向，五份稿子五个样。",
        "其余字段确实定不下来时写 `[待补充]`，照实标，不要硬编。",
        "",
        "## 必须有的小节",
        "",
        "- `#### 内容概括（五段式）`：起因／发展／转折／高潮／结尾。",
        "  结尾写**具体落点**（落在谁的什么动作/画面/台词上），不写「尘埃落定」这种状态判词。",
        "- `#### 情节安排（多线）`：主线推进／辅线推进／事件线／感情线／逻辑线。",
        "  本章确无非主线在动时写「无」，不凭空制造。",
        "- `#### 人物关系和出场顺序`：出场顺序／关系变化（本章前→本章后）／视角与信息差。",
        "- `#### 情节细化`：一张表，四列 `# / 情节点（谁做了什么）/ 功能标签 / 执行边界（禁＋放）`。",
        "  功能标签＝目的词（铺垫/高潮/爽点/打脸/人物塑造/设定）。",
        "  **执行边界写「禁＋放」两半**：禁＝本点不能提前释放什么；放＝本点允许什么落地、到什么量级。",
        "  **每章至少一个点要写「放」**——放行是解除限制，不是义务；但一个都不放，写手会全程缩着写。",
        "  另有「复沓锚句」一行：须一字不差进正文的原话，注明落点；没有写「无」。",
        "- `#### 结尾设定和钩子`：结尾设定／章尾钩子（具体内容，期待度强/中/弱；与下一章如何承接）。",
        "",
        "## 可选字段（写了写手照样消费，不写不拦）",
        "",
        "- 本章标价：这一章的得失折算成读者已经知道的什么",
        "- 闭环状态：获得/使用/见效/估值走到哪一拍",
        "- 信息差触发点：在第几点提醒读者手里那张牌",
        "- 镜头准入：哪一场给谁台词位",
        "- 情节细化表可加「分辨率」列（密/中/疏，同类并列递减，不平均用力）",
      ].join("\n"),
    }),
  },
  materials: {
    role: null, // 纯工具步骤，不需要模型
    needsModel: false,
    outputHint: "无需子代理：forge_assemble_materials 一次调用即可",
  },
  draft: {
    role: "正文起草子代理",
    needsModel: true,
    requires: ["taskText"],
    outputHint: "章节正文全文（Markdown），不要附任何说明或自评",
    build: (_a, x) => ({
      prompt: [
        "你是一位长篇网络小说的正文作者。你没有本次会话的任何记忆，下面就是全部依据。",
        "",
        x.taskText ?? "（调用方未提供任务包）",
        "",
        "## 输出要求",
        "1. 只输出正文，不要写「以下是第X章」这类引导语。",
        "2. 严格照任务包里的约束分级执行，〔硬〕级一条都不能违反。",
        "3. 不要在正文里解释设定，设定靠行为体现。",
        "4. 任务包里「写作纪律」一节是**可核查的要求**，不是参考意见。它管的是句子长度、对白占比、" +
          "感官覆盖、段落节奏这些正文层面的东西——材料决定你写什么，那一节决定你写成什么样。",
        "5. 别把〔硬〕「不写内心、只写动作」执行成短句流水账：动作照样要用逗号长句写足。",
      ].join("\n"),
    }),
  },
  review: {
    role: "审读子代理",
    needsModel: true,
    requires: ["draftText"],
    // 审读者要拿细纲核「这一章有没有按自己的设计写」。没有它，
    // 「设定一致性」这个维度只能靠直觉——而第 1 章两轮审读报出的两条 s2
    // 全是**跨章**的设计破坏（袋子动线自相矛盾、第 14 章要回收的限定词
    // 在第 1 章被抹掉），那正是只有拿着细纲才看得出的那类问题。
    // 走 wantsContext 而不是 requires：细纲缺失时审读照跑，
    // 缺输入是 missing-input 闸门的事，不该把审读整步拦掉。
    wantsContext: ["outlineBrief"],
    outputHint: "发现项数组，每条含逐字 quote 与问题说明；零问题也要说明覆盖过哪些维度",
    build: (a, x) => ({
      prompt: [
        `你是《${a.book}》第 ${a.chapter} 章的审读者。`,
        "",
        "## 待审正文",
        x.draftText ?? "（调用方未提供正文）",
        "",
        // 细纲给审读者不是为了让它变成合规检查表——那会让它只盯「写没写到」，
        // 看不见「写出来的东西是不是还成立」。给它的用途是两条：
        // 一条是核正文与细纲有没有互相打架；另一条是**核这一章有没有毁掉
        // 后面某一章要用的东西**。后者是这一章最容易犯而读者最难发现的错，
        // 也是第 1 章实际报出来的两条 s2。
        "## 本章细纲（用来核两件事，别拿它当逐条打勾的清单）",
        x.outlineBrief ?? "（调用方未提供细纲。拿不到就只按正文判断，并在结论里说明这一点。）",
        "",
        "- 正文与细纲互相矛盾的地方，指出来。",
        "- 正文**用掉了**细纲里某样后面还要用的东西（一个细节、一个限定词、一个位置、"
          + "一句没说完的话），指出来——那种问题本章读起来完全正常，要到后面才炸。",
        "",
        "## 必须审的维度",
        (x.dimensions ?? ["人物与关系", "情节与因果", "节奏", "设定一致性", "文风与表达"]).map((d, i) => `${i + 1}. ${d}`).join("\n"),
        "",
        "## 本章应满足的契约红线",
        x.contract ?? "（调用方未提供）",
        "",
        // 正文体检：把「AI 味重」这个说不清的判断换成可以核对的一行行数字。
        // 第 1 章试跑时的教训是——审读者面对一篇禁用词 0、套词 0、弱化副词 0
        // 却读起来仍然是机器味的稿子，只能凭感觉说「文风尚可」；
        // 真正的问题（对话占比 3%、逗号长句 42%、虚词 65/千字）没有任何人看得见。
        // 这里给的是**候选**不是判决：真人写的冷硬文体也可能落在基线外，所以最后一句话把裁决权交回审读者。
        "## 正文体检（机器量的，只作候选，不作判决）",
        // measureProse 是纯函数，所以这里量两次、下面再量一次，
        // 三次读数按定义必然一致——比拆成一个共享变量省事，也不会哪天被改动弄岔。
        renderProseMetrics(measureProse(x.draftText)),
        "",
        renderProseCandidates(measureProse(x.draftText)),
        "",
        "上面每一条都带真人语料基线。落在基线外的不一定是问题——但**你得先看一眼再放过**。",
        "核对过认为不算问题的，在结论里写「已核对，不算问题」并说明为什么。",
        "",
        "## 输出要求",
        "1. 每条发现项必须给出**逐字摘自正文**的 quote，以及这句有什么问题。不得转述，不得概括。",
        "2. 给每条标严重度：s1 阻断性（事实矛盾/人物崩坏/与已定稿冲突）、s2 结构性（本章目标未达成/因果断裂/节奏塌陷）、s3 可优化、s4 风格润色。",
        "3. 没发现问题就明确说没有，并列出你实际审过哪些维度。不要为了凑数编问题，也不要什么都不说就交差。",
        "4. 「机器候选发现项」里的每一条你都必须表态：采纳就写进你的发现项（严重度可以改，但要说明为什么改），" +
          "不采纳就写「已核对，不算问题：<理由>」。**不许整条略过。**",
        "   机器只会数，它数不出反讽、数不出刻意的冷硬文体，也数不出「这一处本来就该短」；" +
          "但反过来说，它数得出来的你多半看不出来——第 1 章那一稿的对话占比只有 3%，" +
          "所有读过的人给的评价都是「文风尚可」。",
        "",
        // 这一节是因为真机上出过一次**结论丢失**才补的。
        //
        // 第 1 章第二轮审读抓到了两条 s2，写得很好，但它没有回写，理由写在交回文本里：
        // 「若要落台账，其中 F1、F2 按门禁是 s2，会当场阻断并停下——这个决定该由作者做，
        // 我不替你按下。」它的判断在当时是对的：那会儿 s1/s2 一记就什么都不留下，
        // 子代理以为「不写才是稳妥」。
        //
        // 结果那一轮的结论**全丢了**：台账里一条都没有，导演下一轮照旧去审读。
        // 所以现在必须明说：写，就是你的活；停下问作者是导演的活。
        "## 发现项怎么交回（这一段是硬要求）",
        "",
        "用 forge_record_finding 逐条回写，**包括 s1 和 s2**。",
        "不要把「会不会打断流程」当成你不写的理由——那是导演的事，不是你的。",
        "s1/s2 回写后会记成一条「未处置」的阻断项，导演会在 chapter.blocked 上停下来",
        "请作者拍板；s3/s4 记成质量债继续跑。**两条路都不会丢你的结论。**",
        "真正会丢结论的是只把发现项写在交回文本里：那它就只活在这一次对话里，",
        "子代理一结束、会话一断，没人再看得见。真机上已经这样丢过一整轮。",
      ].join("\n"),
    }),
  },
  revise: {
    role: "改稿子代理",
    needsModel: true,
    // requires 是**硬性必需**：缺了就由 missing-input 闸门拦下，不派子代理。
    // 缺了会拿到一份空输入的废稿，所以宁可停下。
    //
    // characters / styleBrief 不在这里，而在 wantsContext：
    // 它们是**补料**——书仓里有就带上，没有就照常跑。
    // 放进 requires 是个真犯过的错：这本书没有自定义文风，于是 styleBrief 为空，
    // 闸门把整条链拦死，而 oh-story 对这种情况的处置是
    // 「未进入自定义文风模式」，继续写，不是报错。补料不该触发硬闸门。
    requires: ["draftText", "findings", "outlineBrief"],
    // characters：改稿的规矩是「人名一个字都不能动」，可它手上从来没有人物材料。
    //   真机上第 1 章就是这样——材料给了「周砚」，正文全程写「他」，
    //   改稿者连该补什么都不知道。给了材料它才分得清「漏」和「改」。
    // styleBrief：这一段的 build 里渲染写作纪律，不传参就少了「本书自己的写法」
    //   那一节，起草和改稿按两套纪律写，是同一本书里最不该有的分叉。
    wantsContext: ["characters", "styleBrief"],
    outputHint: "改完后的章节正文全文（整稿，不是补丁）",
    build: (a, x) => ({
      prompt: [
        `你是一位长篇网络小说的改稿者，负责按审读发现项重写《${a.book}》第 ${a.chapter} 章。`,
        "",
        "## 待改正文",
        x.draftText ?? "（调用方未提供正文）",
        "",
        "## 本章细纲（含〔硬〕约束）",
        x.outlineBrief ?? "（调用方未提供细纲）",
        "",
        // 写作纪律与起草同一份。起草和改稿按两套纪律写，改完就漂移。
        renderWriterRole({
          genre: genreFromContract(x.contract),
          styleBrief: x.styleBrief ?? "",
        }),
        "",
        // 改稿这一步**只给数字，不给机器候选清单**——这是有意的。
        // 候选清单是给审读者表态用的；审读者已经表过态，采纳的进了下面的发现项，
        // 没采纳的（「已核对，不算问题」）不该在改稿时被机器再压一次。
        // 改稿者要的是「按发现项改，顺手把跑偏的数字拉回来」，不是重新审一遍。
        "## 上一稿的体检结果",
        renderProseMetrics(measureProse(x.draftText)),
        "",
        // 这一段取代了原来那句「改稿时*顺手*把落在基线外的项拉回来」。
        // 「顺手」把结构活降级成了附赠，于是真机上连改 8 轮、发现项从 16 条降到
        // 3 条，而句子形状分毫未动（逗号长句 39.0%→42.0%，真人 74–80%；
        // 虚词 68.5→65.4，≥85；对话 2.6%→3.0%，40–60%）。
        // 现在按离基线的相对距离分档：差得远的写成「本轮的结构活」，
        // 差得少的明确不许动。判据与实测依据见 prose.js 的 proseGaps。
        renderProseGaps(measureProse(x.draftText)),
        "",
        "## 人物材料",
        x.characters ?? "（调用方未提供人物材料。人名一律照原稿保留，不要改动，也不要新造。）",
        "",
        // 这条边界原来写的是「人名、事件、因果、人物决定、伏笔一个字都不能动」，
        // 而原稿把主角名字整个漏掉时，这条规矩会让改稿者**不敢补**。
        // 漏和改是两件事：材料里给了名字而正文没写出来，那是漏，补上。
        "改稿的边界是**改表达、不改事实**：",
        "",
        "- 原稿里已有的名字、事件、因果、人物决定、伏笔，一个字都不能动。",
        "- 但材料里给了名字、正文却通篇没写出来的（比如主角姓名），**补上**——那是漏，不是改动。",
        "- 不要在材料之外新造名字、地名、法则。",
        "",
        "## 必须逐条处置的发现项",
        (x.findings ?? []).length > 0
          ? (x.findings ?? []).map((f, i) => {
            const tag = [f.id, f.severity, f.dimension].filter(Boolean).join(" ");
            return `${i + 1}. [${tag || "发现项"}] ${f.note}\n   原文：${f.quote}`;
          }).join("\n")
          : "（本轮没有回写的发现项。若上一位审读者把结论写进了别的通道，你手上就只有正文和下面那几节——这种情况照正文和细纲判断，别硬编。）",
        "",
        // 这一段是因为真机上连出两版同一个错才补的。
        //
        // 发现项的 note 是写给**作者**看的，里面常常列着「请二选一：A 或 B」。
        // 改稿者拿不到作者的答复，就只能自己挑一个——第 1 章 v10 挑中的恰恰是
        // 作者明确否掉的那一个，于是 d0007（第 14 章的回收路径被写死）连着两版
        // 没动，而它交回时并没有留〔未处置〕：它以为自己办完了。
        renderGateDecisions(x.gateDecisions),
        "",
        "## 输出要求",
        "1. 输出**改完之后的整篇正文**，不要输出 diff，不要输出「修改如下」。",
        "2. 保留原文中没被点名的问题的地方，不要借机大改。",
        "3. 每条发现项都要能在改后正文里看出确实改了。",
        "4. **细纲优先于发现项，而且不止〔硬〕那几条。**〔硬〕只是最容易判的那种。" +
          "凡是细纲里明写的都算数：场景里的具体动作、章末留给下一章的钩子、" +
          "「这一样东西到第几章才回收」这类安排。" +
          "发现项里给的「建议改法」是线索，不是指令——它自己也可能毁掉设计。" +
          "真机上就这么翻过车：审读建议把一句里靠前的两个字抹掉、正好因为那两个字" +
          "是第 14 章要捞回来的限定词，而细纲场景二要的是「后半句**已经开始模糊**」，" +
          "不是「前半句被抹掉」。下一轮的审读把它判成 s2，" +
          "而产生它的那条建议恰恰来自上一轮审读自己。",
        "5. 两条都做不到时，**保留〔硬〕**，并在正文之外的末尾用一行 `〔未处置〕` 开头说明" +
          "哪条发现项、撞的是哪条〔硬〕。改稿者没有权力为了消一条发现项去违反〔硬〕。",
        "6. 那条说明是给作者看的，**不属于正文**：它由导演在落稿前摘走。" +
          "除它之外不要在返回值里写任何说明、小结、改动清单——返回值会被当成整篇正文落盘。",
        "7. 上面的体检数字**不是唯一目标**。为凑指标注水（硬加台词、把长句拆成碎句、塞感官描写）" +
          "比指标不达标更糟。指标只是提醒你哪里可能偷了懒，最后仍以读起来对不对为准。",
      ].join("\n"),
    }),
  },
  settle: { role: null, needsModel: false, outputHint: "无需子代理：等作者裁决后 forge_settle_chapter" },
};

/** 给某个步骤生成施工单。没有对应规格就明确说没有，不硬凑。 */
export function buildTaskSpec(action, extra = {}) {
  const spec = STEP_SPECS[action.step ?? ""];
  if (!spec) {
    return {
      ok: false, stage: "no-spec",
      detail: `${action.kind}/${action.step} 不是模型步骤（${action.node}）。它由工具直接完成，或该停门禁上等作者。`,
    };
  }
  if (!spec.needsModel) {
    return { ok: true, step: action.step, node: action.node, needsModel: false, outputHint: spec.outputHint };
  }
  // 失败优先于构造 prompt。
  //
  // 少了输入字段时，prompt 会写上「（调用方未提供正文）」接着往下跑——
  // 审读子代理拿不到正文，会老老实实回一句「没问题」；
  // 改稿子代理拿不到发现项，会自由发挥。两条路最终都汇到同一个结局：
  // **没审过的章节静默出厂**，日志上一切正常。
  //
  // 与其在 prompt 里写占位符，不如让这一步直接失败。
  const missing = (spec.requires ?? []).filter((k) => {
    const v = extra?.[k];
    if (v === undefined || v === null) return true;
    if (typeof v === "string") return v.trim() === "";
    if (Array.isArray(v)) return v.length === 0;
    return false;
  });
  if (missing.length > 0) {
    return {
      ok: false,
      stage: "missing-input",
      detail:
        `${spec.role} 缺少 ${missing.join("、")}，带着空输入跑只会得到一份看似正常的废稿。` +
        "先从书仓真源里把这段内容取出来，放进 context 再跑这一轮。",
    };
  }

  const { prompt } = spec.build(action, extra);
  return {
    ok: true,
    step: action.step,
    node: action.node,
    chapter: action.chapter,
    role: spec.role,
    needsModel: true,
    prompt,
    outputHint: spec.outputHint,
  };
}