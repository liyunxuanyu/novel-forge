/** 自动导演工具层：查下一步、生成施工单、卷结算。 */
import { nextAction, deriveState, parallelPlan, buildTaskSpec, markVolumeSettled, evaluate } from "./director.js";
import { runRound, buildPrompts, DEFAULT_SUBAGENT_MAX_TOKENS } from "./dispatch.js";
import { autoFillContext } from "./director-context.js";
import { validateTitle, bookStatus } from "./warehouse.js";
import { recordDraftTask, chapterKey, importDraft, dispatchReview, readState } from "./chapter-state.js";

const OK_FAIL = { ok: { type: "boolean", required: true }, stage: { type: "string" }, detail: { type: "string" } };

/**
 * 把改稿者留下的 `〔未处置〕` 说明从正文里摘出来。
 *
 * 改稿者被要求「〔硬〕优先于发现项」，两条都不能满足时用一行〔未处置〕说明哪条
 * 发现项撞了哪条〔硬〕。这是给作者看的话，不是正文——但它只有返回值这一个渠道，
 * 不摘就会一路走进定稿：真机上第 1 章 v4 的末行就是它。
 *
 * 只在**结尾**找：正文中间出现「〔未处置〕」多半是角色对话或引文，不能误删。
 * 返回的 body 保证非空——摘干净了就把原样还回去，宁可带一条说明，
 * 也不能把整篇正文变成空字符串（那会让 importDraft 报 empty-body，稿子白写）。
 */
