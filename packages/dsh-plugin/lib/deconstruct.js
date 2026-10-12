/**
 * 拆书管道 —— 渐进拆解参考小说，产出可核证的写作机制。
 *
 * 两条硬规矩：
 *
 * 1. **渐进**。整本书一次烧完既慢又不可中断。这里把范围切成有界批次，
 *    一次只做一批，做完落盘。中断后重新推导「下一批是哪批」，
 *    不依赖任何内存状态。
 *
 * 2. **可核证**。每条机制必须带原文定位（章节 + 起止行 + 逐字摘录）。
 *    `verifyEvidence` 会真的回到原文那几行去比对——摘录对不上，机制就不成立。
 *    这条是三家都没做到的：Scriptor 记机制、Biz 记角色、oh-story 记结构，
 *    但都没有「你说这条在这儿，那它就得真在这儿」这条机械检查。
 *
 * 机制落在书房（作者层），**不进书仓**。要采纳进本书，必须作者明确决定。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { LAYOUT } from "./warehouse.js";

export const MECHANISM_KINDS = ["角色向", "机制向", "结构向"];
export const DEFAULT_BATCH_CHAPTERS = 5;
export const BASIS_KINDS = ["用户声明", "可核对许可"];

/** 导入时必须交代清楚的六项——不交代就不许拆。 */
export const REQUIRED_META = ["title", "author", "edition", "acquiredFrom", "allowedUses", "basis"];

export function refRoot(studioRoot, sourceId) {
  return path.join(studioRoot, LAYOUT.studio ?? "书房", "参考", sourceId);
}
const sourceFile = (studioRoot, sourceId) => path.join(refRoot(studioRoot, sourceId), "原文.txt");
const planFile = (studioRoot, sourceId) => path.join(refRoot(studioRoot, sourceId), "计划.json");
const progressFile = (studioRoot, sourceId) => path.join(refRoot(studioRoot, sourceId), "进度.json");
const mechDir = (studioRoot, sourceId) => path.join(refRoot(studioRoot, sourceId), "机制");

async function readJson(file, fallback) {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return { ...fallback, parseError: `${path.basename(file)} 解析失败` };
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

/** 导入参考原文：只存本地副本，不发送任何地方。 */
export async function importSource(studioRoot, sourceId, filename, content, meta = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(sourceId ?? ""))) {
    return { ok: false, stage: "bad-source-id", detail: "参考库 id 只能用字母数字下划线横线，1–64 位。" };
  }
  const body = String(content ?? "");
  if (body.trim() === "") return { ok: false, stage: "empty", detail: "原文是空的。" };

  // 权利交代是硬要求。工具不做任何权利保证，但也不接受「没说是哪来的」。
  const missing = REQUIRED_META.filter((k) => !String(meta?.[k] ?? "").trim());
  if (missing.length > 0) {
    return {
      ok: false, stage: "missing-meta",
      detail: `来源交代缺 ${missing.join("、")}。作品、作者/译者、版本、取得来源、允许用途、依据——六项缺一不可。`,
    };
  }
  const basisKind = meta.basisKind ?? "用户声明";
  if (!BASIS_KINDS.includes(basisKind)) {
    return { ok: false, stage: "bad-basis-kind", detail: `依据类型只能是 ${BASIS_KINDS.join(" / ")}。` };
  }
  if (basisKind === "可核对许可" && !String(meta.licenseEvidence ?? "").trim()) {
    return { ok: false, stage: "no-license-evidence", detail: "声明为「可核对许可」却没给出可核对的东西。别选这一项——选「用户声明」是诚实的。" };
  }
  await fs.mkdir(refRoot(studioRoot, sourceId), { recursive: true });
  await fs.writeFile(sourceFile(studioRoot, sourceId), body, "utf8");
  const plan = await readJson(planFile(studioRoot, sourceId), { sourceId, ranges: [], batchChapters: DEFAULT_BATCH_CHAPTERS, version: 0 });
  plan.source = {
    filename, chars: body.length, lines: body.split(/\r?\n/).length, importedAt: new Date().toISOString(),
    translator: meta.translator ?? "", basisKind, licenseEvidence: meta.licenseEvidence ?? "",
    title: meta.title, author: meta.author, edition: meta.edition,
    acquiredFrom: meta.acquiredFrom, allowedUses: meta.allowedUses, basis: meta.basis,
  };
  plan.consent = null;
  await writeJson(planFile(studioRoot, sourceId), plan);
  return { ok: true, sourceId, lines: plan.source.lines, chars: body.length, basisKind, path: path.relative(studioRoot, sourceFile(studioRoot, sourceId)).replace(/\\/g, "/") };
}

