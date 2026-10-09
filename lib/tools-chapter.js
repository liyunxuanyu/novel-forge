/**
 * 章节流水线（工具层）。
 *
 * 一章走完是这九步：细纲 → 备料 → 任务包 → 导稿 → 派审读 → 回写发现项 → 定稿。
 * 每一步的共同规矩：
 *   · 先校验迁移，再落盘。反过来做会出现「文件已进真源、状态还停在原地」，
 *     真源和状态对不上，后面每一步都在错的基础上往前走。
 *   · execute 一律 resolve，不抛。返回必须自带 ok —— 宿主要靠它决定这一轮算不算数。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  chapterKey, chapterDir, canTransition, readState, advance, recordFindings, listChapterStates,
  checkChapterLength, countWords, DRAFT_AREA,
} from "./chapter-state.js";
import { LAYOUT, bookPaths, commitPaths, bookStatus } from "./warehouse.js";
import { assembleMaterials, buildDraftTask, guessVolume } from "./materials.js";

const pad2 = (n) => String(n).padStart(2, "0");

/** 失败返回的公共字段。 */
const OK_FAIL = {
  ok: { type: "boolean", required: true },
  stage: { type: "string" },
  detail: { type: "string" },
};

function needTitle(title) {
  if (typeof title !== "string" || title.trim() === "") return "必须给书名。";
  return null;
}

/**
 * 章号必须能变成 chNNNN。
 * 非法章号以前直接抛 —— 工具层抛异常会把整轮派发打断，而这里只需要返回一句人话。
 */
function resolveChapter(value, out) {
  try {
    out.key = chapterKey(value);
    out.num = Number(value);
    return null;
  } catch (error) {
    out.key = null;
    return { ok: false, stage: "validate-chapter", detail: String(error?.message ?? error) };
  }
}

/** 约束分级标记。行首才算数——正文里顺口提一句「这是硬要求」不算。 */
const OUTLINE_MARKS = ["硬", "软", "自由"];

/**
 * 读出细纲正文里真正用到的约束等级。
 *
 * 提示词里反复交代了要标等级，但约定挡不住真模型：漏标的细纲照样能落真源，
 * 然后整章照着一份没有约束的骨架写下去，整卷白写。
 */
function outlineMarks(body) {
  const found = new Set();
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*\-]*\d*[.、)]?\s*/, "");
    for (const m of OUTLINE_MARKS) {
      if (line.startsWith(`〔${m}〕`)) found.add(m);
    }
  }
  return [...found];
}

function outlineRelPath(chapter, volume, suffix = "细纲") {
  return `${LAYOUT.outline}/卷${pad2(volume)}/${chapter}-${suffix}.md`;
}

