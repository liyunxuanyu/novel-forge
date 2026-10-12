/**
 * 开书 fan-out：把一份七要素构想拆成整套设计工件，并算出哪些能并行、哪些必须排队。
 *
 * 依赖来自"信息上谁离不开谁"，不是来自代码顺序：
 *   骨架靠构想；分卷布局与世界书靠骨架；卷规划还得再靠布局。
 * 所以最快是三轮：骨架 -> (世界书 || 分卷布局) -> 卷规划。
 *
 * 一律先落候选、作者确认后才进真源。design: 提交只在确认那一刻产生。
 */
import path from "node:path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { LAYOUT, bookPaths, commitPaths, validateTitle } from "./warehouse.js";

const SEP = " :: ";

/** 设计工件清单。deps 里的工件没落真源，这一件就不该开工。 */
export const ARTIFACTS = [
  {
    id: "skeleton", name: "故事骨架", module: "设计",
    target: `${LAYOUT.outline}/故事骨架.md`, deps: [],
    role: "故事架构子代理",
    outputHint: "骨架正文（Markdown），结尾必须带一节「## 索引」，逐行列出本作用到的实体，格式 `- 类型 / 名称`",
  },
  {
    id: "layout", name: "分卷布局", module: "设计",
    target: `${LAYOUT.outline}/分卷布局.md`, deps: ["skeleton"],
    role: "分卷规划子代理",
    outputHint: "分卷布局正文（Markdown）。每卷写成 `## 第 N 卷｜卷名` 或 `## 第 N 卷（第 X–Y 章）｜卷名`，章范围要覆盖全书",
  },
  {
    id: "worldbook", name: "世界书", module: "设定",
    targetDir: LAYOUT.setting, deps: ["skeleton"], dirPerEntry: true,
    role: "设定构建子代理",
    outputHint: "多份条目，每份一段：先写 `## 类型｜名称`，再写正文。类型只用 人物/地点/规则/物品/势力",
  },
  {
    id: "volume-plan", name: "首卷规划", module: "卷规划",
    target: `${LAYOUT.outline}/卷01/卷纲.md`, deps: ["skeleton", "layout"],
    role: "卷规划子代理",
    outputHint: "首卷卷纲正文（Markdown）：本卷目标、卷内转折、逐章目标清单、卷末必须达成的状态",
  },
];

export const ARTIFACT_BY_ID = Object.fromEntries(ARTIFACTS.map((a) => [a.id, a]));

/** 按依赖分层。同一层的互不依赖，可以并行跑。 */
export function planRounds() {
  const done = new Set();
  const rounds = [];
  for (;;) {
    const ready = ARTIFACTS.filter((a) => !done.has(a.id) && a.deps.every((d) => done.has(d)));
    if (ready.length === 0) break;
    rounds.push(ready.map((a) => a.id));
    for (const a of ready) done.add(a.id);
  }
  return { rounds, stuck: ARTIFACTS.filter((a) => !done.has(a.id)).map((a) => a.id) };
}

function artifactAbs(workspaceRoot, bookTitle, artifact) {
  return path.join(bookPaths(workspaceRoot, bookTitle).base, artifact.target ?? artifact.targetDir);
}

export async function landedArtifacts(workspaceRoot, bookTitle) {
  const out = [];
  for (const a of ARTIFACTS) {
    const abs = artifactAbs(workspaceRoot, bookTitle, a);
    if (!existsSync(abs)) continue;
    // 建书时书仓骨架里已经有空的 设定/ 目录了。目录存在不等于工件落真源，
    // 按条目拆分的工件必须有真实条目才算数，否则开书第一步就误判成"已完成"。
    if (a.dirPerEntry && (await walkMarkdown(abs)).length === 0) continue;
    out.push(a.id);
  }
  return out;
}

/**
 * 现在该派哪几件。已落真源的不重复生成（幂等），依赖没满足的不开工。
 */
