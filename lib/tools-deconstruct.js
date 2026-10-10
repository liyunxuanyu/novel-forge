/** 拆书管道工具层。机制只进书房，不进书仓。 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  MECHANISM_KINDS, BASIS_KINDS,
  importSource, listSources, setPlan, getProgress, getConsent, grantConsent,
  readLines, recordBatch, listMechanisms, bumpVersion,
  numberLines, buildBatchPrompt, extractJsonArray,
} from "./deconstruct.js";
import { runFanout, DEFAULT_SUBAGENT_MAX_TOKENS } from "./dispatch.js";
import { LAYOUT } from "./warehouse.js";

const OK_FAIL = { ok: { type: "boolean", required: true }, stage: { type: "string" }, detail: { type: "string" } };

export function deconstructTools(ctx, resolveRoot, getRuntime = () => ({ engine: ctx.get?.("workflowEngine"), subagents: ctx.get?.("subagents"), maxTokens: DEFAULT_SUBAGENT_MAX_TOKENS })) {
  const root = async () => {
    const r = resolveRoot();
    if (!r) throw new Error("当前会话没有有效工作区。");
    return r;
  };
  const badId = (id) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id ?? ""))) {
      return "参考库 id 只能用字母数字下划线横线，1–64 位。";
    }
    return null;
  };

  // ── forge_ref_import ──────────────────────────────────────────────────
  const importTool = {
    name: "forge_ref_import",
    description:
      "导入一本要拆的参考小说原文。只存本地副本，不下载、不接平台账户、不做权利保证。" +
      "必须交代作品、作者/译者、版本、取得来源、允许用途及其依据——" +
      "声明为「可核对许可」却拿不出可核对的东西会被拒，选「用户声明」是诚实的。",
    parameters: {
      sourceId: { type: "string", required: true, description: "参考库 id，字母数字下划线横线" },
      filename: { type: "string", required: true, description: "原文件名" },
      content: { type: "string", required: true, description: "原文全文" },
      title: { type: "string", required: true, description: "作品名" },
      author: { type: "string", required: true, description: "作者" },
      translator: { type: "string", description: "译者" },
      edition: { type: "string", required: true, description: "版本" },
      acquiredFrom: { type: "string", required: true, description: "取得来源" },
      allowedUses: { type: "string", required: true, description: "允许用途" },
      basis: { type: "string", required: true, description: "依据说明" },
      basisKind: { type: "string", required: true, description: `依据类型：${BASIS_KINDS.join(" / ")}` },
      licenseEvidence: { type: "string", description: "选「可核对许可」时必须给出可核对的东西" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { ...OK_FAIL, sourceId: { type: "string", required: true }, lines: { type: "integer", required: true }, chars: { type: "integer", required: true }, basisKind: { type: "string", required: true }, path: { type: "string", required: true } },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `已导入《${v.sourceId}》：${v.lines} 行 / ${v.chars} 字，依据类型「${v.basisKind}」。\n副本 ${v.path}\n下一步：forge_ref_plan 定拆解范围。` : `导入失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const idErr = badId(args?.sourceId);
      if (idErr) return { ok: false, stage: "bad-source-id", detail: idErr };
      const r = await importSource(await root(), args.sourceId, String(args?.filename ?? ""), args?.content, args ?? {});
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, sourceId: r.sourceId, lines: r.lines, chars: r.chars, basisKind: r.basisKind, path: r.path };
    },
    presentCall: (a) => ({ card: "generic", title: "导入参考小说", kind: "other", rawInput: { sourceId: a?.sourceId, title: a?.title, author: a?.author } }),
  };

  // ── forge_ref_plan ────────────────────────────────────────────────────
  const planTool = {
    name: "forge_ref_plan",
    description:
      "定拆解范围与批次大小。范围会被切成有界批次，一次只做一批。" +
      "改范围会让此前的处理许可自动作废——原文发往哪个服务，得按新范围重新说明。",
    parameters: {
      sourceId: { type: "string", required: true, description: "参考库 id" },
      ranges: {
        type: "array", required: true, description: "要拆的区间，start/end 是行号（从 1 数），闭区间",
        items: { type: "object", additionalProperties: false, properties: { start: { type: "integer", required: true }, end: { type: "integer", required: true } } },
      },
      batchLines: { type: "integer", description: "每批多少行，默认 200" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          batches: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { index: { type: "integer", required: true }, from: { type: "integer", required: true }, to: { type: "integer", required: true } } } },
          consentCleared: { type: "boolean", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `切成 ${v.batches.length} 批：${v.batches.map((b) => `#${b.index} 第 ${b.from}–${b.to} 行`).join("、")}\n${v.consentCleared ? "⚠ 范围变了，之前的处理许可已作废——下一步重新说明原文发给哪个服务。" : ""}` : `定计划失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const idErr = badId(args?.sourceId);
      if (idErr) return { ok: false, stage: "bad-source-id", detail: idErr };
      // 参数层用 start/end（作者读得懂），模块层用 from/to。两层之间这层映射不能少——
      // 少了不会报错，只会静默把每段范围变成 null，然后一路报 bad-range。
      const ranges = (args?.ranges ?? []).map((r) => ({ chapter: null, from: Number(r?.start), to: Number(r?.end) }));
      const r = await setPlan(await root(), args.sourceId, ranges, args?.batchLines ?? 200);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, batches: r.batches, consentCleared: Boolean(r.consentCleared) };
    },
    presentCall: (a) => ({ card: "generic", title: "定拆解范围", kind: "other", rawInput: { sourceId: a?.sourceId } }),
  };

  // ── forge_ref_consent ─────────────────────────────────────────────────
  const consentTool = {
    name: "forge_ref_consent",
    description:
      "说明原文会发给哪个模型服务，由谁允许。这不是走过场——没有它 forge_ref_batch 会直接拒绝执行。" +
      "同服务同范围续拆沿用本次许可；范围一改即作废。",
    parameters: {
      sourceId: { type: "string", required: true, description: "参考库 id" },
      provider: { type: "string", required: true, description: "provider 名" },
      model: { type: "string", required: true, description: "模型名" },
      service: { type: "string", required: true, description: "服务地址或服务商名" },
      note: { type: "string", description: "作者的许可原话或理由" },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ...OK_FAIL, provider: { type: "string", required: true }, model: { type: "string", required: true }, service: { type: "string", required: true }, ranges: { type: "integer", required: true } } },
      render: (_a, v) => [{ type: "text", text: v.ok ? `已记录：原文将发给 ${v.provider}／${v.model}（${v.service}），覆盖 ${v.ranges} 个范围。\n下一步：forge_ref_batch 拆一批。` : `记录许可失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const idErr = badId(args?.sourceId);
      if (idErr) return { ok: false, stage: "bad-source-id", detail: idErr };
      const r = await grantConsent(await root(), args.sourceId, args ?? {});
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, provider: r.consent.provider, model: r.consent.model, service: r.consent.service, ranges: r.consent.scopes.length };
    },
    presentCall: (a) => ({ card: "generic", title: "记录处理许可", kind: "other", rawInput: { sourceId: a?.sourceId, service: a?.service } }),
  };

  // ── forge_ref_status ──────────────────────────────────────────────────
  const statusTool = {
    name: "forge_ref_status",
    description: "查拆书进度：共几批、做完几批、下一批是哪批、已拆出多少条机制。带 sourceId 时只查这一本，不带则列出全部参考库。",
    parameters: { sourceId: { type: "string", description: "参考库 id，省略则列出全部" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          sourceId: { type: "string", required: true },
          totalBatches: { type: "integer", required: true },
          doneBatches: { type: "integer", required: true },
          remaining: { type: "integer", required: true },
          complete: { type: "boolean", required: true },
          version: { type: "integer", required: true },
          mechanismCount: { type: "integer", required: true },
          nextFrom: { type: "integer" }, nextTo: { type: "integer" },
          consented: { type: "boolean", required: true },
          sources: { type: "array", items: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string", required: true }, version: { type: "integer", required: true }, doneBatches: { type: "integer", required: true } } } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `查进度失败（${v.stage}）：${v.detail}` }];
        if (v.sources) return [{ type: "text", text: `参考库 ${v.sources.length} 本：\n${v.sources.map((s) => `  ${s.sourceId}（版本 ${s.version}，已完成 ${s.doneBatches} 批）`).join("\n")}` }];
        const head = `${v.sourceId}：${v.doneBatches}/${v.totalBatches} 批完成，机制 ${v.mechanismCount} 条，版本 ${v.version}`;
        if (v.complete) return [{ type: "text", text: `${head}\n全部拆完了。` }];
        const nxt = `下一批：第 ${v.nextFrom}–${v.nextTo} 行`;
        return [{ type: "text", text: `${head}\n${nxt}${v.consented ? "" : "\n⚠ 还没记录处理许可——先 forge_ref_consent。"}` }];
      },
    },
    async execute(args) {
      const ws = await root();
      if (!args?.sourceId) return { ok: true, sourceId: "(全部)", sources: await listSources(ws) };
      const idErr = badId(args.sourceId);
      if (idErr) return { ok: false, stage: "bad-source-id", detail: idErr };
      const p = await getProgress(ws, args.sourceId);
      const consent = await getConsent(ws, args.sourceId);
      return {
        ok: true, sourceId: args.sourceId, totalBatches: p.totalBatches, doneBatches: p.doneBatches,
        remaining: p.remaining, complete: p.complete, version: p.version, mechanismCount: p.mechanismCount,
        nextFrom: p.next?.from, nextTo: p.next?.to, consented: Boolean(consent),
      };
    },
    presentCall: (a) => ({ card: "generic", title: "查拆书进度", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_ref_batch ───────────────────────────────────────────────────
  const batchTool = {
    name: "forge_ref_batch",
    description:
      "拆一批：把本批原文带绝对行号派给子代理，收回机制后逐条回原文核证。" +
      "摘录对不上的整批作废——编造的机制会把整本拆书带偏。" +
      "一条都不拆出来也算失败：读不出机制就如实报，不要凑数。",
    parameters: { sourceId: { type: "string", required: true, description: "参考库 id" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          batchIndex: { type: "integer" }, from: { type: "integer" }, to: { type: "integer" },
          ids: { type: "array", items: { type: "string" } },
          rejected: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string", required: true }, reason: { type: "string", required: true }, detail: { type: "string" } } } },
          remaining: { type: "integer" }, complete: { type: "boolean" },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `这一批没拆成（${v.stage}）：${v.detail}` }];
        const rej = v.rejected?.length ? `\n被拒 ${v.rejected.length} 条：${v.rejected.map((r) => `${r.name}（${r.reason}）`).join("、")}` : "";
        return [{ type: "text", text: `第 ${v.batchIndex} 批（第 ${v.from}–${v.to} 行）拆出 ${v.ids.length} 条机制：${v.ids.join("、")}${rej}\n剩余 ${v.remaining} 批${v.complete ? "（已全部拆完）" : "。"}` }];
      },
    },
    async execute(args, exec) {
      const idErr = badId(args?.sourceId);
      if (idErr) return { ok: false, stage: "bad-source-id", detail: idErr };
      const ws = await root();
      const sid = args.sourceId;

      const consent = await getConsent(ws, sid);
      if (!consent) return { ok: false, stage: "no-consent", detail: "作者还没许可把原文发给模型服务。先用 forge_ref_consent 说明发往哪个服务、由谁允许。" };

      const prog = await getProgress(ws, sid);
      if (!prog.next) return { ok: false, stage: "all-done", detail: "所有批次都拆完了。" };

      const lines = await readLines(ws, sid);
      if (lines === null) return { ok: false, stage: "no-source", detail: `找不到 ${sid} 的原文。` };

      const sourceMeta = await readSourceMeta(ws, sid);
      const numbered = numberLines(lines, prog.next.from, prog.next.to);
      if (numbered === "") return { ok: false, stage: "empty-batch-text", detail: `第 ${prog.next.from}–${prog.next.to} 行取不到内容。` };

      const prompt = buildBatchPrompt(sourceMeta, prog.next, numbered);
      const rt = getRuntime();
      const r = await runFanout(rt.engine, {
        jobs: [{ id: "batch", prompt }], parent: exec?.agent, signal: exec?.signal, subagents: rt.subagents, maxTokens: rt.maxTokens,
      });
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };

      const text = r.done[0]?.text ?? "";
      const parsed = extractJsonArray(text);
      if (!parsed.ok) {
        return { ok: false, stage: parsed.stage, detail: `${parsed.detail}\n模型输出开头：${text.slice(0, 200)}` };
      }

      const rec = await recordBatch(ws, sid, prog.next.index, parsed.mechanisms);
      if (!rec.ok) {
        return {
          ok: false, stage: rec.stage, detail: rec.detail,
          ...(rec.rejected ? { rejected: rec.rejected } : {}),
        };
      }
      return { ok: true, batchIndex: rec.batchIndex, from: rec.range.from, to: rec.range.to, ids: rec.ids, remaining: rec.remaining, complete: rec.complete };
    },
    presentCall: (a) => ({ card: "generic", title: "拆一批", kind: "other", rawInput: a ?? {} }),
  };

  async function readSourceMeta(ws, sid) {
    const file = path.join(ws, LAYOUT.studio ?? "书房", "参考", sid, "计划.json");
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    try {
      const s = JSON.parse(raw).source ?? {};
      return { title: s.title ?? sid, author: s.author ?? "", translator: s.translator ?? "" };
    } catch {
      return { title: sid, author: "", translator: "" };
    }
  }

  // ── forge_ref_mechanisms ──────────────────────────────────────────────
  const mechTool = {
    name: "forge_ref_mechanisms",
    description:
      "查已拆出的机制，可按类别筛。类别有三：角色向（这类人物怎么推动情节）、" +
      "机制向（这个桥段为什么有效）、结构向（章节与卷怎么排）。每条都带原文定位、适用条件与不适用条件。",
    parameters: {
      sourceId: { type: "string", required: true, description: "参考库 id" },
      kind: { type: "string", description: `类别筛选：${MECHANISM_KINDS.join(" / ")}` },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          count: { type: "integer", required: true },
          mechanisms: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true }, kind: { type: "string", required: true },
                name: { type: "string", required: true }, statement: { type: "string", required: true },
                appliesWhen: { type: "string", required: true }, notAppliesWhen: { type: "string", required: true },
                lineStart: { type: "integer", required: true }, lineEnd: { type: "integer", required: true },
                quote: { type: "string", required: true }, version: { type: "integer", required: true }, status: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `查机制失败（${v.stage}）：${v.detail}` }];
        if (v.mechanisms.length === 0) return [{ type: "text", text: "还没有拆出机制。" }];
        return [{
          type: "text",
          text: `共 ${v.count} 条：\n\n${v.mechanisms.map((m) => `[${m.id}]（${m.kind}·v${m.version}）${m.name}\n  ${m.statement}\n  适用：${m.appliesWhen}\n  别用：${m.notAppliesWhen}\n  原文：第 ${m.lineStart}–${m.lineEnd} 行「${m.quote}」`).join("\n\n")}`,
        }];
      },
    },
    async execute(args) {
      const idErr = badId(args?.sourceId);
      if (idErr) return { ok: false, stage: "bad-source-id", detail: idErr };
      if (args?.kind && !MECHANISM_KINDS.includes(args.kind)) {
        return { ok: false, stage: "bad-kind", detail: `类别只能是 ${MECHANISM_KINDS.join(" / ")}。` };
      }
      const ms = await listMechanisms(await root(), args.sourceId, { kind: args?.kind });
      return {
        ok: true, count: ms.length,
        mechanisms: ms.map((m) => ({
          id: m.id, kind: m.kind, name: m.name, statement: m.statement,
          appliesWhen: m.appliesWhen, notAppliesWhen: m.notAppliesWhen,
          lineStart: m.evidence.lineStart, lineEnd: m.evidence.lineEnd, quote: m.evidence.quote,
          version: m.version, status: m.status,
        })),
      };
    },
    presentCall: (a) => ({ card: "generic", title: "查写作机制", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_ref_redeconstruct ───────────────────────────────────────────
  const redoTool = {
    name: "forge_ref_redeconstruct",
    description:
      "重拆这本参考：版本 +1，进度清零重来。必须写理由——为什么这次的结论和上次不一样。" +
      "旧版本机制不删：当初怎么想的要留着，才能看出改了什么。",
    parameters: {
      sourceId: { type: "string", required: true, description: "参考库 id" },
      reason: { type: "string", required: true, description: "重拆理由" },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ...OK_FAIL, version: { type: "integer", required: true }, previous: { type: "integer", required: true } } },
      render: (_a, v) => [{ type: "text", text: v.ok ? `版本 ${v.previous} → ${v.version}。旧机制保留，重拆从头开始。` : `重拆被拒（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const idErr = badId(args?.sourceId);
      if (idErr) return { ok: false, stage: "bad-source-id", detail: idErr };
      const r = await bumpVersion(await root(), args.sourceId, args?.reason);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, version: r.version, previous: r.previous };
    },
    presentCall: (a) => ({ card: "generic", title: "重拆参考小说", kind: "other", rawInput: a ?? {} }),
  };

  return [importTool, planTool, consentTool, statusTool, batchTool, mechTool, redoTool];
}
