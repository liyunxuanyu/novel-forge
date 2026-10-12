/**
 * 文笔体检 —— 把「AI 味」里可机械量化的那几项量出来，并给出写作纪律。
 *
 * 为什么需要它：原来的 ai-flavor.js 只查五类套话（排比、总结、情绪直述、万能形容词、
 * 对称句式）。真机上第 1 章 v8 那稿的实测结果是——**这五类一条都没命中**，
 * 而正文读起来仍然是机器味。它的病不是套话，是另外几项：
 *
 *   对话占比 3.0%（网文典型 40–60%）  逗号长句占叙述句 42%（真人 74–80%）
 *   整句均长 17.0 字（真人 22–24）    虚词密度 65.4/千字（真人 ≥85）
 *
 * 这是「过度压缩的电报体 + 几乎零对话 + 匀速叙事」。套话检测器看不见它，
 * 因为它的病恰恰是**没有**套话。
 *
 * 因此这里换一条路：拿真实语料的统计基线来量。基线来自 oh-story 在
 * 七猫长篇 125 本 × 前 8 章上的校准值（见 BASELINE 的出处注释）。
 *
 * 三条规矩：
 * 1. **纯函数**。同一段文本两次量出的数必须完全一致——不调模型、不看时间。
 * 2. **只报不改**。这里绝不碰正文一个字。
 * 3. **报数字**。「AI 味重」这种评语没有用，「对话占比 3%，基线 40–60%」才有用。
 *
 * 而且——**统计信号不是判决**。真人写的冷硬文体一样可能落在基线外。
 * 所以每条发现项都带一句：这是信号，读一遍再决定，不要为了凑数字注水。
 */

/**
 * 真实语料基线。
 *
 * 来源：oh-story 的 check-ai-patterns.js / anti-ai-writing.md，
 * 校准语料为七猫长篇 125 本 × 前 8 章，以及《万疆》真人 20 章。
 * 这些数字是**描述性**的（真人这么写），不是规范性偏好。
 */
export const BASELINE = {
  /**
   * 逗号之间平均字数。
   * 判定带 8–12 字 —— 这是 oh-story 给写作者的要求区间；
   * 它同时在七猫 125 本 × 前 8 章上量到的**实测中心**是 8.8–9.6，记在 measured 里。
   * 两个数不一样，别混：拿实测中心当判定线，会把「按要求写、只是略偏中心」的稿子判成问题。
   */
  commaSeg: { lo: 8, hi: 12, measured: "8.8–9.6" },
  /** 整句平均字数。真人 22–24。低于 20 判过短。 */
  sentence: { lo: 22, hi: 24, floor: 20 },
  /** 含两个以上逗号的叙述句占全部叙述句的比例。真人 74%–80%。低于 60% 判碎。 */
  commaLongRatio: { lo: 0.74, hi: 0.8, floor: 0.6 },
  /** 虚词密度（的/了/就/着/过/呢/吧/啊/呀/嘛），每千字。低于 85 判虚词被扫光。 */
  funcDensity: { floor: 85 },
  /** 功能词密度（更宽的一张表），每千字。低于 100 判低连接密度。 */
  connectiveDensity: { floor: 100 },
  /** 弱化副词密度（缓缓/微微/轻轻/淡淡…），每千字。高于 3 是 AI 签名。 */
  weakAdverb: { ceiling: 3 },
  /** ≤15 字的叙述段占比。高于 58% 判提纲感。 */
  shortParaRatio: { ceiling: 0.58 },
  /**
   * 段落长度变异系数（标准差/均值）低于此值，判「平均用力」。
   *
   * 校准过程写在 uniform-paragraphs 那条判据的注释里。关键结论：
   * 它认得出病态均匀（反样本 0.010），但真实草稿远在另一侧（0.52–0.87），
   * 所以它是**烟雾报警器**，不是文风门禁。
   */
  paraCv: { floor: 0.12 },
  /**
   * 判段落均匀至少要有多少个叙述段。
   * 三段两段谈不上均匀——那只是短章。24 段是随手取的整数，
   * 没调过：真到要判均匀的稿子，段落数从来不是瓶颈。
   */
  minParagraphsToJudge: 24,
  /** 连续 ≤5 字的叙述短句最长连排。≥6 判碎句号。 */
  stutterRun: { ceiling: 6 },
  /**
   * 「中长承接句」的定义与占比下限。
   *
   * 真源（`check-ai-patterns.js:178-179`）取 ≥30 字、占比下限 0.08，
   * 并且**把它当成低连接密度的必要条件**而不是独立判据——理由写在源码里：
   * 「单纯低功能词会误抓有大量中长句的文本，因此必须叠加『中长句不足』」。
   *
   * 道理是：一个长句本来就能塞下好几个结构位置，所以长句多的稿子虚词密度低
   * 很正常。我原来把虚词密度单独判，等于专抓这种合法形态。
   */
  longSentence: { chars: 30, ratioFloor: 0.08 },
  /** 对话字数占全文比例。网文典型 40%–60%，低于 30% 已有问题。 */
  dialogueRatio: { lo: 0.4, hi: 0.6, floor: 0.3 },
  /** 判决门槛：短于这个字数的稿子不判——样本太小，统计量没有意义。 */
  minCharsToJudge: 600,
};

/** 虚词：结构虚词被扫光是电报体最直接的指纹。 */
const FUNC_RE = /[的了就着过呢吧啊呀嘛]/g;

/** 功能词：更宽的一张表，量的是「承接关系有没有写出来」。 */
const CONNECTIVE_RE = /的|了|就|在|是|也|都|还|又|把|被|给|这个|那个|里面|以后|时候|现在|因为|所以|但是|不过|然后|已经|还是|起来|出来|下去/g;

/**
 * 动作清单的动词表与双门槛。
 *
 * 这三行是从 oh-story 的 `check-ai-patterns.js:93-95` 原样搬来的（MIT，可复用）。
 * 我自己先试过一个不要词表的代理——「分隔符 ≥4 而句内零结构虚词」——它**校准失败**：
 * 报出来的是「白炽灯是四十瓦的，照得人脸发青，棺停在正中」这类并列**描写**，
 * 那是合法的散文；而且它在「有新写作纪律」那一臂报得更多，方向是反的。
 * 原因是没有词表就分不出「收/擦/按」是动作而「是/照得/停在」不是。
 * 所以这里不再自创判据，直接用真源那张表。
 *
 * 真源按**段**统计（同段内），不是按句——注释里写的是「同一段连续堆叠」。
 * 门槛 5 个动词 **且** 4 个分隔符，两个都要满足才报。
 */
const ACTION_VERB_RE = /伸手|抬手|探手|拿起|拿过|取出|取过|掏出|摸出|抓起|攥住|握住|捏住|按住|推开|拉开|打开|关上|放下|递给|挑开|掀开|扯开|拧开|倒出|端起|转身|回头|抬头|低头|弯腰|俯身|走到|走向|坐下|站起|看向|看着|盯着|扫过/g;
const ACTION_VERB_MIN = 5;
const ACTION_SEP_MIN = 4;

/** 弱化副词。 */
const WEAK_ADVERB_RE = /缓缓|微微|轻轻|淡淡|静静|默默|悄悄|慢慢|渐渐|暗暗/g;

/** 一级禁用词：真人语料几乎不出现、模型特有的词。 */
export const BANNED_WORDS = [
  "仿佛", "犹如", "宛若", "如同", "一丝", "一抹", "些许", "几分", "隐约",
  "毫无征兆", "几不可闻", "微不可察", "深吸一口气", "不禁",
  "眼中闪过", "嘴角勾起", "眉头微皱", "瞳孔微缩", "瞳孔一缩", "指节泛白",
  "眼神锐利", "目光锐利", "心中一动", "心头一震", "心下了然", "心中暗道",
  "心底泛起", "不由得", "心中一凛", "不容置疑", "不易察觉", "显而易见",
  "毫无疑问", "不可否认", "前所未有", "不由自主", "情不自禁", "自然而然",
  "话锋一转", "映入眼帘", "沉声道", "此时此刻", "目光如炬",
];