export async function pendingArtifacts(workspaceRoot, bookTitle) {
  const landed = new Set(await landedArtifacts(workspaceRoot, bookTitle));
  const ready = [];
  const blocked = [];
  for (const a of ARTIFACTS) {
    if (landed.has(a.id)) continue;
    const missing = a.deps.filter((d) => !landed.has(d));
    if (missing.length === 0) {
      ready.push({ id: a.id, name: a.name, role: a.role, target: a.target ?? a.targetDir, outputHint: a.outputHint });
    } else {
      blocked.push({ id: a.id, name: a.name, waitingOn: missing });
    }
  }
  return { landed: [...landed], ready, blocked };
}

/**
 * 骨架的「## 索引」是实体清单的唯一来源。格式：`- 类型 / 名称`。
 * 生成方必须写它，否则一致性检查无从谈起。
 */
export function parseSkeletonIndex(markdown) {
  const text = String(markdown ?? "");
  const section = /^[ \t]*#{2,3}[ \t]*索引[ \t]*$/m.exec(text);
  if (!section) return { found: false, entries: [] };
  const rest = text.slice(section.index + section[0].length);
  const nextHeading = /^[ \t]*#{1,3}[ \t]+\S/m.exec(rest);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;

  const entries = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^[ \t]*[-*][ \t]*(人物|地点|规则|物品|势力)[ \t]*[/／|｜][ \t]*(.+?)[ \t]*$/.exec(line);
    if (m) entries.push({ type: m[1], name: m[2].trim() });
  }
  return { found: true, entries };
}

async function walkMarkdown(dir, out = []) {
  let items = [];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) await walkMarkdown(abs, out);
    else if (it.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

/** 世界书里实际存在的条目：取每份文件的第一行标题。 */
export async function worldbookIndex(workspaceRoot, bookTitle) {
  const base = path.join(bookPaths(workspaceRoot, bookTitle).base, LAYOUT.setting);
  const files = await walkMarkdown(base);
  const entries = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const head = /^#{1,3}[ \t]*([^#\r\n]+)/m.exec(text);
    const raw = (head?.[1] ?? path.basename(file, ".md")).trim();
    const m = /^(人物|地点|规则|物品|势力)[ \t]*[/／|｜][ \t]*(.+)$/.exec(raw);
    entries.push(m
      ? { type: m[1], name: m[2].trim(), file: path.relative(workspaceRoot, file).replace(/\\/g, "/") }
      : { type: null, name: raw, file: path.relative(workspaceRoot, file).replace(/\\/g, "/") });
  }
  return entries;
}

/**
 * 一致性检查：骨架索引里提到的实体，世界书里得都有；反之多出来的也要说一声。
 */
export async function consistencyCheck(workspaceRoot, bookTitle) {
  const err = validateTitle(String(bookTitle ?? "").trim());
  if (err) return { ok: false, stage: "validate-title", detail: err };

  const skeletonPath = path.join(bookPaths(workspaceRoot, bookTitle).base, LAYOUT.outline, "故事骨架.md");
  if (!existsSync(skeletonPath)) {
    return { ok: false, stage: "no-skeleton", detail: "还没有故事骨架，先把骨架落真源再查一致性。" };
  }
  const md = await fs.readFile(skeletonPath, "utf8");
  const index = parseSkeletonIndex(md);
  const wb = await worldbookIndex(workspaceRoot, bookTitle);

  if (!index.found) {
    return {
      ok: false, stage: "no-index",
      detail: "故事骨架里没有「## 索引」一节，无法核对实体。请补上——生成骨架时就应该带。",
    };
  }

  const wbKeys = new Set(wb.map((e) => `${e.type ?? ""}${SEP}${e.name}`));
  const wbNames = new Set(wb.map((e) => e.name));
  const missing = [];
  const typeMismatch = [];
  for (const e of index.entries) {
    if (wbKeys.has(`${e.type}${SEP}${e.name}`)) continue;
    if (wbNames.has(e.name)) typeMismatch.push({ type: e.type, name: e.name, note: "世界书里有同名条目，但类型对不上" });
    else missing.push(e);
  }
  const indexNames = new Set(index.entries.map((e) => e.name));
  const extra = wb.filter((e) => !indexNames.has(e.name));

  const bad = missing.length + typeMismatch.length;
  return {
    ok: true,
    indexCount: index.entries.length,
    worldbookCount: wb.length,
    missing,
    typeMismatch,
    extra,
    consistent: bad === 0,
    detail: bad === 0
      ? `骨架 ${index.entries.length} 个实体全部在世界书里有条目。`
      : `骨架提到 ${index.entries.length} 个实体，世界书 ${wb.length} 条，${missing.length} 个缺失、${typeMismatch.length} 个类型不符、${extra.length} 个多余。`,
  };
}

