/** 自动导演工具层：查下一步、生成施工单、卷结算。 */
import { nextAction, deriveState, parallelPlan, buildTaskSpec, markVolumeSettled, evaluate } from "./director.js";
import { runRound, buildPrompts, DEFAULT_SUBAGENT_MAX_TOKENS } from "./dispatch.js";
import { autoFillContext } from "./director-context.js";
import { validateTitle, bookStatus } from "./warehouse.js";

const OK_FAIL = { ok: { type: "boolean", required: true }, stage: { type: "string" }, detail: { type: "string" } };

export function directorTools(ctx, resolveRoot, getRuntime = () => ({ engine: ctx.get?.("workflowEngine"), subagents: ctx.get?.("subagents"), maxTokens: DEFAULT_SUBAGENT_MAX_TOKENS })) {
  const root = async () => {
    const r = resolveRoot();
    if (!r) throw new Error("当前会话没有有效工作区。");
    return r;
  };
  const titleOf = (t) => {
    const err = validateTitle(String(t ?? "").trim());
    return err ? null : String(t).trim();
  };

  // ── forge_director_next ──────────────────────────────────────────────
  const nextTool = {
    name: "forge_director_next",
    description:
      "导演的当前判断：这本书此刻该做什么、落在哪个流程节点、门禁允不允许自动往下走。" +
      "结论完全由书仓（Git）推导，不依赖任何会话记忆——中断后重调一次结果相同。" +
      "要停就返回该问作者的问题与可选动作，不要自己决定。",
    parameters: { title: { type: "string", required: true, description: "书名" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          node: { type: "string", required: true },
          kind: { type: "string", required: true },
          step: { oneOf: [{ type: "string" }, { type: "null" }] },
          rule: { type: "string", required: true },
          chapter: { type: "integer", required: true },
          volume: { type: "integer" },
          level: { type: "string", required: true },
          proceed: { type: "boolean", required: true },
          reason: { type: "string", required: true },
          finalizedChapterCount: { type: "integer", required: true },
          openDebts: { type: "integer", required: true },
          question: { oneOf: [{ type: "string" }, { type: "null" }] },
          options: { type: "array", items: { type: "string" } },
          defaultOption: { oneOf: [{ type: "string" }, { type: "null" }] },
          canFanOut: { type: "boolean", required: true },
          fanOutSteps: { type: "array", required: true, items: { type: "string" } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `导演判断失败（${v.stage}）：${v.detail}` }];
        const head = `下一步：${v.node}${v.step ? `（${v.step}）` : ""}｜第 ${v.chapter} 章｜已定稿 ${v.finalizedChapterCount} 章｜未清质量债 ${v.openDebts} 条`;
        if (v.proceed) {
          return [{ type: "text", text: `${head}\n${v.level} 级，自动推进：${v.reason}${v.canFanOut ? `\n可并行排开：${v.fanOutSteps.join(" → ")}` : ""}` }];
        }
        const lines = [head, `${v.level} 级门禁，必须作者拍板：`, v.reason];
        if (v.question) lines.push(`问：${v.question}`);
        if (v.options?.length) lines.push(`可选：${v.options.join(" / ")}${v.defaultOption ? `（默认：${v.defaultOption}）` : ""}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const a = await nextAction(await root(), title);
      if (!a.ok) return a;
      const plan = parallelPlan(a);
      return {
        ok: true, node: a.node, kind: a.kind, step: a.step ?? null, rule: a.rule,
        chapter: a.chapter, volume: a.volume, level: a.gate.level, proceed: a.proceed, reason: a.reason,
        finalizedChapterCount: a.finalizedChapterCount, openDebts: a.openDebts,
        question: a.gate.decisions[0]?.question ?? null,
        options: a.gate.decisions[0]?.options ?? [],
        defaultOption: a.gate.defaultOption,
        canFanOut: plan.canFanOut, fanOutSteps: plan.steps,
      };
    },
    presentCall: (a) => ({ card: "generic", title: "导演：下一步", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_director_plan ──────────────────────────────────────────────
  const planTool = {
    name: "forge_director_plan",
    description:
      "生成这一步的施工单：派哪个子代理、给它什么自包含的任务文本、要它交回什么格式。" +
      "纯工具步骤（备料、定稿）会明说不需要子代理。任务文本可直接派发，不需要再加工。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      context: {
        type: "object", description: "要嵌进任务文本的真源内容。子代理没有会话记忆，缺了它就写不对。",
        additionalProperties: true,
        properties: {
          outlineBrief: { type: "string" }, volumePlan: { type: "string" }, prevChapter: { type: "string" },
          contract: { type: "string" }, foreshadow: { type: "string" }, taskText: { type: "string" },
          draftText: { type: "string" }, dimensions: { type: "array", items: { type: "string" } },
          findings: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          node: { type: "string", required: true },
          step: { oneOf: [{ type: "string" }, { type: "null" }] },
          needsModel: { type: "boolean", required: true },
          role: { type: "string" },
          prompt: { type: "string" },
          outputHint: { type: "string", required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `生成施工单失败（${v.stage}）：${v.detail}` }];
        if (!v.needsModel) return [{ type: "text", text: `${v.node} 不需要子代理：${v.outputHint}` }];
        return [{ type: "text", text: `派「${v.role}」，交回：${v.outputHint}\n\n任务文本已生成（${v.prompt.length} 字），可直接派发。` }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const ws = await root();
      const a = await nextAction(ws, title);
      if (!a.ok) return a;
      if (!a.proceed) {
        return {
          ok: false, stage: "gate-stopped",
          detail: `${a.node} 是 ${a.gate.level} 级门禁，该问作者而不是派子代理。${a.gate.decisions[0]?.question ?? ""}`,
        };
      }
      // 缺的真源内容自己去书仓取，别要求调用方手喂：卷纲、契约、伏笔、上一章
      // 都在真源里躺着，让调用方复制一遍，复制漏一段子代理就会安静地写错。
      const ctx = await autoFillContext(ws, title, a, args?.context ?? {});
      const spec = buildTaskSpec(a, ctx);
      return { ...spec, node: a.node };
    },
    presentCall: (a) => ({ card: "generic", title: "导演：生成施工单", kind: "other", rawInput: { title: a?.title } }),
  };

  // ── forge_settle_volume ──────────────────────────────────────────────
  const settleVolumeTool = {
    name: "forge_settle_volume",
    description:
      "整卷定稿入档：落 卷账/卷NN/结算.md 并做一次 vol: 提交。" +
      "提交成功导演才会继续下一卷；不结算它会一直提请整卷定稿，不会自己跳过。" +
      "结卷前应先用 forge_debt_gate 确认没有未清质量债。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      volume: { type: "integer", required: true, description: "卷号" },
      summary: { type: "string", description: "本卷复盘，写给以后看的自己" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          volume: { type: "integer", required: true },
          commit: { type: "string" },
          nextStep: { type: "string", required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `卷结算失败（${v.stage}）：${v.detail}` }];
        return [{ type: "text", text: `卷 ${v.volume} 已结算（提交 ${v.commit.slice(0, 8)}）\n接下来：${v.nextStep}` }];
      },
    },
    async execute(args) {
      const ws = await root();
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const volume = Number(args?.volume);
      if (!Number.isInteger(volume) || volume < 1) return { ok: false, stage: "bad-volume", detail: "卷号得是正整数。" };

      const r = await markVolumeSettled(ws, title, volume, String(args?.summary ?? ""));
      if (!r.ok) return r;
      const next = await nextAction(ws, title);
      return { ok: true, volume, commit: r.commit, nextStep: next.ok ? `${next.node}${next.step ? `（${next.step}）` : ""} — ${next.reason}` : next.detail };
    },
    presentCall: (a) => ({ card: "generic", title: "整卷定稿入档", kind: "other", rawInput: { title: a?.title, volume: a?.volume } }),
  };

  // ── forge_director_run ───────────────────────────────────────────────
  const runTool = {
    name: "forge_director_run",
    description:
      "跑一轮：先问门禁（该停就停，绝不替作者决定），放行就派子代理执行这一步。" +
      "审读可按维度并行拆开。单个子代理失败不会毁掉整轮——成功的结果照常落地，" +
      "失败的记进 failed 并把这一轮标为降级，调用方决定是继续还是停下。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      context: {
        type: "object", description: "要嵌进任务文本的真源内容。子代理没有会话记忆，缺了它就写不对。",
        additionalProperties: true,
        properties: {
          outlineBrief: { type: "string" }, volumePlan: { type: "string" }, prevChapter: { type: "string" },
          contract: { type: "string" }, foreshadow: { type: "string" }, taskText: { type: "string" },
          draftText: { type: "string" }, dimensions: { type: "array", items: { type: "string" } },
          findings: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      dimensions: { type: "array", description: "审读维度。只有审读步骤会按它并行拆分。", items: { type: "string" } },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          degraded: { type: "boolean", required: true },
          mode: { type: "string" },
          needsModel: { type: "boolean" },
          done: { type: "array", required: true, items: { type: "string" } },
          failed: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, index: { type: "integer" }, reason: { type: "string" } } } },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `这一轮没跑成（${v.stage}）：${v.detail}${v.failed?.length ? `\n失败明细：${v.failed.map((f) => f.reason).join("；")}` : ""}` }];
        if (v.needsModel === false) return [{ type: "text", text: `这一步是纯工具步骤：${v.detail}` }];
        // 产出正文必须原样交回调用方，否则下一步（落候选 / 导入稿件 / 回写发现项）
        // 拿不到东西——子代理写完了，链子却在交回这一步把它丢掉。
        const bodies = (v.done ?? []).map((t, i) => `\n\n===== 第 ${i + 1} 份 =====\n${t}`).join("");
        return [{ type: "text", text: `${v.mode === "parallel" ? "并行" : "单发"}一轮跑完：${v.detail}${v.degraded ? "\n⚠ 已降级：部分结果缺失，落地前请确认缺了什么。" : ""}${bodies}` }];
      },
    },
    async execute(args, exec) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const ws = await root();

      const a = await nextAction(ws, title);
      if (!a.ok) return a;
      if (!a.proceed) {
        return {
          ok: false, stage: "gate-stopped",
          detail: `${a.node} 是 ${a.gate.level} 级门禁，该问作者而不是替你决定。${a.gate.decisions[0]?.question ?? ""}`,
        };
      }
      const ctx = await autoFillContext(ws, title, a, args?.context ?? {});
      const spec = buildTaskSpec(a, ctx);
      if (!spec.ok) return spec;
      if (!spec.needsModel) return { ok: true, needsModel: false, detail: spec.outputHint };

      const split = buildPrompts(spec, { dimensions: args?.dimensions });
      const rt = getRuntime();
      const r = await runRound(rt.engine, {
        label: spec.step, prompt: spec.prompt, prompts: split.prompts, mode: split.mode,
        parent: exec?.agent, signal: exec?.signal, subagents: rt.subagents, maxTokens: rt.maxTokens,
      });
      return { done: [], failed: [], ...r };
    },
    presentCall: (a) => ({ card: "generic", title: "导演：跑一轮", kind: "other", rawInput: { title: a?.title } }),
  };

  return [nextTool, planTool, runTool, settleVolumeTool];
}
