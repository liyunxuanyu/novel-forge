/** 开书 fan-out 工具层。 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACTS, ARTIFACT_BY_ID, planRounds, pendingArtifacts, consistencyCheck,
  candidatePath, confirmArtifact, buildArtifactPrompt, truthContext,
} from "./fanout.js";
import { runFanout } from "./dispatch.js";
import { validateTitle } from "./warehouse.js";

const OK_FAIL = { ok: { type: "boolean", required: true }, stage: { type: "string" }, detail: { type: "string" } };
const DRAFT_AREA = "草稿";

export function fanoutTools(ctx, resolveRoot, getEngine = () => ctx.get?.("workflowEngine")) {
  const root = async () => {
    const r = resolveRoot();
    if (!r) throw new Error("当前会话没有有效工作区。");
    return r;
  };
  const titleOf = (t) => {
    const err = validateTitle(String(t ?? "").trim());
    return err ? null : String(t).trim();
  };

  // ── forge_fanout_plan ────────────────────────────────────────────────
  const planTool = {
    name: "forge_fanout_plan",
    description:
      "开书 fan-out 计划：整套设计工件（故事骨架 / 分卷布局 / 世界书 / 首卷规划）的依赖图，" +
      "以及此刻哪些能立刻派、哪些在等前置。同一层的互不依赖，可以并行跑。" +
      "已落真源的不会重复派——重跑是幂等的。开书前先调它。",
    parameters: { title: { type: "string", required: true, description: "书名" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          rounds: { type: "array", required: true, items: { type: "array", items: { type: "string" } } },
          landed: { type: "array", required: true, items: { type: "string" } },
          ready: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true }, name: { type: "string", required: true },
                role: { type: "string", required: true }, target: { type: "string", required: true },
                outputHint: { type: "string", required: true },
              },
            },
          },
          blocked: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true }, name: { type: "string", required: true },
                waitingOn: { type: "array", required: true, items: { type: "string" } },
              },
            },
          },
          allDone: { type: "boolean", required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `查 fan-out 计划失败（${v.stage}）：${v.detail}` }];
        const lines = v.rounds.map((r, i) => `  第 ${i + 1} 轮（可并行）：${r.join(" / ")}`);
        const head = `设计工件共 ${v.rounds.flat().length} 件，已落真源 ${v.landed.length} 件\n依赖顺序：\n${lines.join("\n")}`;
        if (v.allDone) return [{ type: "text", text: `${head}\n全部工件已落真源，开书设计面完成。` }];
        const ready = v.ready.map((r) => `  ✔ 可派：${r.name}（${r.role}）`).join("\n");
        const blocked = v.blocked.map((b) => `  ✖ 卡着：${b.name}，等 ${b.waitingOn.join("、")}`).join("\n");
        return [{ type: "text", text: `${head}\n\n${ready || "（没有可派发的）"}\n${blocked || ""}` }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const ws = await root();
      const p = await pendingArtifacts(ws, title);
      const { rounds } = planRounds();
      return { ok: true, ...p, rounds, allDone: p.ready.length === 0 && p.blocked.length === 0 };
    },
    presentCall: (a) => ({ card: "generic", title: "开书：fan-out 计划", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_fanout_run ─────────────────────────────────────────────────
  const runTool = {
    name: "forge_fanout_run",
    description:
      "并行派发此刻所有就绪的设计工件。一次失败不影响其余——成功的照常返回，" +
      "失败的带工件名与原因单列，补派哪一件由你决定。产出只是文本，落真源要先经 forge_artifact_candidate。",
    parameters: { title: { type: "string", required: true, description: "书名" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          degraded: { type: "boolean", required: true },
          dispatched: { type: "array", required: true, items: { type: "string" } },
          done: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: { id: { type: "string", required: true }, text: { type: "string", required: true } },
            },
          },
          failed: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: { id: { type: "string", required: true }, reason: { type: "string" } },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `fan-out 没跑成（${v.stage}）：${v.detail}` }];
        const ok = v.done.map((d) => `${d.id}（${d.text.length} 字）`).join("、");
        const bad = v.failed.map((f) => `${f.id}（${f.reason}）`).join("、");
        return [{ type: "text", text: `派发 ${v.dispatched.length} 件设计工件：\n成功：${ok}${bad ? `\n失败：${bad}` : ""}\n产出还没进真源——逐件经 forge_artifact_candidate 落候选，作者确认后 forge_confirm_artifact 入档。` }];
      },
    },
    async execute(args, exec) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const ws = await root();

      const p = await pendingArtifacts(ws, title);
      if (p.ready.length === 0) {
        return { ok: false, stage: "nothing-ready", done: [], failed: [], dispatched: [],
          detail: p.landed.length === 0
            ? "没有任何工件就绪。骨架应该第一个派，检查这本书是否已建。"
            : "全部工件都已落真源，没有可派的了。" };
      }

      const jobs = [];
      for (const item of p.ready) {
        const artifact = ARTIFACT_BY_ID[item.id];
        const ctx = await truthContext(ws, title, artifact);
        jobs.push({ id: item.id, prompt: buildArtifactPrompt(artifact, { book: title, ...ctx }) });
      }
      const r = await runFanout(getEngine(), { jobs, parent: exec?.agent, signal: exec?.signal });
      return { dispatched: jobs.map((j) => j.id), done: [], failed: [], ...r };
    },
    presentCall: (a) => ({ card: "generic", title: "开书：并行派发设计工件", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_artifact_candidate ─────────────────────────────────────────
  const candidateTool = {
    name: "forge_artifact_candidate",
    description:
      "把子代理产出的一份设计工件落成候选（草稿区）。真源一个字都不会动——" +
      "作者看过、确认了，才用 forge_confirm_artifact 入档并产生 design: 提交。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      artifact: { type: "string", required: true, description: `工件 id：${ARTIFACTS.map((a) => a.id).join(" / ")}` },
      body: { type: "string", required: true, description: "工件正文" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { ...OK_FAIL, artifact: { type: "string", required: true }, chars: { type: "integer", required: true }, path: { type: "string", required: true } },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.artifact} 候选已落草稿区（${v.chars} 字）\n真源未动。确认后调 forge_confirm_artifact 入档。` : `落候选失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const id = String(args?.artifact ?? "");
      if (!ARTIFACT_BY_ID[id]) return { ok: false, stage: "unknown-artifact", detail: `没有叫 ${id} 的工件。可选：${ARTIFACTS.map((a) => a.id).join(" / ")}` };

      const body = String(args?.body ?? "");
      if (body.trim() === "") return { ok: false, stage: "empty-body", detail: "内容是空的。" };

      const abs = path.join(ws, candidatePath(ws, title, id));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body, "utf8");
      return { ok: true, artifact: id, chars: body.length, path: `${DRAFT_AREA}/${title}/候选/${id}.md` };
    },
    presentCall: (a) => ({ card: "generic", title: "设计工件落候选", kind: "other", rawInput: { title: a?.title, artifact: a?.artifact } }),
  };

  // ── forge_confirm_artifact ───────────────────────────────────────────
  const confirmTool = {
    name: "forge_confirm_artifact",
    description:
      "确认一份设计工件：落真源并做一次 design: 提交。世界书会按「## 类型｜名称」拆成多份条目。" +
      "省略 body 则取草稿区里的候选。作者没看过就确认，等于绕过门禁。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      artifact: { type: "string", required: true, description: `工件 id：${ARTIFACTS.map((a) => a.id).join(" / ")}` },
      body: { type: "string", description: "工件正文。省略则取候选。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL, artifact: { type: "string", required: true }, name: { type: "string", required: true },
          files: { type: "array", required: true, items: { type: "string" } }, commit: { type: "string", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.name} 已落真源：${v.files.join("、")}\n提交 ${v.commit.slice(0, 8)}` : `确认失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const id = String(args?.artifact ?? "");
      if (!ARTIFACT_BY_ID[id]) return { ok: false, stage: "unknown-artifact", detail: `没有叫 ${id} 的工件。` };

      let body = String(args?.body ?? "");
      if (body.trim() === "") {
        body = await fs.readFile(path.join(ws, candidatePath(ws, title, id)), "utf8").catch(() => "");
        if (body.trim() === "") {
          return { ok: false, stage: "no-candidate", detail: "草稿区里没有这份候选，也直接没给正文。" };
        }
      }
      const r = await confirmArtifact(ws, title, id, body);
      if (!r.ok) return r;
      return { ok: true, artifact: r.artifact, name: r.name, files: r.files, commit: r.commit };
    },
    presentCall: (a) => ({ card: "generic", title: "确认设计工件入真源", kind: "other", rawInput: { title: a?.title, artifact: a?.artifact } }),
  };

  // ── forge_consistency_check ──────────────────────────────────────────
  const checkTool = {
    name: "forge_consistency_check",
    description:
      "核对故事骨架与世界书对不对得上：骨架「## 索引」里提到的每个实体，世界书里都得有条目。" +
      "缺条目、类型对不上、世界书里多出来的，都报出来。骨架与世界书是并行生成的，" +
      "这一步是它们唯一的对齐机会——世界书落真源后跑一次。",
    parameters: { title: { type: "string", required: true, description: "书名" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          consistent: { type: "boolean", required: true },
          indexCount: { type: "integer", required: true },
          worldbookCount: { type: "integer", required: true },
          detail: { type: "string", required: true },
          missing: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { type: { type: "string" }, name: { type: "string", required: true } } } },
          typeMismatch: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { type: { type: "string" }, name: { type: "string", required: true }, note: { type: "string" } } } },
          extra: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { type: { type: "string" }, name: { type: "string", required: true } } } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `一致性核对失败（${v.stage}）：${v.detail}` }];
        if (v.consistent) return [{ type: "text", text: `一致：${v.detail}` }];
        const lines = [];
        if (v.missing.length) lines.push(`缺失 ${v.missing.length} 个：${v.missing.map((m) => `${m.type}／${m.name}`).join("、")}`);
        if (v.typeMismatch.length) lines.push(`类型不符 ${v.typeMismatch.length} 个：${v.typeMismatch.map((m) => m.name).join("、")}`);
        if (v.extra.length) lines.push(`世界书多出 ${v.extra.length} 个：${v.extra.map((m) => m.name).join("、")}`);
        return [{ type: "text", text: `骨架与世界观对不上：${v.detail}\n${lines.join("\n")}` }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const r = await consistencyCheck(await root(), title);
      if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };
      return { ok: true, consistent: r.consistent, indexCount: r.indexCount, worldbookCount: r.worldbookCount, detail: r.detail, missing: r.missing, typeMismatch: r.typeMismatch, extra: r.extra };
    },
    presentCall: (a) => ({ card: "generic", title: "核对骨架与世界书", kind: "other", rawInput: a ?? {} }),
  };

  return [planTool, runTool, candidateTool, confirmTool, checkTool];
}