function finalRelPath(chapter, volume, title) {
  const safe = String(title ?? "正文").replace(/[\\/:*?"<>|]/g, "_").trim() || "正文";
  return `${LAYOUT.final}/卷${pad2(volume)}/${chapter}-${safe}.md`;
}

const relFrom = (ws, abs) => path.relative(ws, abs).replace(/\\/g, "/");

/** 作者给这一章的额外指令，存在状态里，跨会话不丢。 */
async function readAuthorNote(ws, title, key) {
  const state = await readState(ws, title, key);
  return String(state?.authorNote ?? "").trim();
}

function summarize(state) {
  const s = state ?? {};
  return {
    chapter: s.chapter ?? null,
    volume: s.volume ?? null,
    stage: s.stage ?? null,
    outlineConfirmed: Boolean(s.outline?.confirmed),
    materialsAssembled: Boolean(s.materials?.assembled),
    draftTaskBuilt: Boolean(s.draftTask?.built),
    draftVersion: Number(s.draft?.version ?? 0),
    reviewDispatched: Boolean(s.review?.dispatched),
    reviewRounds: Number(s.review?.revisions ?? 0),
    reviewFindings: Number(s.review?.findings ?? 0),
    reviewPassed: Boolean(s.review?.passed),
    settled: (s.stage ?? "") === "已定稿",
    updatedAt: s.history?.[s.history.length - 1]?.at ?? null,
  };
}

export function chapterTools(ctx, root) {
  // ── forge_chapter_status ──────────────────────────────────────────────
  const chapterStatusTool = {
    name: "forge_chapter_status",
    description:
      "查一章（或全书各章）的流程状态：细纲确认没、材料备没、稿到第几版、审读几轮、定稿没。" +
      "章号省略时列出全书所有有流程记录的章。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", description: "章号，省略则全书" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, chapters: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `查状态失败（${v.stage}）：${v.detail}` }];
        if (!v.chapters || v.chapters.length === 0) return [{ type: "text", text: "这本书还没有任何章节流程记录。" }];
        const lines = [];
        let currentVolume = null;
        for (const c of v.chapters) {
          if (c.volume !== currentVolume) {
            currentVolume = c.volume;
            lines.push(`第 ${c.volume} 卷`);
          }
          const bits = [c.stage ?? "无状态"];
          if (c.outlineConfirmed) bits.push("细纲已确认");
          if (c.materialsAssembled) bits.push("已备料");
          if (c.draftVersion > 0) bits.push(`稿 v${c.draftVersion}`);
          if (c.reviewFindings > 0) bits.push(`发现 ${c.reviewFindings} 条`);
          if (c.settled) bits.push("已定稿");
          lines.push(`  ${bits.join(" · ")}`);
        }
        return [{ type: "text", text: `共 ${v.chapters.length} 章有流程记录：\n${lines.join("\n")}` }];
      },
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };

      if (args?.chapter === undefined || args.chapter === null) {
        const all = await listChapterStates(ws, title);
        return { ok: true, chapters: all.map(summarize) };
      }
      const __ch = {};
      const __chErr = resolveChapter(args.chapter, __ch);
      if (__chErr) return __chErr;
      const state = await readState(ws, title, __ch.key);
      return { ok: true, chapters: state ? [summarize(state)] : [] };
    },
    presentCall: (a) => ({ card: "generic", title: "章节流程状态", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_outline_draft ────────────────────────────────────────────────
  const outlineDraftTool = {
    name: "forge_outline_draft",
    description:
      "落一份候选章细纲到草稿区（不是真源），状态落到「细纲待确认」。" +
      "正文要自带约束分级：〔硬〕必须成立、〔软〕尽量满足、〔自由〕可以发挥。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      volume: { type: "integer", description: "卷号，省略则按每 20 章一卷推断" },
      body: { type: "string", required: true, description: "细纲正文。要带上约束分级标记：〔硬〕必须成立、〔软〕尽量满足、〔自由〕可以发挥。" },
      authorNote: { type: "string", description: "作者对这一章的额外要求，随材料包带给起草子代理" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { ...OK_FAIL, chapter: { type: "string", required: true }, path: { type: "string", required: true }, chars: { type: "integer" } },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `已落候选细纲 ${v.chapter}\n${v.path}` : `落候选细纲失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;

      // 这里不查空：候选细纲是作者的落地垫，空不空由 confirm 判。
      // 在这儿拦掉会让人看到「没有候选细纲」——比实际情况更让人困惑。
      const body = String(args?.body ?? "");

      const volume = Number(args?.volume ?? guessVolume(key));
      const dir = chapterDir(ws, title, key);
      await fs.mkdir(dir, { recursive: true });
      const abs = path.join(dir, "候选细纲.md");
      await fs.writeFile(abs, body, "utf8");

      const r = await advance(ws, title, key, volume, "draft_outline", (s) => {
        s.outline = { confirmed: false, commit: null, candidateAt: new Date().toISOString() };
        const note = String(args?.authorNote ?? "").trim();
        if (note !== "") s.authorNote = note;
      });
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, chapter: key, path: relFrom(ws, abs), chars: body.length };
    },
    presentCall: (a) => ({ card: "generic", title: "落候选细纲", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_confirm_outline ─────────────────────────────────────────────
  const confirmOutlineTool = {
    name: "forge_confirm_outline",
    description:
      "确认章细纲落真源（design(chNNNN): 提交），状态推进到「细纲已确认」。" +
      "正文必须自带至少一条〔硬〕〔软〕〔自由〕行首标记——落进真源的细纲要分得清哪些不能违反。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      volume: { type: "integer", description: "卷号" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, chapter: { type: "string", required: true }, volume: { type: "integer", required: true },
          commit: { type: "string" }, path: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.chapter} 细纲已确认（约束 ${(v.marks ?? []).join("、") || "未标"}${v.commit ? `，提交 ${String(v.commit).slice(0, 8)}` : ""}）` : `确认细纲失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;
      const state = await readState(ws, title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 没有候选细纲，先调 forge_outline_draft。` };

      // 先校验迁移再落盘。反过来做会出事：迁移被拒时文件已经写进书仓、
      // 提交也已经产生，状态却停在原地，真源和状态就对不上了。
      const gate = canTransition(state.stage ?? null, "confirm_outline");
      if (!gate.ok) return { ok: false, stage: "transition", detail: gate.reason };

      const volume = Number(args?.volume ?? state.volume ?? guessVolume(key));

      let body;
      try {
        body = await fs.readFile(path.join(chapterDir(ws, title, key), "候选细纲.md"), "utf8");
      } catch {
        return { ok: false, stage: "no-draft", detail: "候选细纲文件不见了，重新落一份。" };
      }
      if (body.trim() === "") return { ok: false, stage: "empty-draft", detail: "候选细纲是空的。" };

      // 确认前最后一道：正文必须自带约束分级。提示词里交代过，但真模型会漏。
      const marks = outlineMarks(body);
      if (marks.length === 0) {
        return {
          ok: false, stage: "outline-unmarked",
          detail: "细纲正文里没有一条约束分级标记（〔硬〕〔软〕〔自由〕）。" +
            "落进真源的细纲必须分得清哪些不能违反——否则起草子代理无从判断，" +
            "整章会照着一份没有约束的骨架写下去。在正文里给约束逐条标上等级再确认。",
        };
      }

      const rel = outlineRelPath(key, volume);
      const abs = path.join(bookPaths(ws, title).base, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body, "utf8");

      const commit = await commitPaths(ws, [relFrom(ws, abs)], `design(${key}): 确认章细纲`);
      if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };

      const r = await advance(ws, title, key, volume, "confirm_outline", (s) => {
        s.volume = volume;
        s.outline = { confirmed: true, commit: commit.commit };
      }, commit.commit);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, chapter: key, volume, commit: commit.commit, path: `${LAYOUT.books}/${title}/${rel}`, marks };
    },
    presentCall: (a) => ({ card: "generic", title: "确认章细纲", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_assemble_materials ──────────────────────────────────────────
  const assembleTool = {
    name: "forge_assemble_materials",
    description:
      "组装本章十段基础材料：任务、上一章结尾、前情提要、人物、场景、契约红线、伏笔、卷规划、文风基准、作者指令。" +
      "每段带来源与指纹；真源里没有的如实报缺，不假装齐全。来源变了标过期，不静默沿用旧摘录。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      volume: { type: "integer", description: "卷号" },
      authorNote: { type: "string", description: "本次对这一章的额外要求" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, chapter: { type: "string", required: true }, volume: { type: "integer", required: true },
          segments: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          missing: { type: "array", required: true, items: { type: "string" } },
          stale: { type: "array", required: true, items: { type: "string" } },
          packageHash: { type: "string", required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `组装材料失败（${v.stage}）：${v.detail}` }];
        const lines = (v.segments ?? []).map((s) => `  ${s.ok ? "✓" : "✗"} ${s.name}`);
        const tail = [];
        if (v.missing?.length) tail.push(`缺 ${v.missing.length} 段：${v.missing.join("、")}`);
        if (v.stale?.length) tail.push(`过期 ${v.stale.length} 段：${v.stale.join("、")}`);
        return [{ type: "text", text: `${v.chapter} 材料包 ${v.packageHash}\n${lines.join("\n")}${tail.length ? `\n${tail.join("\n")}` : ""}` }];
      },
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;
      const state = await readState(ws, title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 没有流程记录，先落候选细纲。"` };
      if (!state.outline?.confirmed) {
        return { ok: false, stage: "outline-not-confirmed", detail: `${key} 的细纲还没确认。细纲没进真源，材料包里的任务段是空的。` };
      }
      const volume = Number(args?.volume ?? state.volume ?? guessVolume(key));
      const note = String(args?.authorNote ?? "").trim() || String(state.authorNote ?? "").trim();

      const pkg = await assembleMaterials(ws, title, key, {
        volume,
        authorNote: note,
        previous: state.materials?.segments ?? [],
      });

      const r = await advance(ws, title, key, volume, "assemble_materials", (s) => {
        s.volume = volume;
        s.materials = {
          assembled: true, at: new Date().toISOString(),
          packageHash: pkg.packageHash, segments: pkg.segments,
        };
        // 作者指令存进状态：draft_task 是另一次调用，参数里不会再带一遍。
        if (note !== "") s.authorNote = note;
      });
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return {
        ok: true, chapter: key, volume,
        segments: pkg.segments, missing: pkg.missing, stale: pkg.stale, packageHash: pkg.packageHash,
      };
    },
    presentCall: (a) => ({ card: "generic", title: "组装材料包", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_draft_task ──────────────────────────────────────────────────
  const draftTaskTool = {
    name: "forge_draft_task",
    description:
      "由材料包生成自包含起草任务包：子代理拿到这段文本就能直接写，零会话上下文也行。" +
      "目标字数会记进章节状态，导入稿件时据此核对篇幅。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      volume: { type: "integer", description: "卷号" },
      chapterTitle: { type: "string", description: "本章标题" },
      targetWords: { type: "integer", description: "目标字数，缺省 3000" },
      extraInstructions: { type: "string", description: "本次的额外要求" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { ...OK_FAIL, chapter: { type: "string", required: true }, task: { type: "string", required: true }, targetWords: { type: "integer", required: true }, packageHash: { type: "string" } },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.chapter} 起草任务包已生成（${v.task.length} 字，目标 ${v.targetWords} 字），可直接派给起草子代理。` : `生成任务包失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;
      const state = await readState(ws, title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 没有流程记录。` };

      const volume = Number(args?.volume ?? state.volume ?? guessVolume(key));
      const targetWords = Number(args?.targetWords ?? 3000);
      const pkg = await assembleMaterials(ws, title, key, {
        volume,
        authorNote: await readAuthorNote(ws, title, key),
        previous: state.materials?.segments ?? [],
      });
      const task = buildDraftTask(pkg, {
        title: args?.chapterTitle ?? "",
        targetWords,
        extraInstructions: args?.extraInstructions ?? "",
      });
      await advance(ws, title, key, volume, "build_draft_task", (s) => {
        s.draftTask = { built: true, at: new Date().toISOString(), packageHash: pkg.packageHash, targetWords };
      });
      return { ok: true, chapter: key, task, targetWords, packageHash: pkg.packageHash };
    },
    presentCall: (a) => ({ card: "generic", title: "生成起草任务包", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_import_draft ────────────────────────────────────────────────
  const importDraftTool = {
    name: "forge_import_draft",
    description:
      "导入一章稿件到草稿区（v1、v2…递增，旧稿保留），状态落到「待审」。" +
      "正文不足目标字数一半会给出提醒；真正拦的是定稿那一刻。短章、番外在定稿时带 allowShort。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      body: { type: "string", required: true, description: "正文全文" },
      origin: { type: "string", description: "来源标记，如 起草子代理 / 作者手写。缺省 起草子代理。" },
      allowShort: { type: "boolean", description: "正文不足目标字数一半时仍要导入（短章、番外）。缺省 false。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, chapter: { type: "string", required: true }, version: { type: "integer", required: true },
          path: { type: "string", required: true }, words: { type: "integer", required: true },
          short: { type: "boolean" }, note: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `已导入 ${v.chapter} 第 ${v.version} 稿（${v.words} 字）\n状态 → 待审` : `导入稿件失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;
      const body = String(args?.body ?? "");
      if (body.trim() === "") return { ok: false, stage: "empty-body", detail: "正文是空的。" };

      const state = await readState(ws, title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 没有流程记录。` };

      const version = Number(state.draft?.version ?? 0) + 1;
      const dir = path.join(chapterDir(ws, title, key), "稿件");
      await fs.mkdir(dir, { recursive: true });
      const abs = path.join(dir, `v${version}.md`);
      await fs.writeFile(abs, body, "utf8");

      const volume = state.volume ?? guessVolume(key);
      const r = await advance(ws, title, key, volume, "import_draft", (s) => {
        s.draft = { version, latest: `稿件/v${version}.md`, origin: args?.origin ?? "起草子代理", at: new Date().toISOString() };
      });
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };

      // 导入阶段只提醒不拦：稿子还在改，拦下来只会把链条卡住等作者。
      // 真正不可逆的是定稿那一刻——空壳进了书仓才收不回来。
      const words = countWords(body);
      const len = checkChapterLength(words, state.draftTask?.targetWords, `${key} 稿件`);
      return {
        ok: true, chapter: key, version, words,
        short: !len.ok, note: len.ok ? undefined : len.detail,
        path: `${DRAFT_AREA}/${title}/${key}/稿件/v${version}.md`,
      };
    },
    presentCall: (a) => ({ card: "generic", title: "导入章节稿", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_dispatch_review ─────────────────────────────────────────────
  // 补上断链的一环：状态机里 dispatch_review（待审 → 审读中）此前没有任何工具能触发，
  // 于是 record_findings 永远被挡在门外 —— 一章都走不到定稿。
  const dispatchReviewTool = {
    name: "forge_dispatch_review",
    description:
      "声明这一章的审读已经派出去：把状态从「待审」推进到「审读中」。" +
      "派之前必须先有稿；回写发现项只允许在审读中做。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      dimensions: { type: "array", description: "本次审读的维度", items: { type: "string" } },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, chapter: { type: "string", required: true },
          nextStage: { type: "string", required: true }, revisions: { type: "integer", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.chapter} 审读已派出（第 ${v.revisions} 轮），状态 → 审读中。现在回写发现项。` : `派审读失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;
      const state = await readState(ws, title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 没有流程记录。"` };
      if (!state.draft?.latest) return { ok: false, stage: "no-draft", detail: `${key} 还没有稿件，先导入正文再派审读。` };

      const dimensions = Array.isArray(args?.dimensions) ? args.dimensions.map((d) => String(d).trim()).filter(Boolean) : [];
      const volume = state.volume ?? guessVolume(key);

      // 写在 s（state）上而不是 draft 上：advance 只持久化 state，
      // draft 仅用于带 to / note / commit。写错地方等于什么都没记，
      // 改稿轮次上限就永远数不到。
      const r = await advance(ws, title, key, volume, "dispatch_review", (s) => {
        s.review = {
          ...(s.review ?? {}),
          dispatched: true,
          at: new Date().toISOString(),
          revisions: (s.review?.revisions ?? 0) + 1,
          dimensions,
        };
        return true;
      }, null);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, chapter: key, nextStage: "审读中", revisions: r.to.review.revisions };
    },
    presentCall: (a) => ({ card: "generic", title: "派出章节审读", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_record_findings ────────────────────────────────────────────
  const recordFindingsTool = {
    name: "forge_record_findings",
    description:
      "回写审读结果。有发现项 → 待改；零发现项 → 待定稿，但必须给出本次覆盖了哪些维度，" +
      "否则按「空审通过」拒绝。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      covered: { type: "array", required: true, description: "本次实际审读过的维度", items: { type: "string" } },
      findings: { type: "array", description: "发现的问题；空数组表示零发现项", items: { type: "object", additionalProperties: false, properties: {
        quote: { type: "string", required: true, description: "逐字引文" },
        note: { type: "string", required: true, description: "问题说明" },
        dimension: { type: "string", description: "所属维度" },
      } } },
      summary: { type: "string", description: "本次审读小结" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, chapter: { type: "string", required: true }, passed: { type: "boolean", required: true },
          nextStage: { type: "string", required: true }, findingsCount: { type: "integer", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.chapter} 已回写 ${v.findingsCount} 条发现项，状态 → ${v.nextStage}` : `回写发现项失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;
      const state = await readState(ws, title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 没有流程记录。` };
      const volume = state.volume ?? guessVolume(key);

      const r = await recordFindings(ws, title, key, volume, {
        findings: args?.findings ?? [],
        covered: args?.covered ?? [],
        summary: args?.summary ?? "",
      });
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, chapter: key, passed: r.pass, nextStage: r.to.stage, findingsCount: args?.findings?.length ?? 0 };
    },
    presentCall: (a) => ({ card: "generic", title: "回写审读发现项", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  // ── forge_settle_chapter ──────────────────────────────────────────────
  const settleTool = {
    name: "forge_settle_chapter",
    description:
      "定稿入档：把待定稿正文落到 定稿/卷NN/NNNN-*.md 并做一次 ch: 提交，随后书仓状态里已定稿章数 +1。" +
      "提交成功状态才推进到已定稿；提交失败状态原地不动，可重试。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", required: true, description: "章号" },
      chapterTitle: { type: "string", description: "章名，用作定稿文件名的一部分" },
      body: { type: "string", description: "定稿正文。省略则取草稿区最新一稿。" },
      allowShort: { type: "boolean", description: "正文不足目标字数一半时仍要定稿（短章、番外）。缺省 false。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, chapter: { type: "string", required: true }, volume: { type: "integer", required: true },
          commit: { type: "string" }, path: { type: "string" }, words: { type: "integer" },
          bookStatus: { type: "object", additionalProperties: false, properties: {
            finalizedChapterCount: { type: "integer", required: true },
            lastChapter: { type: "string" },
            volumesPresent: { type: "array", items: { type: "integer" } },
          } },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.chapter} 已定稿（${v.words ?? 0} 字，提交 ${String(v.commit ?? "").slice(0, 8)}）→ ${v.path}` : `定稿失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = String(args?.title ?? "").trim();
      const err = needTitle(title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const __ch = {};
      const __chErr = resolveChapter(args?.chapter, __ch);
      if (__chErr) return __chErr;
      const key = __ch.key;
      const state = await readState(ws, title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 还没有流程记录。` };

      // 同 confirm_outline：迁移没过就不许碰书仓。否则会出现「稿子已定稿入档、
      // 状态却还停在待改」这种真源与状态打架的局面。
      const gate = canTransition(state.stage ?? null, "settle");
      if (!gate.ok) return { ok: false, stage: "transition", detail: gate.reason };

      const volume = Number(args?.volume ?? state.volume ?? guessVolume(key));

      let body = String(args?.body ?? "");
      if (body.trim() === "") {
        const latest = state.draft?.latest;
        if (!latest) return { ok: false, stage: "no-draft", detail: `${key} 还没有稿件可定稿。` };
        body = await fs.readFile(path.join(chapterDir(ws, title, key), latest), "utf8");
      }
      if (body.trim() === "") return { ok: false, stage: "empty-body", detail: "定稿正文是空的。" };

      const words = countWords(body);
      if (!args?.allowShort) {
        const len = checkChapterLength(words, state.draftTask?.targetWords, `${key} 定稿正文`);
        if (!len.ok) return { ok: false, stage: len.stage, detail: len.detail };
      }

      const rel = finalRelPath(key, volume, args?.chapterTitle);
      const abs = path.join(bookPaths(ws, title).base, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body, "utf8");

      const label = String(args?.chapterTitle ?? "").trim() || `第${__ch.num}章`;
      const commit = await commitPaths(ws, [relFrom(ws, abs)], `ch: ${key} ${label}`);
      if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };

      const r = await advance(ws, title, key, volume, "settle", (s) => {
        s.settlement = { ...(s.settlement ?? {}), prepared: true, settledAt: new Date().toISOString(), commit: commit.commit, file: rel };
      }, commit.commit);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };

      const status = await bookStatus(ws, title);
      return { ok: true, chapter: key, volume, commit: commit.commit, path: `${LAYOUT.books}/${title}/${rel}`, words, bookStatus: status };
    },
    presentCall: (a) => ({ card: "generic", title: "章节定稿入档", kind: "other", rawInput: { title: a?.title, chapter: a?.chapter } }),
  };

  return [chapterStatusTool, outlineDraftTool, confirmOutlineTool, assembleTool, draftTaskTool, importDraftTool, dispatchReviewTool, recordFindingsTool, settleTool];
}