export function liftUnresolved(text) {
  const raw = String(text ?? "");
  const lines = raw.split("\n");
  let cut = lines.length;
  const notes = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") {
      // 允许说明与正文之间夹空行，但空行本身不阻止继续往上找。
      if (notes.length === 0) continue;
      cut = i;
      continue;
    }
    if (line.startsWith("〔未处置〕")) {
      notes.unshift(line.slice("〔未处置〕".length).trim());
      cut = i;
      continue;
    }
    break;
  }
  if (notes.length === 0) return { body: raw, notes: [] };
  const body = lines.slice(0, cut).join("\n").replace(/\s+$/, "");
  // 摘干净了（正文只有一条说明）就把原样还回去：宁可让长度闸门去报「太短」，
  // 也不能把正文变成空字符串——那会让 importDraft 报 empty-body，稿子白写。
  // 但 notes 照样带回去：说明本身不能因为兜底而消失。
  if (body.trim() === "") return { body: raw, notes };
  return { body, notes };
}

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
          // buildTaskSpec 的成功分支一直返回 chapter（director.js:455），
          // 但失败分支（missing-input）不返回——于是真机上只要这一步一直失败，
          // 这个字段就永远不被校验。自动取材把成功路径打通之后，真机立刻报
          // 「value.chapter is not a declared property」。见 stages.md。
          chapter: { type: "integer" },
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
          // runRound 的成功形状里一直有 stopReason（dispatch.js:242 与 :354：
          // 引擎路径回 result.stopReason，subagents 路径回 null），
          // 但只有**真的派出子代理**才会走到那一行——离线时这一步一直停在
          // gate-stopped / missing-input 的失败分支上，于是真机报
          // 「value.stopReason is not a declared property」。
          // 只有 completed 算正常收场，所以这个字段是给作者看的，不能吞掉。
          stopReason: { oneOf: [{ type: "string" }, { type: "null" }] },
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
      // 起草这一步得先把目标字数落进章节状态。导演链以前绕过 forge_draft_task，
      // draftTask.built 一直是 false，于是导入时 checkChapterLength 拿不到 target、
      // **静默放行**——试跑时 2124 字的稿子对着 3000 字的软约束一路绿灯。
      // 取出来就别再塞回 prompt，施工单只认它声明过的字段。
      const draftTask = ctx.__draftTask;
      delete ctx.__draftTask;
      const spec = buildTaskSpec(a, ctx);
      if (!spec.ok) return spec;
      if (!spec.needsModel) return { ok: true, needsModel: false, detail: spec.outputHint };

      if (a.step === "draft" && draftTask) {
        const rec = await recordDraftTask(ws, title, chapterKey(a.chapter), a.volume, draftTask);
        // 不能直接 return rec：advance 的失败形状里带着 state，而本工具的
        // 返回值是 additionalProperties:false —— 多一个字段，宿主就把
        // **整次调用**判成 invalid output。结构化失败也要按本工具的形状给。
        if (!rec.ok) {
          return { ok: false, stage: rec.stage, detail: rec.detail, degraded: false, done: [], failed: [] };
        }
      }

      // 审读这一步以前也只跑子代理、不声明「审读已派出」：跑完状态还停在
      // 「待审」，而 forge_record_findings 只在「审读中／待改／待定稿」下可执行
      // ——于是每轮审读之后都得有人手动补一次 forge_dispatch_review，
      // 补漏了整轮发现项全被挡在门外。派审读是这一步自己的事。
      //
      // 已经在「审读中」就不要再派一次：那是崩溃后按真源重跑的恢复路径，
      // advance 本来就会拒（from 不含审读中），硬派还会把轮次重复计一遍。
      if (a.step === "review") {
        const st = await readState(ws, title, chapterKey(a.chapter));
        if (st?.stage === "待审") {
          const d = await dispatchReview(ws, title, chapterKey(a.chapter), a.volume, { dimensions: args?.dimensions });
          if (!d.ok) {
            return { ok: false, stage: d.stage, detail: d.detail, degraded: false, done: [], failed: [] };
          }
        }
      }

      const split = buildPrompts(spec, { dimensions: args?.dimensions });
      const rt = getRuntime();
      const r = await runRound(rt.engine, {
        label: spec.step, prompt: spec.prompt, prompts: split.prompts, mode: split.mode,
        parent: exec?.agent, signal: exec?.signal, subagents: rt.subagents, maxTokens: rt.maxTokens,
      });
      const out = { done: [], failed: [], ...r };

      // 起草和改稿**都**交出整篇正文，所以都得落盘。以前两者都没落：子代理把
      // 正文交回来了，导演原样转给调用方就算完事，而下一条规则要的正是
      // state.draft.latest（审读子代理读的是盘上的稿）——于是每章每轮都得有人
      // 手动补一次 forge_import_draft，所谓「全自动导演」每一步都要人工搬稿。
      // 改稿这一跳尤其毒：不落盘的话 latest 还指着上一版，再审一轮等于把已经
      // 改掉的问题重新报一遍，而改稿子代理的产出根本没人看过。
      // 落稿只有一份实现（chapter-state.importDraft），这里替调用方按下去。
      if ((a.step === "draft" || a.step === "revise") && out.done.length === 1) {
        const who = a.step === "draft" ? "起草子代理" : "改稿子代理";
        // 改稿者被要求「〔硬〕优先于发现项」，两条都不能满足时用一行〔未处置〕说明。
        // 那是给作者看的话，**不是正文**——但它只能搭着返回值回来，所以必须在这里
        // 摘出来，否则它会一路走进定稿（真机上第 1 章 v4 的末行就是它）。
        // 摘出来的内容不能丢：放进 detail 报给调用方，由它决定要不要记成质量债。
        const lifted = liftUnresolved(out.done[0]);
        const imp = await importDraft(ws, title, chapterKey(a.chapter), a.volume, {
          body: lifted.body,
          origin: `${who}（导演链自动落稿）`,
        });
        if (!imp.ok) {
          // 子代理成功了、落稿失败了 —— 这一步的目的没达到，就不能报成功。
          // 但正文仍在 done 里，一个字都没丢，调用方可以直接补一次导入。
          out.ok = false;
          out.stage = `import-${imp.stage}`;
          out.detail = `${who}交回了正文，但自动落稿失败：${imp.detail}。正文仍在 done 里，没有丢。`;
          out.degraded = true;
          return out;
        }
        out.detail = `${out.detail}；已自动落稿 v${imp.version}（${imp.words} 字）${imp.short ? "，⚠ 不足目标字数一半" : ""}`;
        if (lifted.notes.length > 0) {
          out.detail = `${out.detail}；改稿者留下 ${lifted.notes.length} 条未处置说明（未写进正文）：${lifted.notes.join(" ／ ")}`;
        }
      }
      return out;
    },
    presentCall: (a) => ({ card: "generic", title: "导演：跑一轮", kind: "other", rawInput: { title: a?.title } }),
  };

  return [nextTool, planTool, runTool, settleVolumeTool];
}
