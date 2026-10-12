/** 阶段八工具层：写法库、扫榜、去 AI 味。 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  STYLE_KINDS, addStyleEntries, listStyleEntries, renderStyleBrief,
  scanMechanisms, bookContext, judgeMechanism,
} from "./style.js";
import { listMechanisms } from "./deconstruct.js";
import { detectAiFlavor, groupByLine, DETECTORS } from "./ai-flavor.js";
import { bookPaths, chapterFromPaths, validateTitle, LAYOUT } from "./warehouse.js";
import { readState, chapterKey, chapterDir } from "./chapter-state.js";

const OK_FAIL = { ok: { type: "boolean", required: true }, stage: { type: "string" }, detail: { type: "string" } };

export function styleTools(ctx, resolveRoot) {
  const root = async () => {
    const r = resolveRoot();
    if (!r) throw new Error("当前会话没有有效工作区。");
    return r;
  };
  const titleErr = (t) => validateTitle(String(t ?? "").trim());

  // ── forge_style_add ───────────────────────────────────────────────────
  const addTool = {
    name: "forge_style_add",
    description:
      "沉淀这本书的写法条目。出处必须指向本书**已定稿**章节的第几章第几行，" +
      "系统会回原文逐字核对——核不上整批不落盘。" +
      "没有定稿就攒不出写法：写法是从已经写出来的东西里长出来的，不是先定规矩再照着写。" +
      "为什么这么写（why）必填：只有偏好没有理由的写法，下次换个人接手就废了。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      entries: {
        type: "array", required: true, description: "写法条目",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            kind: { type: "string", required: true, description: `类别：${STYLE_KINDS.join(" / ")}` },
            statement: { type: "string", required: true, description: "这条写法是什么" },
            why: { type: "string", required: true, description: "为什么这本书这么写" },
            evidence: {
              type: "object", additionalProperties: false,
              properties: {
                chapter: { type: "integer", required: true, description: "全书连续章号，从 1 数" },
                lineStart: { type: "integer", required: true, description: "行号，从 1 数" },
                quote: { type: "string", required: true, description: "该行的逐字原文" },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          ids: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          commit: { type: "string" },
          rejected: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string", required: true }, reason: { type: "string", required: true }, detail: { type: "string" } } } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) {
          const rej = v.rejected?.length ? `\n\n被拒：\n${v.rejected.map((r) => `· ${r.name}（${r.reason}）\n  ${r.detail}`).join("\n")}` : "";
          return [{ type: "text", text: `写法条目没落盘（${v.stage}）：${v.detail}${rej}` }];
        }
        return [{ type: "text", text: `已沉淀 ${v.ids.length} 条写法：${v.ids.join("、")}\n提交 ${v.commit}\n这些会随起草任务包一起注入。` }];
      },
    },
    async execute(args) {
      const err = titleErr(args?.title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const r = await addStyleEntries(await root(), args.title, args?.entries ?? []);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail, rejected: r.rejected ?? [] };
      return { ok: true, ids: r.ids, files: r.files, commit: r.commit };
    },
    presentCall: (a) => ({ card: "generic", title: "沉淀写法条目", kind: "other", rawInput: { title: a?.title, count: a?.entries?.length } }),
  };

  // ── forge_style_list ──────────────────────────────────────────────────
  const listTool = {
    name: "forge_style_list",
    description:
      "查看这本书已沉淀的写法条目，并给出可直接粘进起草任务的写法简报。" +
      "一条都没有时如实说没有——空着比编一段通用文风强。",
    parameters: { title: { type: "string", required: true, description: "书名" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, count: { type: "integer", required: true },
          brief: { type: "string", required: true },
          entries: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, kind: { type: "string", required: true }, statement: { type: "string", required: true }, why: { type: "string", required: true }, chapter: { type: "integer" }, lineStart: { type: "integer" } } } },
        },
      },
      render: (_a, v) => v.ok
        ? [{ type: "text", text: v.count === 0
            ? "这本书还没有沉淀写法条目。照常写，不要凭想象替作者定文风。"
            : `写法 ${v.count} 条：\n\n${v.entries.map((e) => `[${e.id}]（${e.kind}）${e.statement}\n  因为：${e.why}\n  据第 ${e.chapter} 章第 ${e.lineStart} 行`).join("\n\n")}\n\n—— 以下是可直接注入起草任务的简报 ——\n\n${v.brief}` }]
        : [{ type: "text", text: `查写法失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const err = titleErr(args?.title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const r = await listStyleEntries(await root(), args.title);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, count: r.count, entries: r.entries, brief: renderStyleBrief(r.entries) };
    },
    presentCall: (a) => ({ card: "generic", title: "查看写法库", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_scan_mechanisms ─────────────────────────────────────────────
  const scanTool = {
    name: "forge_scan_mechanisms",
    description:
      "扫榜：拿本书七要素去撞拆书机制卡，给出每条「可用 / 要改着用 / 别用」的判断。" +
      "判定先看机制的**不适用条件**——适用条件说的是一般情况，不适用条件说的是什么时候会翻车，" +
      "翻车更需要先知道。只看适用条件等于没看。" +
      "只看指定机制（mechanismIds）时给单条判断，否则扫该参考库全部机制。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      sourceId: { type: "string", description: "参考库 id，省略则扫全部" },
      mechanismIds: { type: "array", items: { type: "string" }, description: "只看这几条机制的判断" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          total: { type: "integer", required: true },
          tally: { type: "object", additionalProperties: false, properties: { "可用": { type: "integer", required: true }, "要改着用": { type: "integer", required: true }, "别用": { type: "integer", required: true } } },
          rows: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, name: { type: "string", required: true }, kind: { type: "string" }, verdict: { type: "string", required: true }, reason: { type: "string", required: true } } } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `扫榜失败（${v.stage}）：${v.detail}` }];
        if (v.total === 0) return [{ type: "text", text: "没有可扫的机制。" }];
        const head = `共 ${v.total} 条：可用 ${v.tally["可用"]}、要改着用 ${v.tally["要改着用"]}、别用 ${v.tally["别用"]}`;
        return [{ type: "text", text: `${head}\n\n${v.rows.map((r) => `${r.verdict === "别用" ? "✗" : r.verdict === "可用" ? "✓" : "△"} ${r.name}${r.kind ? `（${r.kind}）` : ""}\n  ${r.reason}`).join("\n\n")}` }];
      },
    },
    async execute(args) {
      const err = titleErr(args?.title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const ws = await root();
      const bookBase = bookPaths(ws, args.title).base;
      const context = bookContext(await fs.readFile(bookPaths(ws, args.title).concept, "utf8").catch(() => ""));
      if (!context.dontWant && !context.genre && !context.core) {
        return { ok: false, stage: "no-concept", detail: "这本书还没有构想快照，扫榜没有依据。先落构想七要素。" };
      }
      const wanted = Array.isArray(args?.mechanismIds) && args.mechanismIds.length > 0 ? new Set(args.mechanismIds) : null;
      const sources = await fs.readdir(path.join(ws, LAYOUT.studio ?? "书房", "参考")).catch(() => []);
      const pool = [];
      for (const sid of sources) {
        if (args?.sourceId && sid !== args.sourceId) continue;
        const all = await listMechanisms(ws, sid);
        for (const m of all) if (!wanted || wanted.has(m.id)) pool.push(m);
      }
      if (pool.length === 0) {
        return { ok: false, stage: "no-mechanisms", detail: wanted ? "指定的机制 id 一个都没找到。" : "还没有拆出机制。先跑拆书管道。" };
      }
      const s = scanMechanisms(pool, context);
      return { ok: true, total: s.total, tally: s.tally, rows: s.rows };
    },
    presentCall: (a) => ({ card: "generic", title: "扫榜", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_ai_flavor_scan ──────────────────────────────────────────────
  const scanFlavorTool = {
    name: "forge_ai_flavor_scan",
    description:
      "去 AI 味：机械可查的五类判据（排比堆砌、总结句标志、情绪直述、万能形容词、对称句式），" +
      "产出**可定位到行**的清单。纯函数，不调模型，同一段文本两次检测结果完全一致。" +
      "只报不改——这里绝不碰正文一个字，改不改由作者或改稿子代理决定。" +
      "给 sourceText 查这段文本；否则查本章的待审稿。五类判据覆盖不了 AI 味的全部，检测不出来不等于写得对。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", description: "章号；与 sourceText 二选一" },
      sourceText: { type: "string", description: "直接要检测的文本；给了就优先用它" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          origin: { type: "string", required: true },
          sentences: { type: "integer", required: true },
          lines: { type: "integer", required: true },
          total: { type: "integer", required: true },
          byKind: { type: "object", additionalProperties: false, properties: { parallel: { type: "integer" }, summary: { type: "integer" }, emotion: { type: "integer" }, filler: { type: "integer" }, symmetry: { type: "integer" } } },
          groups: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { line: { type: "integer", required: true }, text: { type: "string", required: true }, kinds: { type: "array", required: true, items: { type: "string" } }, notes: { type: "array", required: true, items: { type: "string" } } } } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `检测失败（${v.stage}）：${v.detail}` }];
        if (v.total === 0) return [{ type: "text", text: `${v.origin}：${v.lines} 行、${v.sentences} 句，五类判据都没命中。\n检测不出来不等于写得对——这五类只覆盖机械可查的部分。` }];
        return [{ type: "text", text: `${v.origin}：命中 ${v.total} 处\n\n${v.groups.map((g) => `第 ${g.line} 行　${g.text}\n  ${g.notes.map((n, i) => `${g.kinds[i]}：${n}`).join("\n  ")}`).join("\n\n")}\n\n只报不改。改不改、怎么改由你或改稿子代理决定。` }];
      },
    },
    async execute(args) {
      const err = titleErr(args?.title);
      if (err) return { ok: false, stage: "validate-title", detail: err };
      const ws = await root();
      const explicit = String(args?.sourceText ?? "");
      if (explicit !== "") {
        const r = detectAiFlavor(explicit);
        return { ok: true, origin: "所给文本", ...summarize(r) };
      }
      if (!Number.isInteger(args?.chapter) || args.chapter < 1) {
        return { ok: false, stage: "need-text", detail: "要么给 sourceText 直接查，要么给章号查该章待审稿。" };
      }
      // 状态是按 ch0001 这种键存的，不是按章号存的。以前这里直接传 args.chapter，
      // 目录名对不上，永远查不到状态——「查该章待审稿」这条路从来没走通过。
      const key = chapterKey(args.chapter);
      const state = await readState(ws, args.title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `第 ${args.chapter} 章还没有建过状态。` };
      // 稿子记在 state.draft.latest，是相对本章草稿目录的路径（稿件/vN.md）。
      // 以前读的是 state.draftPath —— 这个字段压根不存在，于是退化成 state.draft
      // 这个对象，再当路径用。
      const rel = state.draft?.latest ?? null;
      if (!rel) return { ok: false, stage: "no-draft", detail: `第 ${args.chapter} 章还没有待审稿（当前阶段：${state.stage}）。` };
      const file = path.join(chapterDir(ws, args.title, key), rel);
      const text = await fs.readFile(file, "utf8").catch(() => "");
      if (text === "") return { ok: false, stage: "unreadable", detail: `读不到待审稿：${path.relative(ws, file).replace(/\\/g, "/")}` };
      const r = detectAiFlavor(text);
      return { ok: true, origin: `第 ${args.chapter} 章待审稿`, ...summarize(r) };
    },
    presentCall: (a) => ({ card: "generic", title: "去 AI 味检测", kind: "other", rawInput: a ?? {} }),
  };

  function summarize(r) {
    const groups = groupByLine(r).map((g) => ({
      line: g.line,
      text: g.text,
      kinds: g.hits.map((h) => h.name),
      notes: g.hits.map((h) => h.why),
    }));
    return { sentences: r.sentences, lines: r.lines, total: r.total, byKind: r.byKind, groups };
  }

  return [addTool, listTool, scanTool, scanFlavorTool];
}