export async function listSources(studioRoot) {
  const base = path.join(studioRoot, "书房", "参考");
  const names = await fs.readdir(base).catch(() => []);
  const out = [];
  for (const name of names) {
    const plan = await readJson(planFile(studioRoot, name), null);
    if (plan === null) continue;
    const prog = await readJson(progressFile(studioRoot, name), { done: [], version: 1 });
    out.push({ sourceId: name, source: plan.source ?? null, ranges: plan.ranges ?? [], version: prog.version ?? 1, doneBatches: prog.done?.length ?? 0 });
  }
  return out.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/**
 * 计划：把选定范围切成有界批次。批次边界是**纯函数算出来的**，
 * 所以恢复时不需要额外记住"上次到哪"——重算一遍就知道。
 */
export function computeBatches(ranges, batchChapters = DEFAULT_BATCH_CHAPTERS) {
  const size = Math.max(1, Number(batchChapters) || DEFAULT_BATCH_CHAPTERS);
  const out = [];
  let index = 0;
  for (const r of ranges ?? []) {
    const from = Number(r.from);
    const to = Number(r.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) continue;
    for (let start = from; start <= to; start += size) {
      const end = Math.min(start + size - 1, to);
      out.push({ index, chapter: r.chapter ?? null, from: start, to: end, size: end - start + 1 });
      index++;
    }
  }
  return out;
}

export async function setPlan(studioRoot, sourceId, ranges, batchChapters = DEFAULT_BATCH_CHAPTERS) {
  if (!existsSync(sourceFile(studioRoot, sourceId))) {
    return { ok: false, stage: "no-source", detail: `还没导入 ${sourceId}，先导入原文。` };
  }
  const clean = (ranges ?? []).map((r) => ({ chapter: r.chapter ?? null, from: Number(r.from), to: Number(r.to) }));
  const bad = clean.filter((r) => !Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < r.from);
  if (clean.length === 0) return { ok: false, stage: "no-ranges", detail: "至少要选一个范围。" };
  if (bad.length > 0) return { ok: false, stage: "bad-range", detail: `范围写得不合法：${JSON.stringify(bad)}` };

  // 范围变了，之前的许可就不再覆盖——不静默沿用。
  // 但 source 是导入时冻结的来源交代（作品、作者、依据），不能被覆盖写冲掉：
  // 一旦冲掉，后续任务文本就拿不到作品名，子代理只会看见一个库 id。
  const prev = await readJson(planFile(studioRoot, sourceId), {});
  const plan = { ...prev, sourceId, ranges: clean, batchChapters: Math.max(1, Number(batchChapters) || DEFAULT_BATCH_CHAPTERS), version: (prev.version ?? 0) + 1, consent: null };
  await writeJson(planFile(studioRoot, sourceId), plan);
  return { ok: true, batches: computeBatches(clean, plan.batchChapters), plan, consentCleared: true };
}

export async function getPlan(studioRoot, sourceId) {
  return readJson(planFile(studioRoot, sourceId), { sourceId, ranges: [], batchChapters: DEFAULT_BATCH_CHAPTERS, version: 0 });
}

/** 当前进度：已做完哪几批、下一批是哪批。 */
export async function getProgress(studioRoot, sourceId) {
  const plan = await getPlan(studioRoot, sourceId);
  const prog = await readJson(progressFile(studioRoot, sourceId), { done: [], version: 1, startedAt: null });
  const batches = computeBatches(plan.ranges, plan.batchChapters);
  const doneSet = new Set(prog.done ?? []);
  const next = batches.find((b) => !doneSet.has(b.index)) ?? null;
  const mechCount = (await fs.readdir(mechDir(studioRoot, sourceId)).catch(() => [])).filter((f) => f.endsWith(".json")).length;
  return {
    ok: true,
    sourceId,
    totalBatches: batches.length,
    doneBatches: batches.filter((b) => doneSet.has(b.index)).length,
    next,
    remaining: batches.filter((b) => !doneSet.has(b.index)).length,
    complete: next === null && batches.length > 0,
    version: prog.version ?? 1,
    mechanismCount: mechCount,
  };
}

/** 原文行数组（0 基索引）。 */
export async function readLines(studioRoot, sourceId) {
  const raw = await fs.readFile(sourceFile(studioRoot, sourceId), "utf8").catch(() => null);
  if (raw === null) return null;
  return raw.split(/\r?\n/);
}

/**
 * 证据核验：回到原文指定的行区间，逐字比对摘录。
 * 对不上就是编的——这是整条管道可信度的地基。
 */
export function verifyEvidence(lines, evidence) {
  if (!Array.isArray(lines)) return { ok: false, reason: "no-source", detail: "读不到原文。" };
  const { lineStart, lineEnd, quote } = evidence ?? {};
  if (!Number.isInteger(lineStart) || lineStart < 1) {
    return { ok: false, reason: "bad-line", detail: `起始行 ${lineStart} 不合法（从 1 开始数）。` };
  }
  const end = Number.isInteger(lineEnd) && lineEnd >= lineStart ? lineEnd : lineStart;
  if (lineStart > lines.length) {
    return { ok: false, reason: "out-of-range", detail: `原文只有 ${lines.length} 行，起始行 ${lineStart} 越界了。` };
  }
  const slice = lines.slice(lineStart - 1, Math.min(end, lines.length));
  const actual = slice.join("\n");
  const want = String(quote ?? "");
  if (want.trim() === "") return { ok: false, reason: "no-quote", detail: "没给逐字摘录。" };
  return { ok: actual === want, reason: actual === want ? "verified" : "mismatch", actual, expected: want, detail: actual === want ? "摘录与原文逐字一致。" : "摘录和原文那一段对不上。" };
}

/** 一条机制齐不齐。缺哪项说哪项，不笼统报错。 */
export function validateMechanism(m) {
  const missing = [];
  if (!String(m?.name ?? "").trim()) missing.push("name（机制名）");
  if (!MECHANISM_KINDS.includes(m?.kind)) missing.push(`kind（须为 ${MECHANISM_KINDS.join("/")}）`);
  if (!String(m?.statement ?? "").trim()) missing.push("statement（机制是什么）");
  if (!String(m?.appliesWhen ?? "").trim()) missing.push("appliesWhen（适用条件）");
  if (!String(m?.notAppliesWhen ?? "").trim()) missing.push("notAppliesWhen（不适用条件）");
  const ev = m?.evidence ?? {};
  if (!Number.isInteger(ev.lineStart)) missing.push("evidence.lineStart（原文起始行）");
  if (!String(ev.quote ?? "").trim()) missing.push("evidence.quote（逐字摘录）");
  if (missing.length > 0) {
    return { ok: false, stage: "incomplete-mechanism", detail: `缺：${missing.join("、")}。适用条件与不适用条件都是必填——只写「什么情况下能用」而不写「什么情况下别用」，这条机制就会被人照搬到不合适的地方。` };
  }
  return { ok: true };
}

/**
 * 记一批机制。先逐条验完整性，再逐条回原文核对证据，最后落盘并推进进度。
 * 任何一条不过，这批整体拒绝——半批落盘会让进度账和实际内容对不上。
 */
export async function recordBatch(studioRoot, sourceId, batchIndex, mechanisms) {
  const consent = await getConsent(studioRoot, sourceId);
  if (!consent) {
    return {
      ok: false, stage: "no-consent",
      detail: "作者还没许可把原文发给模型服务。先说清发往哪个服务、由谁允许，再拆。",
    };
  }
  const prog0 = await getProgress(studioRoot, sourceId);
  if (!prog0.next) return { ok: false, stage: "all-done", detail: "所有批次都做完了。" };
  if (Number(batchIndex) !== prog0.next.index) {
    return { ok: false, stage: "not-next-batch", detail: `当前该做的是第 ${prog0.next.index} 批（第 ${prog0.next.from}–${prog0.next.to}），不是第 ${batchIndex} 批。` };
  }
  const list = Array.isArray(mechanisms) ? mechanisms : [];
  if (list.length === 0) {
    return { ok: false, stage: "empty-batch", detail: "这一批一条机制都没拆出来。至少要有证据齐全的一条，否则说明没认真读。" };
  }

  const lines = await readLines(studioRoot, sourceId);
  const accepted = [];
  const rejected = [];
  for (const m of list) {
    const v = validateMechanism(m);
    if (!v.ok) {
      rejected.push({ name: m?.name ?? "(无名)", reason: v.stage, detail: v.detail });
      continue;
    }
    const ev = verifyEvidence(lines, m.evidence);
    if (!ev.ok) {
      rejected.push({ name: m.name, reason: ev.reason, detail: `${ev.detail}${ev.actual !== undefined ? `\n原文第 ${m.evidence.lineStart} 行起实际是：\n${ev.actual}` : ""}` });
      continue;
    }
    accepted.push(m);
  }
  if (rejected.length > 0) {
    return { ok: false, stage: "evidence-rejected", detail: `${rejected.length} 条机制没通过核对，这批整体不落盘。`, rejected, accepted: [] };
  }

  const prog = await readJson(progressFile(studioRoot, sourceId), { done: [], version: 1, startedAt: null });
  const version = prog.version ?? 1;
  const dir = mechDir(studioRoot, sourceId);
  await fs.mkdir(dir, { recursive: true });

  const existing = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json"));
  const ids = existing.map((f) => Number(f.replace(/\D/g, ""))).filter(Number.isInteger);
  let nextNum = ids.length > 0 ? Math.max(...ids) : 0;
  const written = [];
  for (const m of accepted) {
    nextNum += 1;
    const id = `m${String(nextNum).padStart(4, "0")}`;
    const record = {
      id, sourceId, version,
      kind: m.kind, name: m.name.trim(),
      statement: String(m.statement).trim(),
      appliesWhen: String(m.appliesWhen).trim(),
      notAppliesWhen: String(m.notAppliesWhen).trim(),
      evidence: {
        chapter: m.evidence.chapter ?? prog0.next.chapter,
        lineStart: m.evidence.lineStart,
        lineEnd: m.evidence.lineEnd ?? m.evidence.lineStart,
        quote: m.evidence.quote,
      },
      createdAt: new Date().toISOString(),
      status: "候选",
    };
    await writeJson(path.join(dir, `${id}.json`), record);
    written.push(id);
  }

  prog.done = [...(prog.done ?? []), prog0.next.index];
  prog.version = version;
  prog.startedAt = prog.startedAt ?? new Date().toISOString();
  prog.updatedAt = new Date().toISOString();
  await writeJson(progressFile(studioRoot, sourceId), prog);

  const after = await getProgress(studioRoot, sourceId);
  return {
    ok: true, batchIndex: prog0.next.index, range: { from: prog0.next.from, to: prog0.next.to },
    ids: written, version, remaining: after.remaining, complete: after.complete, next: after.next,
  };
}

export async function listMechanisms(studioRoot, sourceId, { kind } = {}) {
  const dir = mechDir(studioRoot, sourceId);
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
  const out = [];
  for (const f of files) {
    const m = await readJson(path.join(dir, f), null);
    if (m === null) continue;
    if (kind && m.kind !== kind) continue;
    out.push(m);
  }
  return out;
}

/** 重拆：版本 +1。旧版本保留——机制会变，但「当初是怎么想的」不能丢。 */
export async function bumpVersion(studioRoot, sourceId, reason) {
  if (!String(reason ?? "").trim()) {
    return { ok: false, stage: "reason-required", detail: "重拆必须写理由：为什么现在的结论和上次不一样。" };
  }
  const prog = await readJson(progressFile(studioRoot, sourceId), { done: [], version: 1 });
  const old = prog.version ?? 1;
  prog.version = old + 1;
  prog.done = [];
  prog.history = [...(prog.history ?? []), { at: new Date().toISOString(), fromVersion: old, toVersion: old + 1, reason: String(reason).trim() }];
  await writeJson(progressFile(studioRoot, sourceId), prog);
  return { ok: true, version: prog.version, previous: old, history: prog.history };
}

/**
 * 处理许可：拆书要把原文发给模型服务，这一步必须作者先明确允许。
 * 同服务同范围续拆沿用；范围一改，许可自动作废。
 */
export async function grantConsent(studioRoot, sourceId, { provider, model, service, note } = {}) {
  const plan = await readJson(planFile(studioRoot, sourceId), null);
  if (plan === null) return { ok: false, stage: "no-source", detail: `还没导入 ${sourceId}。` };
  if (!Array.isArray(plan.ranges) || plan.ranges.length === 0) {
    return { ok: false, stage: "no-range", detail: "还没选拆解范围。许可是对着具体范围给的，先定范围。" };
  }
  const missing = ["provider", "model", "service"].filter((k) => !String({ provider, model, service }[k] ?? "").trim());
  if (missing.length > 0) {
    return { ok: false, stage: "no-service", detail: `必须说清原文会发给哪个 ${missing.join(" / ")}。` };
  }
  plan.consent = { at: new Date().toISOString(), provider, model, service, note: String(note ?? ""), scopes: plan.ranges };
  await writeJson(planFile(studioRoot, sourceId), plan);
  return { ok: true, consent: plan.consent };
}

export async function getConsent(studioRoot, sourceId) {
  const plan = await readJson(planFile(studioRoot, sourceId), null);
  return plan?.consent ?? null;
}
/**
 * 把一段原文编成带**绝对行号**的文本交给子代理。
 * 行号必须是绝对值——机制卡里的 lineStart 用来回原文核对，
 * 给模型的是相对行号，核验就永远对不上。
 */
export function numberLines(lines, from, to) {
  const out = [];
  const end = Math.min(to, lines.length);
  for (let i = Math.max(1, from); i <= end; i += 1) {
    out.push(`${i}\t${lines[i - 1]}`);
  }
  return out.join("\n");
}

export function buildBatchPrompt(meta, batch, numbered) {
  return [
    `你在拆解参考小说《${meta.title}》（${meta.author}${meta.translator ? `／${meta.translator}译` : ""}），拆出可复用的写作机制。`,
    "",
    `本批范围：第 ${batch.from}–${batch.to} 行。只在这一段里拆，不要引用本段之外的行。`,
    "",
    "## 输出格式",
    "JSON 数组，每条机制形如：",
    "{",
    '  "kind": "角色向 | 机制向 | 结构向",',
    '  "name": "机制名",',
    '  "statement": "这条机制是什么",',
    '  "appliesWhen": "什么处境或题材下适用",',
    '  "notAppliesWhen": "什么情况下别用",',
    '  "evidence": { "chapter": 章号, "lineStart": 起始行号, "lineEnd": 结束行号, "quote": "逐字原文" }',
    "}",
    "",
    "## 硬要求",
    "1. `quote` 必须从带行号的原文里逐字抄，一个标点都不许改，不许省略。核对环节会回原文比对，对不上整批作废。",
    "2. `appliesWhen` 与 `notAppliesWhen` **都要写**。只写「什么时候能用」不写「什么时候别用」的机制会被照搬到不合适的地方。",
    "3. 这一段读不出机制就少拆几条。不要凑数，更不许编——编出来的会带崩整个批次的进度账。",
    "4. 只输出 JSON 数组本身，不要任何解释文字。",
    "",
    "## 带行号的原文",
    numbered,
  ].join("\n");
}

/** 从模型输出里抠出 JSON 数组。容忍 ```json 围栏和前后废话。 */
export function extractJsonArray(text) {
  const raw = String(text ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return { ok: false, stage: "no-array", detail: "输出里找不到 JSON 数组。" };
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(parsed)) return { ok: false, stage: "not-array", detail: "解析出来不是数组。" };
    return { ok: true, mechanisms: parsed };
  } catch (error) {
    return { ok: false, stage: "bad-json", detail: `JSON 解析失败：${error.message}` };
  }
}