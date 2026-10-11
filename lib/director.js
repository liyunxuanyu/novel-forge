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
import { listChapterStates, chapterKey, MAX_REVISION_ROUNDS, reviewRoundsOf } from "./chapter-state.js";
import { loadPolicy, gateCheck, listDebts } from "./gates.js";

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
  {
    id: "chapter-revise-exhausted",
    when: (s) => s.chapterStage === "待改" && s.reviewRounds >= MAX_REVISION_ROUNDS,
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
    reviewRounds: reviewRoundsOf(s),
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
      ].join("\n"),
    }),
  },
  review: {
    role: "审读子代理",
    needsModel: true,
    requires: ["draftText"],
    outputHint: "发现项数组，每条含逐字 quote 与问题说明；零问题也要说明覆盖过哪些维度",
    build: (a, x) => ({
      prompt: [
        `你是《${a.book}》第 ${a.chapter} 章的审读者。`,
        "",
        "## 待审正文",
        x.draftText ?? "（调用方未提供正文）",
        "",
        "## 必须审的维度",
        (x.dimensions ?? ["人物与关系", "情节与因果", "节奏", "设定一致性", "文风与表达"]).map((d, i) => `${i + 1}. ${d}`).join("\n"),
        "",
        "## 本章应满足的契约红线",
        x.contract ?? "（调用方未提供）",
        "",
        "## 输出要求",
        "1. 每条发现项必须给出**逐字摘自正文**的 quote，以及这句有什么问题。不得转述，不得概括。",
        "2. 给每条标严重度：s1 阻断性（事实矛盾/人物崩坏/与已定稿冲突）、s2 结构性（本章目标未达成/因果断裂/节奏塌陷）、s3 可优化、s4 风格润色。",
        "3. 没发现问题就明确说没有，并列出你实际审过哪些维度。不要为了凑数编问题，也不要什么都不说就交差。",
      ].join("\n"),
    }),
  },
  revise: {
    role: "改稿子代理",
    needsModel: true,
    requires: ["draftText", "findings"],
    outputHint: "改完后的章节正文全文（整稿，不是补丁）",
    build: (a, x) => ({
      prompt: [
        `你是一位长篇网络小说的改稿者，负责按审读发现项重写《${a.book}》第 ${a.chapter} 章。`,
        "",
        "## 待改正文",
        x.draftText ?? "（调用方未提供正文）",
        "",
        "## 必须逐条处置的发现项",
        (x.findings ?? []).map((f, i) => `${i + 1}. [${f.dimension ?? f.severity ?? ""}] ${f.note}\n   原文：${f.quote}`).join("\n"),
        "",
        "## 输出要求",
        "1. 输出**改完之后的整篇正文**，不要输出 diff，不要输出「修改如下」。",
        "2. 保留原文中没被点名的问题的地方，不要借机大改。",
        "3. 每条发现项都要能在改后正文里看出确实改了。",
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