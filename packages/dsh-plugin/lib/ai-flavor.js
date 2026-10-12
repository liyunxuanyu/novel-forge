/**
 * 去 AI 味：机械可查的判据，产出可定位到行的清单。
 *
 * 三条规矩：
 * 1. **纯函数**。同一段文本两次检测结果必须完全一致——不调模型、不看时间、不读环境。
 * 2. **只报不改**。这里绝不碰正文一个字。改不改、怎么改，由作者或改稿子代理决定。
 * 3. **报行号**。每条都要能在定稿里点开定位。"AI 味重"这种评语没有用。
 *
 * 判据只覆盖**可机械识别**的那几类。AI 味远不止这些，这里不做全景判断，
 * 也不假装覆盖了——检测不出来不等于写得对。
 */

export const SEVERITY = { structural: "s3", style: "s4" };

/** 万能形容词：换个名字也能用的高频套话。 */
export const FILLER_ADJECTIVES = [
  "无尽的", "莫名的", "复杂的", "深刻的", "淡淡的", "幽幽的", "无声的",
  "莫名的", "难以言喻的", "不可名状的", "微妙的", "复杂的", "深邃的", "凛冽的",
];

/** 总结句标志：把意思重讲一遍的连接词。 */
export const SUMMARY_MARKERS = [
  "这意味着", "换句话说", "也就是说", "总之", "归根结底", "原来如此",
  "毫无疑问", "不言而喻", "值得一提的是", "总而言之", "简而言之",
];

/** 情绪直述标志：直接命名情绪，而不是把它演出来。 */
export const EMOTION_PATTERNS = [
  { re: /(?:他|她|我|它|它们)?(?:的)?(?:心里|心中|内心)(?:充满|满是|涌起|全是|都是|只剩下)/, why: "直接说出心里有什么，而不是让读者从动作里读出来" },
  { re: /(他|她)(?:感到|感觉到)(?:十分|非常|极度|无比)?(愤怒|悲伤|恐惧|害怕|难过|高兴|兴奋|绝望|愧疚|焦虑|痛苦|失望)/, why: "情绪被命名而非呈现" },
  { re: /(他|她)(?:很|非常|十分|极度|无比)(愤怒|悲伤|恐惧|害怕|难过|高兴|兴奋|绝望|愧疚|焦虑|痛苦|失望)/, why: "情绪被贴标签而非演出来" },
  { re: /心中(?:一)?(暖|酸|疼|空|颤)/, why: "用一个字概括情绪，替代了具体感受" },
];

/** 对称句式标志：用结构对称代替真实思维。 */
export const SYMMETRY_PATTERNS = [
  { re: /不是[^，。！？]{1,12}[，,]\s*而是/, why: "「不是…而是…」用多了像格言" },
  { re: /既[^，。！？]{1,10}又[^，。！？]{1,10}/, why: "「既…又…」并列，读者能预判" },
  { re: /与其说[^，。！？]{1,12}[，,]\s*不如说/, why: "「与其说…不如说…」是模板句" },
];

const SENTENCE_SPLIT = /(?<=[。！？!?；;…])/;

/** 把 Markdown 正文拆成带行号的句子。 */
export function toSentences(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    const withoutHeading = raw.replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s*/, "");
    const head = raw.length - withoutHeading.length > 0 ? "标记行" : "正文";
    for (const piece of withoutHeading.split(SENTENCE_SPLIT)) {
      const text = piece.trim();
      if (text === "") continue;
      out.push({ line: lineNo, text, head });
    }
  }
  return out;
}

function hit(id, name, severity, why, s) {
  return { id, name, severity, why, line: s.line, text: s.text };
}

/**
 * 排比堆砌：连续几句长度几乎相同、收尾标点相同 —— 这是模型最典型的节奏指纹。
 * 判据纯机械：长度差 ≤1 字且末字符相同，连成 ≥3 句。
 * 原本放宽到 ≤3，实测 6/8/6 字这种正常句子也会被算成排比，太吵。
 */
