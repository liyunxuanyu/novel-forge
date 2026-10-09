/**
 * 写法库 + 扫榜。
 *
 * **写法库**是本书层的一等真源：这本书该怎么写。每条写法条目都必须带本书
 * 已定稿章节的出处（章 + 行 + 逐字摘录），否则它就只是别人的偏好。
 * 起草任务包会自动注入它——不靠人记得去翻。
 *
 * **扫榜**把拆书机制卡里的「不适用条件」真正用上：拿本书的七要素去撞它，
 * 撞上了就说别用。只看适用条件等于没看。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { LAYOUT, bookPaths, commitPaths, validateTitle } from "./warehouse.js";

export const STYLE_KINDS = ["视角", "句式", "对话", "留白", "节奏", "意象"];

/**
 * 中文没有空格，按标点切出来的"词"根本没法跟另一句话对齐：
 * 「不要系统流、升级流的作品不要照搬」切出来是「不要系统流」，
 * 拿去和本书的「明确不要什么」比，永远撞不上。
 *
 * 所以改用 n-gram 重叠：取源串所有 3–6 字的连续片段，保留也出现在目标串里的。
 * 取更长的优先——「系统流升级」比「不要系统」更能说明撞的是什么。
 * 纯确定性，无词典无模型。
 */
export function signatureGrams(text, min = 3, max = 6) {
  const s = String(text ?? "").replace(/[\s，,。.；;：:、！？!?（）()「」“”"'《》]/g, "");
  const out = new Set();
  for (let len = max; len >= min; len -= 1) {
    for (let i = 0; i + len <= s.length; i += 1) out.add(s.slice(i, i + len));
  }
  return [...out].sort();
}

/** 源串里能在目标串中出现的最长片段，去重、最多三个。 */
export function distinctiveOverlap(source, target, limit = 3) {
  const hay = String(target ?? "").replace(/[\s，,。.；;：:、！？!?（）()「」“”"'《》]/g, "");
  if (hay === "") return [];
  const grams = signatureGrams(source);
  const hits = grams.filter((g) => hay.includes(g));
  // 去重叠：丢掉被另一个更长命中完全包含的片段
  const kept = hits.filter((g) => !hits.some((other) => other !== g && other.length > g.length && other.includes(g)));
  return kept.sort((a, b) => b.length - a.length).slice(0, limit);
}

/**
 * 一条机制对这本书合不合适。
 *
 * 判定顺序是刻意的：先看不适用条件。理由——适用条件描述的是"一般情况"，
 * 而不适用条件描述的是"什么时候会翻车"。翻车比适用更需要先知道。
 */
export function judgeMechanism(mechanism, context) {
  const avoid = mechanism?.notAppliesWhen;
  const apply = mechanism?.appliesWhen;

  const hardAvoid = distinctiveOverlap(avoid, context?.dontWant);
  if (hardAvoid.length > 0) {
    return {
      verdict: "别用",
      reason: `本书「明确不要什么」里有「${hardAvoid.join("、")}」，正撞在这条机制的不适用条件上。`,
      evidence: hardAvoid,
    };
  }
  const inCore = distinctiveOverlap(avoid, context?.core).filter((w) => !distinctiveOverlap(w, context?.genre).length);
  if (inCore.length > 0) {
    return {
      verdict: "要改着用",
      reason: `本书核心创意里出现「${inCore.join("、")}」，而这条机制的不适用条件点名了它。骨架可以留，具体做法要改。`,
      evidence: inCore,
    };
  }
  const applyHit = distinctiveOverlap(apply, context?.genre).concat(distinctiveOverlap(apply, context?.core));
  if (applyHit.length > 0) {
    return { verdict: "可用", reason: `与本书题材/核心创意（${[...new Set(applyHit)].join("、")}）对得上。`, evidence: applyHit };
  }
  return {
    verdict: "要改着用",
    reason: "适用条件没有明显对上本书的题材或核心创意。先按机制试一章，不合适再退回来。",
    evidence: [],
  };
}

/** 给一批机制逐条判定。 */
export function scanMechanisms(mechanisms, context) {
  const rows = (mechanisms ?? []).map((m) => ({
    id: m.id ?? null,
    name: m.name ?? "(无名)",
    kind: m.kind ?? null,
    verdict: judgeMechanism(m, context).verdict,
    reason: judgeMechanism(m, context).reason,
  }));
  const tally = { "可用": 0, "要改着用": 0, "别用": 0 };
  for (const r of rows) tally[r.verdict] += 1;
  return { rows, tally, total: rows.length };
}

/** 建书时留空的七要素字段会被渲染成占位词「留白」。 */
export const PLACEHOLDER = "留白";

/**
 * 从七要素里取出扫榜要用的三段：不要什么 / 题材 / 核心创意。
 *
 * 占位词要还原成空值。建书时没填的字段落盘是「留白」两个字，
 * 直接当内容用会让「这本书没写不要什么」和「这本书明确不要某某」变成一回事——
 * 扫榜会照着一个作者从没填过的空栏去判别用。
 */
export function bookContext(conceptMarkdown) {
  const text = String(conceptMarkdown ?? "");
  const pick = (label) => {
    const m = new RegExp(`^##\\s*${label}\\s*$[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "m").exec(text);
    if (!m) return "";
    const v = m[1].trim();
    return v === PLACEHOLDER ? "" : v;
  };
  return { dontWant: pick("明确不要什么"), genre: pick("题材与目标读者"), core: pick("核心创意") };
}

// ── 写法库 ───────────────────────────────────────────────────────────────

function styleDir(bookBase) {
  return path.join(bookBase, LAYOUT.setting, "写法");
}

async function finalizedLines(bookBase) {
  const dir = path.join(bookBase, LAYOUT.final);
  const volumes = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const v of volumes) {
    if (!v.isDirectory()) continue;
    const inner = await fs.readdir(path.join(dir, v.name)).catch(() => []);
    for (const f of inner) if (f.endsWith(".md")) files.push(path.join(dir, v.name, f));
  }
  files.sort();
  const map = new Map();
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const m = /ch(\d{4})/.exec(path.basename(file));
    map.set(file, { chapter: m ? Number(m[1]) : null, lines: text.split(/\r?\n/) });
  }
  return map;
}

/** 回定稿原文核验写法条目的出处。核不上就不许立这条写法。 */
export function verifyStyleEvidence(chapters, evidence) {
  const { chapter, lineStart, quote } = evidence ?? {};
  if (!Number.isInteger(chapter) || !Number.isInteger(lineStart) || lineStart < 1) {
    return { ok: false, reason: "bad-locator", detail: "出处要写明第几章、第几行（都从 1 数）。" };
  }
  if (String(quote ?? "").trim() === "") return { ok: false, reason: "no-quote", detail: "没给逐字摘录。" };
  const entry = [...chapters.values()].find((c) => c.chapter === chapter);
  if (!entry) {
    const have = [...chapters.values()].map((c) => c.chapter).filter((c) => c !== null);
    return { ok: false, reason: "no-chapter", detail: `第 ${chapter} 章还没定稿。已定稿：${have.length > 0 ? have.join("、") : "（还没有）"}` };
  }
  const actual = entry.lines[lineStart - 1];
  if (actual === undefined) {
    return { ok: false, reason: "out-of-range", detail: `第 ${chapter} 章只有 ${entry.lines.length} 行。` };
  }
  if (actual !== quote) {
    return { ok: false, reason: "mismatch", detail: `第 ${chapter} 章第 ${lineStart} 行实际是：「${actual}」` };
  }
  return { ok: true };
}

export function validateStyleEntry(e) {
  const missing = [];
  if (!STYLE_KINDS.includes(e?.kind)) missing.push(`kind（须为 ${STYLE_KINDS.join("/")}）`);
  if (!String(e?.statement ?? "").trim()) missing.push("statement（这条写法是什么）");
  if (!String(e?.why ?? "").trim()) missing.push("why（为什么这本书这么写）");
  if (missing.length > 0) return { ok: false, stage: "incomplete-style", detail: `缺：${missing.join("、")}。` };
  return { ok: true };
}

/** 记一批写法条目：逐条核证，全过才落真源并提交。 */
export async function addStyleEntries(workspaceRoot, bookTitle, entries) {
  const err = validateTitle(String(bookTitle ?? "").trim());
  if (err) return { ok: false, stage: "validate-title", detail: err };
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { ok: false, stage: "empty-batch", detail: "一条写法条目都没有。" };

  const bookBase = bookPaths(workspaceRoot, bookTitle).base;
  const chapters = await finalizedLines(bookBase);
  if (chapters.size === 0) {
    return { ok: false, stage: "no-finalized", detail: "这本书还没有定稿章节。写法条目必须从已定稿里长出来，不能凭空写。" };
  }

  const rejected = [];
  const accepted = [];
  for (const e of list) {
    const v = validateStyleEntry(e);
    if (!v.ok) { rejected.push({ name: e?.statement ?? "(无名)", reason: v.stage, detail: v.detail }); continue; }
    const ev = verifyStyleEvidence(chapters, e.evidence);
    if (!ev.ok) { rejected.push({ name: e.statement, reason: ev.reason, detail: ev.detail }); continue; }
    accepted.push(e);
  }
  if (rejected.length > 0) {
    return { ok: false, stage: "evidence-rejected", detail: `${rejected.length} 条出处核不上，整批不落盘。`, rejected, accepted: [] };
  }

  const dir = styleDir(bookBase);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md"));
  let n = existing.length;
  const written = [];
  for (const e of accepted) {
    n += 1;
    const id = `w${String(n).padStart(3, "0")}`;
    const body = [
      `# ${e.kind}｜${id}`, "",
      `**写法**：${String(e.statement).trim()}`, "",
      `**为什么本书这么写**：${String(e.why).trim()}`, "",
      `**出处**：第 ${e.evidence.chapter} 章第 ${e.evidence.lineStart} 行`, "",
      `> ${e.evidence.quote}`, "",
    ].join("\n");
    const rel = path.join(LAYOUT.setting, "写法", `${id}.md`);
    await fs.writeFile(path.join(bookBase, rel), body, "utf8");
    written.push(rel.replace(/\\/g, "/"));
  }
  // commitPaths 的路径是相对工作区根的，不是相对书仓。少了书仓这一段就会报 pathspec 不匹配。
  const gitPaths = written.map((rel) => path.relative(workspaceRoot, path.join(bookBase, rel)).replace(/\\/g, "/"));
  const commit = await commitPaths(workspaceRoot, gitPaths, "design: 沉淀写法库");
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };
  return { ok: true, ids: written.map((w) => path.basename(w, ".md")), files: written, commit: commit.commit };
}

export async function listStyleEntries(workspaceRoot, bookTitle) {
  const err = validateTitle(String(bookTitle ?? "").trim());
  if (err) return { ok: false, stage: "validate-title", detail: err };
  const bookBase = bookPaths(workspaceRoot, bookTitle).base;
  const dir = styleDir(bookBase);
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md")).sort();
  const out = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(dir, f), "utf8");
    const head = /^#\s*([^｜|]+)[｜|]\s*(\S+)/m.exec(text);
    const statement = /\*\*写法\*\*：(.+)/m.exec(text);
    const why = /\*\*为什么本书这么写\*\*：(.+)/m.exec(text);
    const src = /\*\*出处\*\*：第\s*(\d+)\s*章第\s*(\d+)\s*行/.exec(text);
    out.push({
      id: f.replace(/\.md$/, ""),
      kind: (head?.[1] ?? "").trim(),
      statement: statement?.[1]?.trim() ?? "",
      why: why?.[1]?.trim() ?? "",
      chapter: src ? Number(src[1]) : null,
      lineStart: src ? Number(src[2]) : null,
    });
  }
  return { ok: true, entries: out, count: out.length };
}

/**
 * 写法库渲染成起草任务包里的一段文本。
 * 没有条目就说没有——空着比编一段通用文风强。
 */
export function renderStyleBrief(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return "这本书还没有沉淀写法条目。照常写，不要凭想象替作者定文风。";
  }
  const byKind = new Map();
  for (const e of list) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e);
  }
  const lines = [];
  for (const kind of STYLE_KINDS) {
    const items = byKind.get(kind);
    if (!items || items.length === 0) continue;
    lines.push(`### ${kind}`);
    for (const e of items) {
      lines.push(`- ${e.statement}（因为：${e.why}；据第 ${e.chapter} 章第 ${e.lineStart} 行）`);
    }
    lines.push("");
  }
  return ["## 本书写法（已沉淀，务必照此执行）", "", ...lines].join("\n").trim();
}