/** 高危套词桶：同义词轮换不算修好，所以按桶计数而不是按词计数。 */
export const CLICHE_BUCKETS = [
  { name: "比喻套词", re: /仿佛|犹如|宛若|如同/g },
  { name: "微量词", re: /一丝|一抹|些许|几分|隐约/g },
  { name: "弱化副词", re: /深吸一口气|缓缓|微微|轻轻|淡淡/g },
  { name: "神态模板", re: /眼中闪过|嘴角勾起|指节泛白|目光锐利|眼神锐利/g },
  { name: "内心套话", re: /心中涌起一股|心头一震|心中一动|心下了然|心中暗道|心中一凛/g },
  { name: "判断套词", re: /不容置疑|不易察觉|显而易见|毫无疑问|不可否认/g },
  { name: "无情绪声线", re: /声音不大[^。！？\n]{0,16}却|语气平静无波|声音平直|听不出情绪/g },
  { name: "氛围套词", re: /不知何时|唾手可得|无声翻涌|难以言说/g },
  { name: "形容套词", re: /散发着一股|格外刺眼|深邃而冰冷/g },
];

/** 总结句标志：把已经演出来的意思又讲一遍。 */
export const SUMMARY_MARKERS = [
  "这意味着", "换句话说", "也就是说", "总之", "归根结底", "原来如此",
  "毫无疑问", "不言而喻", "值得一提的是", "总而言之", "简而言之",
];

/**
 * 工程词泄漏 —— 只有作者和流程才该看见的词，混进了正文。
 *
 * 这一类是真出过事的：第 1 章 v4 的末行是改稿者留下的「〔未处置〕」说明，
 * v5 的末行是「〔说明〕」。两次都是靠专门写的摘除逻辑兜住的，而摘除逻辑
 * 只在「模型恰好用了那个记号」时有效——换一个记号就漏。
 * 所以这里补一层与记号无关的检测：**正文里根本不该出现流程词汇**。
 *
 * 强项出现即报；弱项要两条以上才报（「本章」「读者」偶尔可以在人物口中出现）。
 */
const ENGINEERING_STRONG = [
  "细纲", "情节点", "卷纲", "总纲", "任务单", "任务描述", "字数目标",
  "章首钩子", "章尾钩子", "目标情绪", "系统提示词", "上下文包", "修复指令",
  "伏笔台账", "写作纪律", "发现项",
];
const ENGINEERING_SOFT = [
  "本章", "下一章", "上一章", "读者", "前文", "后文", "剧情推进", "人物弧光", "爽点", "节奏点",
];