export function detectParallel(sentences) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) {
      const s = run[run.length - 1];
      out.push(hit("parallel", "排比堆砌", SEVERITY.style,
        `${run.length} 句连排，长度 ${run.map((r) => r.text.length).join("/")}，收尾一致`, s));
    }
    run = [];
  };
  for (const s of sentences) {
    if (s.head === "标记行" || s.text.length < 4) continue;
    const tail = s.text.slice(-1);
    const last = run[run.length - 1];
    if (last && last.tail === tail && Math.abs(last.text.length - s.text.length) <= 1) {
      run.push({ ...s, tail });
    } else {
      flush();
      run = [{ ...s, tail }];
    }
  }
  flush();
  return out;
}

/**
 * 总结句标志。
 * 原本还想要求它出现在句尾，实测太窄——"这意味着X"里标志词本来就在句首，
 * 按句尾判会整类漏掉。改成出现即命中：这类词在叙事正文里本来就极少出现。
 */
export function detectSummary(sentences) {
  const out = [];
  for (const s of sentences) {
    const hitMarker = SUMMARY_MARKERS.find((m) => s.text.includes(m));
    if (!hitMarker) continue;
    out.push(hit("summary", "总结句标志", SEVERITY.style,
      `用了「${hitMarker}」，把已经演出来的意思又讲了一遍`, s));
  }
  return out;
}

/** 情绪直述。 */
export function detectEmotion(sentences) {
  const out = [];
  for (const s of sentences) {
    for (const p of EMOTION_PATTERNS) {
      const m = p.re.exec(s.text);
      if (!m) continue;
      out.push(hit("emotion", "情绪直述", SEVERITY.style, `${p.why}（「${m[0]}」）`, s));
      break;
    }
  }
  return out;
}

/** 万能形容词：换个名字也成立的高频修饰。 */
export function detectFiller(sentences) {
  const out = [];
  for (const s of sentences) {
    const found = FILLER_ADJECTIVES.filter((a) => s.text.includes(a));
    if (found.length === 0) continue;
    out.push(hit("filler", "万能形容词", SEVERITY.style,
      `「${[...new Set(found)].join("、")}」换个形容词也成立，不承担信息`, s));
  }
  return out;
}

/** 对称句式。 */
export function detectSymmetry(sentences) {
  const out = [];
  for (const s of sentences) {
    for (const p of SYMMETRY_PATTERNS) {
      const m = p.re.exec(s.text);
      if (!m) continue;
      out.push(hit("symmetry", "对称句式", SEVERITY.style, `${p.why}（「${m[0].slice(0, 12)}…」）`, s));
      break;
    }
  }
  return out;
}

export const DETECTORS = [
  { id: "parallel", name: "排比堆砌", run: detectParallel },
  { id: "summary", name: "段末总结", run: detectSummary },
  { id: "emotion", name: "情绪直述", run: detectEmotion },
  { id: "filler", name: "万能形容词", run: detectFiller },
  { id: "symmetry", name: "对称句式", run: detectSymmetry },
];

/**
 * 跑一遍检测。纯函数：同样的输入必然得到同样的输出。
 * 按行号再按判据 id 排序，保证顺序也是确定的。
 */
export function detectAiFlavor(markdown) {
  // 标题与列表标记统一在这里排除。之前只有排比检测器跳过了标记行，
  // 结果标题里的套话会被其余四类判据当成正文命中。
  const sentences = toSentences(markdown).filter((s) => s.head !== "标记行");
  const hits = [];
  for (const d of DETECTORS) hits.push(...d.run(sentences));
  hits.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));

  const byKind = {};
  for (const d of DETECTORS) byKind[d.id] = 0;
  for (const h of hits) byKind[h.id] += 1;

  const lines = String(markdown ?? "").split(/\r?\n/).length;
  return {
    ok: true,
    sentences: sentences.length,
    lines,
    hits,
    byKind,
    total: hits.length,
    detail: hits.length === 0
      ? `${lines} 行、${sentences.length} 句，五类判据都没命中。`
      : `${lines} 行命中 ${hits.length} 处：${DETECTORS.filter((d) => byKind[d.id] > 0).map((d) => `${d.name} ${byKind[d.id]}`).join("、")}。`,
  };
}

/** 按行把命中聚起来，方便直接跳过去改。 */
export function groupByLine(result) {
  const map = new Map();
  for (const h of result.hits) {
    if (!map.has(h.line)) map.set(h.line, []);
    map.get(h.line).push(h);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, hits]) => ({ line, text: hits[0].text, hits }));
}