/** 候选落盘位置：草稿区，永远不是真源。 */
export function candidatePath(workspaceRoot, bookTitle, artifactId) {
  return path.join("草稿", bookTitle, "候选", `${artifactId}.md`);
}

/**
 * 世界书工件一次产出多份条目，按 `## 类型｜名称` 切分。
 *
 * 返回 `{ entries, skipped }`：**认不出的标题必须交回给调用方**。
 * 以前这里对认不出的标题直接 `continue`，那一段就没了 ——
 * 子代理把「地点」写成「场景」、或者分隔符用错，那一份设定就**静默消失**，
 * 而 confirmArtifact 照样报成功、照样提交。缺一份人物设定的代价，
 * 通常要十几章之后才显形，那时候已经查不出是哪一步丢的。
 */
export function worldbookEntryReport(markdown) {
  const text = String(markdown ?? "");
  const parts = text.split(/^(?=[ \t]*#{1,3}[ \t]*)/m).filter((s) => s.trim() !== "");
  const entries = [];
  const skipped = [];
  for (const part of parts) {
    const head = /^#{1,3}[ \t]*([^#\r\n]+)/m.exec(part);
    if (!head) continue;
    const raw = head[1].trim();
    const m = /^(人物|地点|规则|物品|势力)[ \t]*[/／|｜][ \t]*(.+)$/.exec(raw);
    if (!m) { skipped.push(raw); continue; }
    entries.push({ type: m[1], name: m[2].trim(), body: part.trim() });
  }
  return { entries, skipped };
}

/** 只要条目本身时的薄封装。 */
export function splitWorldbookEntries(markdown) {
  return worldbookEntryReport(markdown).entries;
}

/** 确认工件落真源。骨架/布局/卷纲单文件；世界书按条目拆多文件。一次 design: 提交。 */
export async function confirmArtifact(workspaceRoot, bookTitle, artifactId, body) {
  const artifact = ARTIFACT_BY_ID[artifactId];
  if (!artifact) return { ok: false, stage: "unknown-artifact", detail: `没有叫 ${artifactId} 的工件。` };

  const text = String(body ?? "");
  if (text.trim() === "") return { ok: false, stage: "empty-body", detail: "内容是空的，没法落真源。" };

  const bookBase = bookPaths(workspaceRoot, bookTitle).base;
  const written = [];

  if (artifact.dirPerEntry) {
    const { entries, skipped } = worldbookEntryReport(text);
    // 认不出的标题一律拦下，整批不落。落半份世界书比不落更糟：
    // 作者看到「已落真源」会以为齐了，缺的那份要等写到才发作。
    // 这里什么也没写、没提交，重试一次就好，代价只是多跑一轮子代理。
    if (skipped.length > 0) {
      return {
        ok: false,
        stage: "bad-entry-heading",
        detail: `有 ${skipped.length} 段标题不是「## 类型｜名称」：${skipped.join("、")}。`
          + "类型只能用 人物/地点/规则/物品/势力，中间用全角｜或 / 分隔。改好再落 —— 整批一起落，不落半份。",
        skipped,
      };
    }
    if (entries.length === 0) {
      return { ok: false, stage: "no-entries", detail: "世界书工件里没拆出任何条目。每份都得有「## 类型｜名称」标题。" };
    }
    for (const e of entries) {
      const rel = `${artifact.targetDir}/${e.type}/${e.name}.md`;
      const abs = path.join(bookBase, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, e.body, "utf8");
      written.push(rel);
    }
  } else {
    const abs = path.join(bookBase, artifact.target);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
    written.push(artifact.target);
  }

  const gitPaths = written.map((rel) => path.relative(workspaceRoot, path.join(bookBase, rel)).replace(/\\/g, "/"));
  const commit = await commitPaths(workspaceRoot, gitPaths, `design: 确认${artifact.name}`);
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };
  return { ok: true, artifact: artifactId, name: artifact.name, files: written, commit: commit.commit };
}

/** 读建书时冻结的构想快照。 */
export async function readConcept(workspaceRoot, bookTitle) {
  const file = bookPaths(workspaceRoot, bookTitle).concept;
  const text = await fs.readFile(file, "utf8").catch(() => "");
  if (text === "") return { found: false, text: "" };
  return { found: true, text, file };
}

/**
 * 给某个设计工件生成自包含任务文本。
 * 依赖工件的原文直接嵌进来——子代理没有会话记忆，也不会去翻文件。
 */
export function buildArtifactPrompt(artifact, ctx = {}) {
  const sections = [
    `你是《${ctx.book ?? "这本书"}》的${artifact.role}。你没有本次会话的任何记忆，下面就是全部依据。`,
    "",
    "## 已确认的七要素构想（建书时冻结，不可改）",
    ctx.concept || "（未提供）",
  ];

  if (ctx.skeleton) sections.push("", "## 已确认的故事骨架", ctx.skeleton);
  if (ctx.layout) sections.push("", "## 已确认的分卷布局", ctx.layout);
  if (ctx.worldbook) sections.push("", "## 世界书现有条目", ctx.worldbook);

  sections.push(
    "",
    "## 你要交付的",
    artifact.outputHint,
    "",
    "## 硬性要求",
    "1. 只输出工件正文，不要写「以下是…」这类引导语，不要解释你的思路。",
    "2. 不要发明构想像不到的设定。构想里没有的名字、地名、法则、组织，一律不出现。",
    "3. 上面「已确认」的段落是不可推翻的前提。你可以在它之上延伸，但不许推翻。",
    "4. 拿不准的地方宁可留白并标注「待定」，也不要编一个看起来很像样的设定。",
  );
  return sections.join("\n");
}

/** 把某本书当前所有真源读成一段，供工件任务文本引用。 */
export async function truthContext(workspaceRoot, bookTitle, artifact) {
  const base = bookPaths(workspaceRoot, bookTitle).base;
  const need = new Set(artifact.deps);
  const out = {};
  const concept = await readConcept(workspaceRoot, bookTitle);
  if (concept.found) out.concept = concept.text;
  if (need.has("skeleton")) {
    out.skeleton = await fs.readFile(path.join(base, LAYOUT.outline, "故事骨架.md"), "utf8").catch(() => "");
    if (!out.skeleton) delete out.skeleton;
  }
  if (need.has("layout")) {
    out.layout = await fs.readFile(path.join(base, LAYOUT.outline, "分卷布局.md"), "utf8").catch(() => "");
    if (!out.layout) delete out.layout;
  }
  if (need.has("worldbook")) {
    const wb = await worldbookIndex(workspaceRoot, bookTitle);
    out.worldbook = wb.map((e) => `- ${e.type ?? "未分类"} / ${e.name}`).join("\n");
    if (!out.worldbook) delete out.worldbook;
  }
  return out;
}