/** 成对引号。对话就是它里面的东西。 */
const QUOTE_RE = /[「『“"]([^」』”"]*)[」』”"]/g;

/**
 * 否定翻转句：「不是 A，而是 B」「不是 A，是 B」「不是 A，却是 B」。
 *
 * 三家参考项目里**唯一都列了硬规则**的一条句式（Scriptor 进候选词表，
 * oh-story 进 blocking 组，Biz 进 high 级红线）。所以这里必须有。
 *
 * 两处口径细节抄的是 oh-story 的 not-is-comparison：
 *   · 前面一个字符是「是」时不算——「是不是…」是问句，不是翻转句；
 *   · 后半必须真出现转折词。`，是` / `。是` 这一支是「不是累，是不敢」这种省略式。
 */
const NEGATIVE_FLIP_RE =
  /(?<!是)(?:不是|并非|并不是|不能说是|不再是)[^。！？；;\n]{1,30}?[，,]?\s*(?:而是|却是|反而是|更像是|只是|[，,]\s*是|。是)[^。！？；;\n]{1,30}/gu;

/** 句末标点：正文不能停在这些之外（截断检测）。 */
const TERMINAL_RE = /[。！？!?…”"」』）)】》…]$/u;

/** 长段阈值。三家参考项目分别用 200/200/220，取最宽的那个。 */
const LONG_PARAGRAPH_CHARS = 220;

/**
 * 对白里的语气词。只用来判一件事：全章对白是不是**一个语气词都没有**。
 *
 * 这条判据不是我拍的，是从 oh-story 的 writing-craft「对话带口气」来的：
 * 人物说话要按身份、年纪、地方带「吧、呢、啊、嘛、哎」，全章对话不能一个语气词都没有。
 * A/B 试跑里 B 组的对白是「不饿。」「没湿。」「不打紧。」「行。」——一个都没有，
 * 而它读起来不像冷硬，像屋里没人在说话。
 *
 * 只在**引号内**的文本上数，而且只把「零」当成问题：
 * 语气词本身没有配额，数多了不算毛病，所以不存在误报配额的问题。
 */
const DIALOGUE_PARTICLE_RE = /[吧呢啊嘛哎呀哦嗯唉哟嘞咯呗啦哇]/g;

const p1000 = (n, len) => (len === 0 ? 0 : (n / len) * 1000);

/** 把文本拆成「引号内 = 对话」与「引号外 = 叙述」两部分。 */
export function splitDialogue(text) {
  const raw = String(text ?? "");
  const quotes = [];
  for (const m of raw.matchAll(QUOTE_RE)) quotes.push(m[1]);
  const dialogue = quotes.join("").replace(/\s/g, "");
  // 引号内容整个摘掉，**不换成占位符**。
  // 原来用的是全角空格占位「保偏移」，结果紧接着的 `.replace(/\s/g,"")` 又把它扫掉了
  // ——而 JS 的 \s 是包含 U+3000 的。于是引号前后的字直接粘在一起，
  // 句子长度、逗号段长度全部算错，而且看不出来。
  // 这里不需要保留偏移（所有统计都在这一个串上做），直接摘干净最不容易错。
  const narrative = raw.replace(QUOTE_RE, "").replace(/\s/g, "");
  return { raw, quotes, dialogue, narrative };
}

/**
 * 量一段正文。纯函数。
 * 返回的每个数都对应 BASELINE 里的一条基线；判断交给 proseFindings。
 */
export function measureProse(text) {
  const { raw, quotes, dialogue, narrative } = splitDialogue(text);
  const chars = raw.replace(/\s/g, "").length;
  const narrativeChars = narrative.length;

  // ── 段落 ──
  const paras = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && l !== "＊" && l !== "***");
  const narrativeParas = paras.filter((p) => !/^[「『“"]/.test(p));
  const shortParas = narrativeParas.filter((p) => p.length <= 15);

  // ── 叙述段长度的离散度：量「平均用力」 ──
  // 这一项是扫参考项目时才补上的。oh-story 的 writing-craft 把「每个情节点一样长、
  // 一样细」直接定为 AI 腔的**根源**（:358），另有三处同向要求：并列项要递减（:368）、
  // 不要连续多段同长度（:332）、密处禁用「一连七八下」这类量词概括（:370）。
  //
  // 在此之前我只量句子，不量段落——于是「每段都差不多长」这种最直观的机器味
  // 一条判据都碰不到。用变异系数（标准差/均值）而不是标准差，是因为它对篇幅不敏感：
  // 200 字的章和 4000 字的章可以直接比。
  const narParaLens = narrativeParas.map((p) => p.length);
  const paraAvg = narParaLens.length > 0 ? narParaLens.reduce((a, b) => a + b, 0) / narParaLens.length : 0;
  const paraSd = narParaLens.length > 1
    ? Math.sqrt(narParaLens.reduce((a, b) => a + (b - paraAvg) ** 2, 0) / narParaLens.length)
    : 0;
  const paraCv = paraAvg > 0 ? paraSd / paraAvg : 0;

  // ── 叙述句 ──
  const rawSentences = narrative.split(/[。！？…]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const sLens = rawSentences.map((s) => s.length);
  const sentenceAvg = sLens.length > 0 ? sLens.reduce((a, b) => a + b, 0) / sLens.length : 0;
  const sentenceSd = sLens.length > 1
    ? Math.sqrt(sLens.reduce((a, b) => a + (b - sentenceAvg) ** 2, 0) / sLens.length)
    : 0;

  // ── 逗号段 ──
  const commaSegs = narrative.split(/[，,、；;：:]/).map((s) => s.replace(/[。！？…]/g, "").trim()).filter((s) => s.length > 0);
  const cLens = commaSegs.map((s) => s.length);
  const commaAvg = cLens.length > 0 ? cLens.reduce((a, b) => a + b, 0) / cLens.length : 0;

  // ── 逗号长句：含两个以上逗号的叙述句 ──
  const commaLong = rawSentences.filter((s) => (s.match(/[，,、；;]/g) ?? []).length >= 2);
  const commaLongRatio = rawSentences.length > 0 ? commaLong.length / rawSentences.length : 0;

  // ── 动作清单：同段内堆叠通用动作动词 + 逗号串联 ──
  // 用真源的动词表与双门槛（5 动词 且 4 分隔符），按段统计。
  // 我自创的「零虚词」代理在这里被换掉了，原因写在 ACTION_VERB_RE 的注释里。
  const actionList = [];
  for (const p of narrativeParas) {
    const verbs = p.match(ACTION_VERB_RE) ?? [];
    ACTION_VERB_RE.lastIndex = 0;   // /g 有状态，下一次 match 前必须复位
    if (verbs.length < ACTION_VERB_MIN) continue;
    const seps = (p.match(/[，、；;]/g) ?? []).length;
    if (seps < ACTION_SEP_MIN) continue;
    actionList.push({
      verbs: verbs.length,
      seps,
      text: p.length > 44 ? `${p.slice(0, 44)}…` : p,
      sample: verbs.slice(0, 6).join(" "),
    });
  }
  const actionListCount = actionList.length;
  const actionListWorst = actionList.reduce((a, b) => (b.verbs > (a?.verbs ?? -1) ? b : a), null);

  // ── 中长句占比（≥30 字的叙述句）──
  // 真源把它当作低连接密度的**必要条件**，不是可选项：
  // `check-ai-patterns.js:171` 写「单纯低功能词会误抓有大量中长句的文本；
  // 因此必须叠加"中长句不足"」。
  // 也就是说：长句多的稿子虚词少很正常——一个长句本来就能塞下好几个结构位置。
  const longSentences = rawSentences.filter((s) => s.length >= BASELINE.longSentence.chars);
  const longSentenceRatio = rawSentences.length > 0 ? longSentences.length / rawSentences.length : 0;

  // ── 碎句连排：连续 ≤5 字的叙述短句最长连排 ──
  let stutterRun = 0;
  let cur = 0;
  for (const n of sLens) {
    if (n <= 5) { cur += 1; stutterRun = Math.max(stutterRun, cur); } else { cur = 0; }
  }

  // ── 密度 ──
  const funcDensity = p1000((narrative.match(FUNC_RE) ?? []).length, narrativeChars);
  const connectiveDensity = p1000((narrative.match(CONNECTIVE_RE) ?? []).length, narrativeChars);
  const weakAdverbDensity = p1000((raw.match(WEAK_ADVERB_RE) ?? []).length, chars);

  // ── 标点 ──
  const dashCount = (raw.match(/——|—|--/g) ?? []).length;
  const ellipsisCount = (raw.match(/……|\.\.\./g) ?? []).length;

  // ── 套话 ──
  const bannedHits = [];
  for (const w of BANNED_WORDS) {
    const n = (raw.match(new RegExp(w, "g")) ?? []).length;
    if (n > 0) bannedHits.push({ word: w, count: n });
  }
  const clicheHits = [];
  for (const b of CLICHE_BUCKETS) {
    const n = (raw.match(b.re) ?? []).length;
    if (n > 0) clicheHits.push({ name: b.name, count: n });
  }
  const summaryHits = [];
  for (const w of SUMMARY_MARKERS) {
    const n = (raw.match(new RegExp(w, "g")) ?? []).length;
    if (n > 0) summaryHits.push({ word: w, count: n });
  }

  // ── 工程词泄漏 ──
  const engStrong = [];
  for (const w of ENGINEERING_STRONG) {
    const n = (raw.match(new RegExp(w, "gu")) ?? []).length;
    if (n > 0) engStrong.push({ word: w, count: n });
  }
  const engSoft = [];
  for (const w of ENGINEERING_SOFT) {
    const n = (raw.match(new RegExp(w, "gu")) ?? []).length;
    if (n > 0) engSoft.push({ word: w, count: n });
  }

  // ── 逐字复读：相邻两行一模一样，或同一句话全文出现三次以上 ──
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const strip = (s) => s.replace(/[「」『』“”"]/g, "").replace(/\s/g, "");
  let adjacentRepeat = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const a = strip(lines[i - 1]);
    const b = strip(lines[i]);
    if (a.length >= 8 && a === b) adjacentRepeat += 1;
  }
  const sentCounts = new Map();
  for (const s of rawSentences) {
    const k = strip(s);
    if (k.length >= 12) sentCounts.set(k, (sentCounts.get(k) ?? 0) + 1);
  }
  const repeatedSentences = [...sentCounts.values()].filter((n) => n >= 3).length;

  // ── 否定翻转句：「不是 A，而是 B」及其变体 ──
  const negativeFlip = (raw.match(NEGATIVE_FLIP_RE) ?? []).length;

  // ── 长段与截断 ──
  const longParagraphs = paras.filter((p) => p.replace(/\s/g, "").length > LONG_PARAGRAPH_CHARS).length;
  const tail = raw.replace(/\s+$/, "");
  const truncated = tail.length >= 80 && !TERMINAL_RE.test(tail);

  return {
    chars,
    narrativeChars,
    paragraphs: paras.length,
    narrativeParagraphs: narrativeParas.length,
    shortParagraphs: shortParas.length,
    shortParaRatio: narrativeParas.length > 0 ? shortParas.length / narrativeParas.length : 0,
    longParagraphs,
    paraAvg,
    paraSd,
    paraCv,
    actionListCount,
    actionListWorst,
    longSentenceRatio,

    dialogueCount: quotes.length,
    dialogueChars: dialogue.length,
    dialogueRatio: chars > 0 ? dialogue.length / chars : 0,
    dialogueParticles: (dialogue.match(DIALOGUE_PARTICLE_RE) ?? []).length,

    sentences: rawSentences.length,
    sentenceAvg,
    sentenceSd,
    commaSegments: commaSegs.length,
    commaAvg,
    commaLongRatio,
    stutterRun,

    funcDensity,
    connectiveDensity,
    weakAdverbDensity,

    dashCount,
    ellipsisCount,
    negativeFlip,

    bannedHits,
    clicheHits,
    summaryHits,
    bannedTotal: bannedHits.reduce((a, h) => a + h.count, 0),
    clicheTotal: clicheHits.reduce((a, h) => a + h.count, 0),
    summaryTotal: summaryHits.reduce((a, h) => a + h.count, 0),

    engineeringStrong: engStrong,
    engineeringSoft: engSoft,
    engineeringTotal: engStrong.reduce((a, h) => a + h.count, 0),
    adjacentRepeat,
    repeatedSentences,
    truncated,
  };
}

/** 统计信号的口径说明。每条发现项都带着它——信号不是判决。 */
export const SIGNAL_CAVEAT =
  "这是统计信号，不是判决：真人写的冷硬文体也可能落在基线外。" +
  "读一遍再决定改不改；不要为了凑数字注水，也不要为了凑对白比例硬加台词。";

const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const pct = (x) => `${f1(x * 100)}%`;

/**
 * 把量出来的数变成发现项。
 *
 * 严重度只到 s3/s4：这些都是**表达层**问题，不是事实矛盾。
 * s3 会进质量债台账并触发一次改稿，但不会把导演链拦住——
 * 「AI 味重」不该跟「人物崩坏」抢同一个阻断级别。
 */
export function proseFindings(m, { dialogueFloor = BASELINE.dialogueRatio.floor } = {}) {
  const out = [];
  const add = (id, severity, name, note) => out.push({ id, severity, name, note });

  if (!m || m.chars < BASELINE.minCharsToJudge) return out;

  // ── 电报体：虚词被扫光 + 长句太少。这是最要命的一条，也是 v8 的真实病因。 ──
  const telegram = m.commaLongRatio < BASELINE.commaLongRatio.floor && m.funcDensity < BASELINE.funcDensity.floor;
  if (telegram) {
    add("telegram", "s3", "电报体（过度压缩）",
      `逗号长句只占叙述句 ${pct(m.commaLongRatio)}（真人 ${pct(BASELINE.commaLongRatio.lo)}–${pct(BASELINE.commaLongRatio.hi)}），` +
      `虚词密度 ${f1(m.funcDensity)}/千字（真人 ≥${BASELINE.funcDensity.floor}）。` +
      "结构虚词被扫光、句子全压到最短，读起来像提纲而不是正文。" +
      "把非峰值处恢复成自然白话，该有的「了/的/就/着/的时候」留着。" +
      SIGNAL_CAVEAT);
  } else if (m.commaLongRatio < BASELINE.commaLongRatio.floor) {
    add("choppy", "s3", "句子偏碎",
      `逗号长句占叙述句 ${pct(m.commaLongRatio)}，低于真人基线 ${pct(BASELINE.commaLongRatio.lo)}–${pct(BASELINE.commaLongRatio.hi)}。` +
      "叙述默认该用逗号长句串两到四个动作，现在短句太多。" + SIGNAL_CAVEAT);
  } else if (m.funcDensity < BASELINE.funcDensity.floor && m.longSentenceRatio < BASELINE.longSentence.ratioFloor) {
    // 两个条件必须同时成立。只判虚词密度会误抓「长句多、结构位置本来就被长句吃掉」
    // 的合法稿子——真源为此专门加了中长句占比这个必要条件（check-ai-patterns.js:171）。
    add("sparse-function-words", "s3", "虚词过稀",
      `虚词密度 ${f1(m.funcDensity)}/千字，低于真人基线 ${BASELINE.funcDensity.floor}。` +
      "不是每个动作都要补一个「了一下」，但结构虚词被扫光会读成提纲。" +
      // 光说「虚词太少」没用：改稿者会去补几个「了」，数字动一点，读感不变。
      // 真正管用的改法是 oh-story 那条「动作串分主次、带虚词」——
      // 一句里超过三个动作，用「就/才/又/便/却/倒/还/再/先……才」接出先后与因果。
      "改的时候别去给动词加后缀，去把动作串接起来：" +
      "「收了录音机，擦了手，把信封按在他手里」是逗号清单；" +
      "「先把录音机收进里屋，出来时在围裙上擦了擦手，这才把信封按进他手里」才是接起来了。" + SIGNAL_CAVEAT);
  }

  if (m.sentenceAvg > 0 && m.sentenceAvg < BASELINE.sentence.floor) {
    add("short-sentences", "s3", "整句偏短",
      `整句均长 ${f1(m.sentenceAvg)} 字，低于真人基线 ${BASELINE.sentence.lo}–${BASELINE.sentence.hi}（低于 ${BASELINE.sentence.floor} 判过短）。` +
      SIGNAL_CAVEAT);
  }

  if (m.commaAvg > BASELINE.commaSeg.hi) {
    add("long-comma-segments", "s3", "逗号之间偏长",
      `逗号之间均长 ${f1(m.commaAvg)} 字，高于要求区间 ${BASELINE.commaSeg.lo}–${BASELINE.commaSeg.hi} 字` +
      `（真人实测中心 ${BASELINE.commaSeg.measured}）。` +
      "逗号太少、一口气太长，读起来会喘不上。" + SIGNAL_CAVEAT);
  } else if (m.commaAvg > 0 && m.commaAvg < BASELINE.commaSeg.lo) {
    add("short-comma-segments", "s3", "逗号之间偏短",
      `逗号之间均长 ${f1(m.commaAvg)} 字，低于要求区间 ${BASELINE.commaSeg.lo}–${BASELINE.commaSeg.hi} 字。` +
      SIGNAL_CAVEAT);
  }

  if (m.stutterRun >= BASELINE.stutterRun.ceiling) {
    add("period-stutter", "s3", "碎句号",
      `连续 ${m.stutterRun} 个五字以内的叙述短句。把碎句合并成中长句。` + SIGNAL_CAVEAT);
  }

  // 平均用力：段落长度均匀到不像人写的。
  //
  // 阈值 0.12 是校准出来的，不是拍的：手写的一段「每段三句、长度接近」的反样本 CV=0.010，
  // 而手写的参差正样本 CV=0.321、十个真实草稿全在 0.52–0.87。也就是说这条判据
  // **认得出病态的均匀，但真实草稿离它很远**——它是烟雾报警器，不是文风门禁。
  // 之所以还是留着：oh-story 把「每个情节点一样长、一样细」列为 AI 腔的根源，
  // 而这种形状一旦出现就是全篇性的、肉眼反而容易看顺眼。宁可它在真出事的候响一次。
  if (m.narrativeParagraphs >= BASELINE.minParagraphsToJudge && m.paraCv < BASELINE.paraCv.floor) {
    add("uniform-paragraphs", "s3", "段落长度过于均匀（平均用力）",
      `${m.narrativeParagraphs} 个叙述段的长度几乎一样（均长 ${f1(m.paraAvg)} 字，变异系数 ${m.paraCv.toFixed(3)}）。` +
      "这是「按细纲机械扩写」的典型形状：每个情节点分到一样多的笔墨。" +
      "按情节权重分配——该详的写足，过场坚决压缩；同类并列项要递减，第一个写足、第二个减半、后面一句带过。" + SIGNAL_CAVEAT);
  }

  if (m.shortParaRatio > BASELINE.shortParaRatio.ceiling) {
    add("overcompressed-paragraphs", "s3", "短段过多（提纲感）",
      `十五字以内的叙述段占 ${pct(m.shortParaRatio)}，高于 ${pct(BASELINE.shortParaRatio.ceiling)}。` + SIGNAL_CAVEAT);
  }

  if (m.weakAdverbDensity > BASELINE.weakAdverb.ceiling) {
    add("weak-adverbs", "s4", "弱化副词超量",
      `弱化副词密度 ${f1(m.weakAdverbDensity)}/千字，高于 ${BASELINE.weakAdverb.ceiling}。` +
      "「缓缓/微微/轻轻/淡淡」是模型的签名式修饰，删掉或用具体动作替代。");
  }

  if (m.dialogueRatio < dialogueFloor) {
    add("low-dialogue", "s3", "对话占比过低",
      `对话占全文 ${pct(m.dialogueRatio)}，低于 ${pct(dialogueFloor)}（网文典型 ${pct(BASELINE.dialogueRatio.lo)}–${pct(BASELINE.dialogueRatio.hi)}）。` +
      "场景里明明有人，话却全被叙述概括掉了。不是要你硬加台词，是问一句：" +
      "这场里两个人真的只会说那么几个字吗？" + SIGNAL_CAVEAT);
  }

  // 对白有量、没气口。这一条单独列，是因为它跟「对话太少」是两种病：
  // 话够多了，但每句都短得像口令，人物之间没有口气来往。
  // 判据来自 oh-story 的「对话带口气」：全章对话不能一个语气词都没有。
  if (m.dialogueCount >= 8 && m.dialogueParticles === 0) {
    add("dialogue-flat", "s4", "对白没有口气",
      `${m.dialogueCount} 句对白里一个语气词都没有（吧/呢/啊/嘛/哎/呀）。` +
      "按身份、年纪、地方给每个人配一两个，别通篇都是「不饿。」「没湿。」这种口令式应答。" +
      "这一条是硬性下限，不是风格偏好。" + SIGNAL_CAVEAT);
  }

  if (m.dashCount > 0) {
    add("em-dash", "s4", "破折号",
      `正文出现 ${m.dashCount} 处破折号。打断→动作或短句，拖长音→省略或动作，插入说明→逗号或冒号。`);
  }

  if (m.negativeFlip > 0) {
    add("negative-flip", "s4", "否定翻转句",
      `「不是 A，而是 B」这类句式出现 ${m.negativeFlip} 处。直接写 B，或者写 A 之后发生了什么。`);
  }

  // 工程词泄漏：正文里出现只有作者和流程才该看见的词。
  // 这一类真出过事——第 1 章 v4 把「〔未处置〕」说明写进了正文，v5 把「〔说明〕」写进了正文。
  // 那两次靠的是专门写的摘除逻辑，而摘除逻辑只在模型恰好用那个记号时有效。这一层与记号无关。
  if (m.engineeringTotal > 0) {
    add("engineering-leak", "s2", "工程词泄漏进正文",
      `正文里出现了流程词汇：${m.engineeringStrong.map((h) => `${h.word}×${h.count}`).join("、")}。` +
      "这些词只属于作者与流程，读者不该看见一个字。整句删掉或改写成正文里真实发生的事。");
  } else if (m.engineeringSoft.length >= 2) {
    add("engineering-leak-soft", "s4", "疑似流程口吻",
      `正文里出现 ${m.engineeringSoft.map((h) => `${h.word}×${h.count}`).join("、")}。` +
      "如果这是人物口中真的会说的话就留着；如果是叙述在替作者交代，删掉。");
  }

  if (m.adjacentRepeat > 0 || m.repeatedSentences > 0) {
    add("verbatim-repeat", "s3", "逐字复读",
      `${m.adjacentRepeat > 0 ? `相邻两行一模一样的有 ${m.adjacentRepeat} 处；` : ""}` +
      `${m.repeatedSentences > 0 ? `同一句话全文出现三次以上的有 ${m.repeatedSentences} 句。` : ""}` +
      "复读不是强调，是模型在原地打转。");
  }

  if (m.longParagraphs > 0) {
    add("long-paragraph", "s4", "长段",
      `有 ${m.longParagraphs} 段超过 ${LONG_PARAGRAPH_CHARS} 字。要么按戏剧单元断开，要么砍掉不承担功能的句子。`);
  }

  if (m.truncated) {
    add("truncated", "s2", "正文疑似截断",
      "正文没有以句末标点收尾，看起来是写到一半断了。这不是风格问题，是这一稿没写完。");
  }

  if (m.bannedTotal > 0) {
    add("banned-words", "s4", "一级禁用词",
      `命中 ${m.bannedTotal} 处：${m.bannedHits.map((h) => `${h.word}×${h.count}`).join("、")}。` +
      "换成具体动作或细节，不要换成另一个同类形容词。");
  }

  if (m.clicheTotal >= 8) {    add("cliche-density", "s4", "套词密度偏高",
      `高危套词 ${m.clicheTotal} 处（${m.clicheHits.map((h) => `${h.name}×${h.count}`).join("、")}）。` +
      "不要同义词轮换，改成角色当下可见的动作、物件、对话和具体后果。");
  }

  // 摘要总结句：门槛 3 处，理由取自真源的注释——「单个词可能服务题材，高密度聚集才报」。
  // 我原来写的是 > 0，等于「只出现一次就要改」，那是在逼作者把合法的题材用语也删掉。
  if (m.summaryTotal >= 3) {
    add("summary-markers", "s4", "总结句标志",
      `命中 ${m.summaryHits.map((h) => `${h.word}×${h.count}`).join("、")}。把已经演出来的意思又讲了一遍，删掉。`);
  }

  // 动作清单。判据与动词表来自 oh-story（MIT）。真源把它定为 advisory，
  // 理由是打斗/追逐的功能性动作编排本来就该是步骤表。
  //
  // 它在我全部 11 个样本（含 v8 基线）上一处都没响——这不是判据失效，
  // 是这批稿子确实没有这种病。所以它的正样本只能靠测试里的构造稿来证明，
  // 见 test/prose.test.mjs 的「动作清单」。没验证过会响的判据不该留在库里。
  if (m.actionListCount > 0) {
    add("action-list", "s3", "监控摄像头式动作清单",
      `有 ${m.actionListCount} 段在堆通用动作动词（最重的一段 ${m.actionListWorst.verbs} 个动词、` +
      `${m.actionListWorst.seps} 个分隔符：${m.actionListWorst.text}）。` +
      "读感像无视角温度的监控记录。合并琐碎步骤，只保留有情绪或情节功能的动作；" +
      "必要时用角色的犹豫、误判或环境反馈做缓冲。" + SIGNAL_CAVEAT);
  }

  return out;
}

/** 一行一条的体检报告，给审读/改稿子代理和作者看。 */
export function renderProseMetrics(m) {
  if (!m || m.chars === 0) return "（没有正文，量不了。）";
  const mark = (ok) => (ok ? "✅" : "⚠");
  const lines = [
    `${m.chars} 字｜段 ${m.paragraphs}（叙述段 ${m.narrativeParagraphs}）｜叙述句 ${m.sentences}`,
    `对话占比 ${pct(m.dialogueRatio)} ${mark(m.dialogueRatio >= BASELINE.dialogueRatio.floor)}（真人 ${pct(BASELINE.dialogueRatio.lo)}–${pct(BASELINE.dialogueRatio.hi)}）`,
    `对白口气 ${m.dialogueParticles} 处 ${mark(m.dialogueParticles > 0 || m.dialogueCount < 8)}（吧/呢/啊/嘛/哎；${m.dialogueCount} 句对白里一个都没有就判没口气）`,
    `整句均长 ${f1(m.sentenceAvg)} 字 ${mark(m.sentenceAvg >= BASELINE.sentence.floor)}（真人 ${BASELINE.sentence.lo}–${BASELINE.sentence.hi}）｜长度标准差 ${f1(m.sentenceSd)}`,
    `逗号间均长 ${f1(m.commaAvg)} 字 ${mark(m.commaAvg >= BASELINE.commaSeg.lo && m.commaAvg <= BASELINE.commaSeg.hi)}（要求 ${BASELINE.commaSeg.lo}–${BASELINE.commaSeg.hi} 字，实测中心 ${BASELINE.commaSeg.measured}）`,
    `逗号长句占比 ${pct(m.commaLongRatio)} ${mark(m.commaLongRatio >= BASELINE.commaLongRatio.floor)}（真人 ${pct(BASELINE.commaLongRatio.lo)}–${pct(BASELINE.commaLongRatio.hi)}）`,
    `虚词密度 ${f1(m.funcDensity)}/千字 ${mark(m.funcDensity >= BASELINE.funcDensity.floor)}（真人 ≥${BASELINE.funcDensity.floor}）`,
    `中长句占比 ${pct(m.longSentenceRatio)} ${mark(m.longSentenceRatio >= BASELINE.longSentence.ratioFloor)}（≥${BASELINE.longSentence.chars} 字的叙述句；低连接密度要它同时不足才判）`,
    `功能词密度 ${f1(m.connectiveDensity)}/千字 ${mark(m.connectiveDensity >= BASELINE.connectiveDensity.floor)}（真人 ≥${BASELINE.connectiveDensity.floor}）`,
    `弱化副词 ${f1(m.weakAdverbDensity)}/千字 ${mark(m.weakAdverbDensity <= BASELINE.weakAdverb.ceiling)}（上限 ${BASELINE.weakAdverb.ceiling}）`,
    `≤15字短段占比 ${pct(m.shortParaRatio)} ${mark(m.shortParaRatio <= BASELINE.shortParaRatio.ceiling)}（上限 ${pct(BASELINE.shortParaRatio.ceiling)}）`,
    `叙述段长离散 ${m.paraCv.toFixed(3)} ${mark(m.paraCv >= BASELINE.paraCv.floor)}（越接近 0 越像平均用力；下限 ${BASELINE.paraCv.floor}）`,
    `碎句最长连排 ${m.stutterRun} 句 ${mark(m.stutterRun < BASELINE.stutterRun.ceiling)}（上限 ${BASELINE.stutterRun.ceiling - 1}）`,
    `破折号 ${m.dashCount} ${mark(m.dashCount === 0)}｜省略号 ${m.ellipsisCount}｜禁用词 ${m.bannedTotal}｜套词 ${m.clicheTotal}｜总结句 ${m.summaryTotal}｜动作清单段 ${m.actionListCount}`,
  ];
  return lines.join("\n");
}

/**
 * 差得远的项——**句子形状**层面的，不是瑕疵层面的。
 *
 * ## 为什么要单独拎出来
 *
 * 真机上第 1 章连改 8 轮，发现项从 16 条降到 3 条、s1/s2 连续四轮为 0，
 * 而句子形状分毫未动：
 *
 * | | v1 | v8 | 真人基线 |
 * |---|---|---|---|
 * | 逗号长句占比 | 39.0% | 42.0% | 74–80% |
 * | 虚词密度 | 68.5 | 65.4 | ≥85 |
 * | 对话占比 | 2.6% | 3.0% | 40–60% |
 *
 * 原因不是审读不力，是**改稿那一步的措辞**：它写着「改稿时*顺手*把落在
 * 基线外的项拉回来」，而「顺手」等于告诉模型这是次要的；紧接着又是两条
 * 「别为了凑数字动手」的禁令。模型于是只修发现项，形状一动不动——
 * 连续八轮，每轮都「改完了」。
 *
 * ## 判据：噪声 / 明显偏低 / 换了个架构
 *
 * 仓里一直守的纪律是**阈值只用来选样，不用来判分**，而
 * `references/workflow-chapter.md` 第 28 行的处置本来就是分级的：
 * `needs_decision` 才问作者，其余自己收口。
 *
 * 这里换成**离基线的相对距离**，三段：
 *
 * - `> -20%`：真人语料的组内浮动，**不许动**。
 * - `-20% ~ -50%`：明显偏低，是这一版该修的。
 * - `<= -50%`：不是偏，是**另一种句法架构**，本轮的结构活就是它。
 *
 * 三段的分界来自实测。11 份真人样本在同一指标上的组内极差都在 10–18%，
 * 所以 0.20 已在样本噪声之外。另一头：真机上 v8 的四项分别是
 * 对话 3.0%（-94%）、逗号长句 42.0%（-45.5%）、整句均长 16.2 字（-29.6%）、
 * 虚词密度 65.4（-23.1%）——**四项全部超出噪声**，而只有第一项超过 50%。
 *
 * 所以原来那个「只有 >=50% 才叫 far、20–50% 归为可以不管」的分法是错的：
 * 逗号长句 42% 对真人 74–80% 就是另一种句子架构（大部分句子内部没有逗号串起
 * 多个动作），把它归进「可以不管」等于放着一个已确诊的问题不管。
 * 改成三段之后，四项全部进「本轮该修」，只有语气轻重不同。
 *
 * ## 为什么只给改稿用
 *
 * 起草靠身份层的正向要求（写作纪律那节），审读靠发现项去抓；只有**改稿**
 * 是把一份已成型的文字往基线上拉，这时才需要「这几项离得远、这一轮的
 * 结构活就是它们」的判断。审读拿到它会变成判分，正违反「不判分」那条。
 *
 * ## 对话占比不在这里（实测踩过）
 *
 * 我第一版把对话占比也放了进来。它在 v8 上算出来是 -94%，于是被标成
 * 〔换架构〕、排在清单第一条——而改稿子代理交回时写着「无法执行」：
 * 本章〔硬〕只允许一个有面孔的人、〔软〕对白要点已逐条指定、〔硬〕不许
 * 任何人解释或察觉异常，把 50% 硬堆成寒暄会直接违反这三条。
 *
 * 随后两个独立的审读子代理都判它「已核对，不算问题」，理由一致：这一章
 * 的戏剧核心就是「话不能被复述」，契约明写逼主角用行动而不是语言传递信息，
 * 对白天然该少。
 *
 * 所以问题不在数字，在**归类**：这一项不是句子架构，是场景构成的取舍，
 * 而场景构成归细纲与契约管。剩下三项（逗号长句占比、整句均长、虚词密度）
 * 都在问同一件事——**一个句子是怎么搭起来的**，那才是「结构活」。
 *
 * 撤出不等于丢掉信号：它仍然在 renderProseMetrics 与 proseFindings 里，
 * 那两条路都允许附带免责口径、由审读者表态。**只有 proseGaps 会把一个指标
 * 变成强制指令**，而对话比例不该被这样对待——真偏低的稿子照样会被
 * proseFindings 抓成一条 low-dialogue 候选，由审读者裁决。
 */
export function proseGaps(m) {
  if (!m || m.chars === 0) return [];
  const B = BASELINE;
  const items = [
    {
      name: "逗号长句占比",
      actual: m.commaLongRatio,
      target: (B.commaLongRatio.lo + B.commaLongRatio.hi) / 2,
      fmt: (v) => pct(v),
      how: "把两到三个动作写进一句，用逗号串起来，中间用「着」「了」「就」「才」连出先后；别写成动作清单。",
    },
    {
      name: "整句均长",
      actual: m.sentenceAvg,
      target: (B.sentence.lo + B.sentence.hi) / 2,
      fmt: (v) => `${f1(v)} 字`,
      how: "一句里多铺一点：把两个短句并进一句，或把一个动作的来龙去脉写全。",
    },
    {
      name: "虚词密度",
      actual: m.funcDensity,
      target: B.funcDensity.floor,
      fmt: (v) => `${f1(v)}/千字`,
      how: "把「他拿起碗」「他推开门」这种硬动词短语铺开：「他伸手把碗从桌上拿起来」「他用肩膀把门推开一条缝」。",
    },
    // 对话占比**故意不在这里**。它是场景构成的取舍，不是句子架构，
    // 而场景构成归细纲与契约管——详见文件头那段「对话占比不在这里」。
    // 真偏低的稿子由 proseFindings 报成候选，交审读者裁决。
  ];

  const out = [];
  for (const it of items) {
    if (!Number.isFinite(it.actual) || !Number.isFinite(it.target) || it.target === 0) continue;
    // 只管「偏低」这一侧。偏高不作为结构问题：这几项偏高的形态
    // （一句套一句的长链、虚词灌水）另有检测，不靠这里。
    if (it.actual >= it.target) continue;
    const rel = (it.actual - it.target) / it.target;
    if (rel > -0.20) continue; // 组内浮动，不动
    out.push({
      name: it.name,
      actual: it.actual,
      target: it.target,
      rel,
      far: rel <= -0.50,
      actualText: it.fmt(it.actual),
      targetText: it.fmt(it.target),
      how: it.how,
    });
  }
  out.sort((a, b) => a.rel - b.rel); // 差得远的排前面
  return out;
}

/**
 * 把 proseGaps 渲染成改稿者能直接照做的结构活。
 *
 * 措辞是这里最要紧的部分。原来那句「顺手把落在基线外的项拉回来」
 * 事实上把这件事降级成了附赠——八轮改稿形状不动，源头就在这里。
 * 现在写成**本轮的结构活**，并把「怎么改」与「别怎么作弊」分开写：
 * 前者给正面做法，后者只禁明显作弊的做法。
 */
export function renderProseGaps(m) {
  const gaps = proseGaps(m);
  if (gaps.length === 0) return "";
  const far = gaps.filter((g) => g.far);
  const lines = [];

  lines.push("## 本轮的结构活（这一版的主要任务，不只是顺手）");
  lines.push("");
  if (far.length > 0) {
    const listed = far.map((g) => g.name).join("、");
    lines.push(`其中 **${listed}** 离真人语料不是一个量级——差的不是措辞，是句子架构。`);
    lines.push("");
  }
  lines.push("下面每一项都超出了真人语料的浮动范围，**逐项改到基线内**：");
  lines.push("");
  for (const g of gaps) {
    // 超出一半的标出来：那几项要重写句子，不是润色。
    const tag = g.far ? "〔换架构〕" : "";
    lines.push(`- **${g.name}**${tag} ${g.actualText} → 目标 ${g.targetText}（偏 ${(g.rel * 100).toFixed(0)}%）`);
    lines.push(`  怎么改：${g.how}`);
  }
  lines.push("");
  lines.push("改的时候守住这几条，别用作弊的方式凑数：");
  lines.push("");
  lines.push("- 不要把本来该短的地方拉长。章尾收束、台词、拟声该短就短，要长的是叙述句。");
  // 这一条是实机踩出来的。体检表里**仍然有**对话占比那一行（它归 proseFindings
  // 与审读者管），而这一节故意不提它。写手看到表里有、清单里没有，很可能
  // 自己脑补出「要把对话拉到 50%」——第 1 章就是这么翻的车：改稿子代理交回时
  // 写「无法执行」，因为本章〔硬〕只允许一个有面孔的人、〔硬〕不许任何人解释
  // 或察觉异常，硬堆对白会直接违反细纲。所以这里把话说明白。
  lines.push("- 对话占比那项**不在这一节里**，别自己去凑。这一章该说多少话是场景构成的取舍，归细纲与契约管；"
    + "体检表里那个数字你看见了，不要为了它硬加寒暄。");
  lines.push("- 不要把一句拆成三句再补虚词。虚词是连出来的，不是塞进去的——「着/了/就/才」要接出真实的先后与因果。");
  lines.push("- 细纲〔硬〕约束优先于这一节。约束不许动的地方，形状让着它走，在允许的地方补。");
  lines.push("");
  lines.push("改完之后自己回头读一遍：读起来是不是更像一个中文作者写的，而不是像一组统计指标。");
  lines.push("指标是路标，不是目的地。");

  return lines.join("\n");
}

/**
 * 逐条的免责口径。
 *
 * 参考项目里反复出现同一个取向：**误报代价高于漏报**。Scriptor 在源码注释里写
 * `a false positive (forcing a rewrite of good prose) costs more than missing this
 * rarer form`，并因此主动放弃检测 `，他是` 那类翻转句。
 *
 * 他们的做法是**每条数字后面紧贴一条反例**，而不是在文件开头统一声明一次：
 *   「5~15 处」之后紧跟「偶发且贴合人设的「感到」合法」
 *   「1.5/百字」之后紧跟「偏低只说明叙述偏重」
 *
 * 我原来只有节标题上一次统一声明。统一声明的问题是：审读者读到第 7 条时，
 * 早就忘了第 1 条的口头豁免。所以改成每条自带一条「什么时候不算」。
 */
const CAVEAT = {
  telegram: "刻意的冷硬文体、急促的追逐戏可能合法；只有通篇都这样才叫电报体。",
  choppy: "冲突顶点附近的短句是有意为之；整章都碎才是问题。",
  "sparse-function-words": "同样，不要求每个动作都补「了一下」，看的是通篇走向。",
  "short-sentences": "章尾收束、台词、拟声都可以合法偏短；叙述句整体偏短才是问题。",
  "low-dialogue": "气氛压迫的独白章、重氛围的过场章偏低是正常的。",
  "dialogue-flat": "极简冷硬风格可以全程不用语气词，但要确认这是选择而不是没想起来。",
  "uniform-paragraphs": "实验性排版、刻意对称的结构会合法地均匀；要看的是你知不知道自己在这么做。",
  "action-list": "打斗、追逐这类功能性动作编排可以保留——那些步骤本身就是内容。",
  "period-stutter": "章尾连着几个短句砸下去是有意的；中段也这样就碎了。",
  "overcompressed-paragraphs": "追逐、打斗、倒计时场景的短段是有功能性的；通篇如此才是提纲。",
};
export function renderProseCandidates(m, { max = 8 } = {}) {
  const list = proseFindings(m);
  if (list.length === 0) {
    return [
      "## 机器候选发现项",
      "",
      "机器没报出可疑项。**这不等于没问题**——它只查得到它自己查的那几样。",
    ].join("\n");
  }

  const order = { s1: 0, s2: 1, s3: 2, s4: 3 };
  const sorted = [...list].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  const lines = [
    "## 机器候选发现项（每一条你都得表态，不许整条略过）",
    "",
    "先看一句总的：**这些是数字，不是判决。** 误报的代价高于漏报——",
    "为了一个数字去改一段本来写得对的正文，代价比放过一处真实问题更大。所以每条后面都跟着一句「什么时候不算」。",
    "",
  ];
  for (const f of sorted.slice(0, max)) {
    // 免责口径逐条给，不在节标题统一给一次：读到第 7 条时，
    // 读者早就忘了第 1 条的口头豁免。节标题里那一句只留总纲。
    const brief = String(f.note).split(SIGNAL_CAVEAT)[0].replace(/不要为了凑数字注水[^。]*。/g, "").trim();
    lines.push(`- [${f.severity}] **${f.name}**（${f.id}）：${brief}`);
    if (CAVEAT[f.id]) lines.push(`  ↳ 什么时候不算：${CAVEAT[f.id]}`);
  }
  if (sorted.length > max) {
    lines.push(`- 另有 ${sorted.length - max} 条较轻的项没列出来。`);
  }
  return lines.join("\n");
}

/**
 * 写作纪律 —— 进起草与改稿提示词的那一段。
 *
 * 为什么是**正向要求**而不是一张禁用清单：第 1 章 v8 那稿的禁用词命中是 0，
 * 套词命中是 0，弱化副词命中是 0——它一条禁令都没违反，而它仍然是机器味。
 * 因为它的病不是「写了不该写的」，是「该写的没写」：句子太短、对白太少、
 * 感官只开了视觉一路、每个细纲单元被机械扩成同一种结构。
 *
 * 所以这里给的是**该写成什么样**，配着可核查的数字。
 * 参考了 Scriptor 的「本章创作准则」、oh-story 的 22 条机器判据与真实语料基线、
 * 以及 Biz Novel Studio 的角色向要求；文字是重写的，没有照抄任何一家的原文。
 */
export function renderProseSpec({ genre = "", styleBrief = "" } = {}) {
  const out = [];
  out.push("## 写作纪律");
  out.push("");
  out.push("下面每一条都拿真实中文网文语料校准过，是可核查的要求，不是风格偏好。");
  out.push("它们和上面的材料同等重要——材料决定你写什么，这一节决定你写成什么样。");
  out.push("");

  out.push("### 一、句子长度（最容易写坏的地方）");
  // 这一节原先通篇是数字（整句 20–30 字、逗号之间 8–12 字、七成以上含两个逗号）。
  // 现在保留了「逗号长句」这个说法和 8–12 字这个手感，但不再当配额发——
  // 理由见下面「对照」段上方的注释。
  out.push("- 叙述默认写**逗号长句**：一句里用逗号串两到四个动作。");
  out.push("- 不要通篇一个句长。长句铺陈，短句砸重点——长短必须交替。");
  out.push("- **一句话里超过三个动作，要用虚词接出先后和因果，不能写成逗号清单。**");
  out.push("  可用的虚词：「就、才、又、便、却、倒、还、再、先……才」。");
  out.push("");
  out.push("只把句号换成逗号是不够的——逗号清单只是把短句黏起来，读起来还是清单：");
  out.push("  逗号清单：「舅妈收了录音机，擦了手，把信封按在他手里。」");
  out.push("  接起来了：「舅妈先把录音机收进里屋，出来时顺手在围裙上擦了擦手，这才把信封按进他手里。」");
  out.push("  两个「先」「这才」把先后和主次说了出来——这就是全章都该有的东西。");
  out.push("");
  // 数字该不该给写作者，这一节改过。原来这里写的是「结构虚词每千字低于 85 个，
  // 就判『过度精炼』」——把检测器的阈值当指令发给了写作者。
  //
  // 三个参考项目在这点上一致：给写作者的指令里**不塞数字**
  // （oh-story 写的是「不自测字数句长」；B14-3 讲「而非把 0.85 直接扔给模型」；
  // B15-2 讲喂给模型的规则目录由代码逐字生成，不含阈值）。数字只活在检测器里，
  // 而检测器是给**审读者**看的。
  //
  // 我当时的推断是：写作者拿到数字就会去凑数，凑出来的正是 B 组那种
  // 「逗号长句 66.7% 达标而虚词 71.7 不动」。据此预测去掉数字应当
  // 逗号长句降、虚词升。
  //
  // **这个预测被证伪了。** 去掉数字那一臂（n=3）：逗号长句 53.7%→50.7%（降了，
  // 符合预测），但虚词 76.0→72.7 也降了（预测是升），整句 22.5→20.3 更差。
  // 四项里只有对话占比明显改善（19.1%→28.4%）。
  //
  // 所以这一处改动**目前只有原则上的依据，没有实测收益**，而那一臂 n=3
  // 且是在人物名修复之前跑的，混杂没排除。留着是因为三条参考口径一致、
  // 且「写作者照阈值凑数」这件事本身在 B 组身上看得见；
  // 但不能拿它当「已经改好了」的证据。要下结论得先排掉混杂、把 n 做上去。
  out.push("对照——同样的动作序列、同样的信息量，只差逗号的位置：");
  out.push("");
  out.push("反面（把句子切碎，读起来像清单）：");
  out.push("  他抬手。开门。进屋。坐下。桌上有张纸。他拿起来。看了一眼。放下。");
  out.push("");
  out.push("正面（动作接成一条线）：");
  out.push("  他抬手把门推开，进屋先站在门口听了一下雨，才走到桌边坐下。桌上摊着一张纸，");
  out.push("  他拿起来对着灯看了一眼，又照原样放回去，指腹在折痕上按了一下。");
  out.push("");
  out.push("短句是拿句号把动作一个个切开，长句是用逗号把动作串成一条线。网文默认是后者。");
  out.push("该短的地方是**砸重点**，不是**省字数**。");
  out.push("");

  out.push("### 二、不要写成电报体");
  out.push("- 「他抬手，开门，进屋，坐下。」这种把结构虚词全扫光的写法，是最典型的机器味。");
  out.push("- 该有的「了、的、就、着、的时候」要留着。不是每个动作都补一个「了一下」，但也不能全删。");
  out.push("- **「只写动作、不写内心」不等于「写成短句流水账」**——动作照样要用逗号长句写足。");
  out.push("");

  out.push("### 三、对白");
  out.push("- 对白是正文的主干，通常占全章四到六成。低于三成，说明你把该说的话概括掉了。");
  out.push("- 每个人的说话方式必须能被区分：句长、口头语、省略习惯、抢不抢话、爱不爱把话说完。");
  out.push("- 禁止「A 说→B 说→A 说→B 说」严格交替，禁止每句都完整回应上一句。");
  out.push("- 允许抢话、沉默、答非所问、说到一半停住。人说话不是做报告。");
  out.push("- 说话标签（「他说」「他淡淡道」）不超过对白的三成，多用动作把话引出来。");
  out.push("- **对白要带口气**：按身份、年纪、地方带「吧、呢、啊、嘛、哎、呀」这类语气词。");
  out.push("  **全章对白不能一个语气词都没有。** 把「不饿。」「没湿。」「不行。」排成一路，");
  out.push("  读起来不是冷硬，是屋里没人在说话。");
  out.push("");

  out.push("### 四、感官与具体");
  out.push("- 一个场景至少开三路感官。嗅觉、温度、声音的质地、光的质量都算。只写视觉和手感不算。");
  out.push("- 抽象判断必须落成动作、物件或代价。不写「他心里很乱」，写他做了哪件乱的事。");
  out.push("- 每场至少一处**只有这个人会做的具体动作**。不是「他停了一下」，是「他用指甲把鞋跟上的泥抠掉」。");
  out.push("- 细节要属于这个人物、这个地方、这个时刻；换个主角也成立的细节就是没写。");
  out.push("");

  out.push("### 五、段落与节奏");
  out.push("- 段落长短必须交错：有的一段一句话，有的一段十几句。禁止每段都是三到五句、长度均匀。");
  out.push("- 紧张处句子变短变碎；平缓处可以有长段铺陈。全章一个速度就是匀速叙事。");
  out.push("- **单独成行的短句只留给章尾、反转、情绪峰值。** 盘算、过渡、交代要写成连贯的长句。");
  out.push("- **不要把每个细纲单元机械扩成同一种结构**。细纲说的是这一段要发生什么，不是要写几段、每段多长。");
  out.push("");

  out.push("### 六、明确不要");
  out.push("- 破折号「——」。打断用动作或短句，拖长音用省略或动作，插入说明用逗号或冒号。");
  out.push("- 「不是 A，而是 B」及其变体。直接写 B。");
  out.push("- 段末总结句：「他终于明白了」「这意味着」「原来如此」「值得一提的是」。");
  out.push("- 直接命名情绪：「他感到愤怒」「心中一暖」「心头一震」。");
  out.push("- 万能形容词与万能副词：「莫名的」「淡淡的」「缓缓」「微微」「轻轻」。");
  out.push("- 解释腔：叙述者跳出来解释因果、预告后面要发生什么、替读者给人物定性。");
  out.push("- 章末升华、总结、预告。结尾停在一个具体动作、一个画面或一句台词上。");
  out.push("- 任何流程词汇：「细纲」「情节点」「伏笔」「本章」「任务」「发现项」——读者不该看见一个字。");
  out.push("- 相邻两行一模一样，或同一句话反复出现三次以上。复读不是强调。");
  out.push("");

  // 正向清单。这是最容易被忽略的一半：一份全是禁令的规则表，
  // 会让模型把「不许写什么」最大化执行成「什么都不写」——第 1 章 v8 就是这么来的。
  // 三家参考项目里，Biz Novel Studio 的 AntiAiRule 专门有一类叫 encourage
  // （鼓励无意义小动作、鼓励现实落差、鼓励嘴硬补偿、鼓励生活噪音），
  // 就是为了对冲这个。这里把它补上。
  out.push("### 七、欢迎这样写（这一节和上面同样重要）");
  out.push("- **欢迎没用的小动作**。转笔帽、抠鞋跟的泥、把杯子挪半寸——不推动主线的动作才有现场感。");
  out.push("- **欢迎现实落差**。人物的预期和结果不必一致；他准备了一整套话，对方一句话就把他堵回来了。");
  out.push("- **欢迎嘴硬和找补**。吃瘪之后找台阶、转移话题、把话说得比心里硬——比直接认怂像人。");
  out.push("- **欢迎生活噪音**。无关的响动、说岔的话、被打断的半句。不是每句话都要有用。");
  out.push("- **欢迎留白**。该说的说完了就停，不要把意思再解释一遍。读者比你以为的聪明。");
  out.push("- **欢迎不完美的收尾**。本章可以留下一个没解决的问题，不必每件事都在本章闭合。");
  out.push("");
  out.push("**写完自己过一遍**：句长是不是有长有短？这一场开了几路感官？");
  out.push("两个人说话能不能听出不是同一个人？有没有一处是只有这个人会做的动作？");
  out.push("结尾是不是停在具体的东西上，而不是一句总结？");
  out.push("");

  if (String(styleBrief ?? "").trim() !== "") {
    out.push("### 八、本书自己的写法");
    out.push("");
    out.push("下面每一条都是作者从这本书的已定稿里挑出来的。**在它明确说到的那一点上，它压过上面任何一条通用要求。**");
    out.push("");
    // 这一段是 A/B 试跑逼出来的。原来的写法是标题上直接写「优先于上面任何一条通用要求」，
    // 结果一条局部偏好「段末落在短句上」被读成了整篇文风的许可证——
    // 起草子代理自述「全部 116 个段落的末句都落在短句上」，逗号长句占比因此停在 36%，
    // 而通用要求里写的是七成以上。优先级说宽一寸，执行就偏一里。
    out.push("但它只管它说到的那一点。**它没提到的地方，一律照上面的通用要求写。**");
    out.push("最常见的误读是把一条局部偏好当成整篇文风的许可证：「段末落在短句上」只管段末那一句，");
    out.push("不是说全篇都用短句，更不是说叙述句都别拿逗号串起来。");
    out.push("");
    out.push(String(styleBrief).trim());
    out.push("");
  }

  if (String(genre ?? "").trim() !== "") {
    out.push(`本书题材：${String(genre).trim()}。题材的语汇要一致，不要串味。`);
    out.push("");
  }

  return out.join("\n");
}
