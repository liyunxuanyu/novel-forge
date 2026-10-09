/**
 * 一轮的执行层。
 *
 * 决策层说"该做什么"，这里负责"把它跑完，并且跑砸了不炸"。
 * 关键约束：单个子代理失败**不许毁掉整轮**——成功的结果照常落地，失败的记下来降级继续。
 * 无人值守的底线在这里：任何一次派发失败都必须变成可读的状态，而不是抛异常打断全书。
 */

/**
 * 派发用的 meta。
 *
 * 真引擎（dsh-workflow-ptc）的 `start()` 第一件事就是 validateMeta：
 * `meta.name` 与 `meta.description` **都**必须是非空字符串，缺一个就同步抛 META_INVALID，
 * 在发布 run 之前就死掉。离线测试用的假引擎不看 meta，所以这个洞能一直绿着。
 */
function runMeta(label) {
  return {
    name: `novel-forge:${label}`,
    description: `Novel Forge 派发「${label}」一轮子代理。`,
  };
}

/** 工作流脚本很薄：任务文本走 args 传，不拼进脚本文本，避免引号与 ${} 被打包。 */
const SCRIPT_SINGLE = `
phase(args.label)
// agent() 失败时 resolve **null**，不是 reject（官方契约明写）。
// 所以不能靠 try/catch 接失败——那永远接不到，会把 null 当成功交出去。
const out = await agent(args.prompt, { label: args.label })
return { done: [out], failed: [] }
`;

const SCRIPT_PARALLEL = `
phase(args.label)
const settled = await parallel(
  args.prompts.map((p, i) => async () => {
    // try/catch 只兜真正抛异常的用法错误（比如给 agent 传了非法 opts）。
    // 子代理**跑砸**是 resolve null，不抛——那一支接不住。
    try {
      const text = await agent(p, { label: args.label + "-" + i })
      if (text === null || text === undefined) {
        return { ok: false, index: i, reason: "子代理没有交回结果（agent 返回空）。" }
      }
      return { ok: true, index: i, text }
    } catch (error) {
      return { ok: false, index: i, reason: String(error?.message ?? error) }
    }
  })
)
return {
  done: settled.filter(Boolean).filter((x) => x.ok).map((x) => x.text),
  failed: settled.filter(Boolean).filter((x) => !x.ok),
}
`;

/**
 * 审读这类多任务步骤按维度拆开并行跑。拆不开就串行跑同一个提示词。
 */
export function buildPrompts(spec, { dimensions } = {}) {
  if (spec.step !== "review" || !Array.isArray(dimensions) || dimensions.length <= 1) {
    return { mode: "single", prompts: [spec.prompt] };
  }
  return {
    mode: "parallel",
    prompts: dimensions.map((dim) =>
      `${spec.prompt}\n\n## 本次只审这一个维度\n${dim}\n\n其他维度本轮不审，你不必评论；但若在这一个维度内发现问题，照常列出。`
    ),
  };
}

/**
 * 派发前确认 parent 真的能用。
 *
 * 真引擎 start() 里会做 `request.parent.session`（再拿它去 resolve 沙箱策略）。
 * 那是硬解引用：parent 一旦是 undefined 就抛 TypeError，错误文本对作者毫无意义。
 * 而 exec.agent 在宿主里**确实可能缺席**——dsh-tools 自己派发时都写
 * `...exec.agent ? { agent: exec.agent } : {}`。计划任务、后台自动跑、
 * 非交互调用都可能没有活的 agent。导演链恰恰是最爱后台自动跑的那个。
 *
 * 在这里就把它挡下来，并说清楚该怎么做（手动触发一次，或让调用方补上 parent）。
 */
function checkParent(parent) {
  if (parent === null || parent === undefined) {
    return {
      ok: false,
      stage: "no-parent",
      detail: "这次派发没有可用的父级 agent（exec.agent 为空），派不出去。" +
        "请在会话里直接触发一次导演动作，或让调用方把 parent 传进来。",
    };
  }
  if (parent.session === null || parent.session === undefined) {
    return {
      ok: false,
      stage: "no-parent",
      detail: "父级 agent 身上没有 session，派不出去；引擎需要 parent.session 才能定沙箱策略。",
    };
  }
  return null;
}

// ── subagents 退路 ────────────────────────────────────────────────────────
//
// 真机实测：本 profile 拿不到 workflowEngine（ctx.get 与 ctx.inject 两条路都
// 试过，服务确实不可达），但 **subagents 服务是可达的**。导演链的最终目的是
// 「派子代理」，PTC 引擎只是其中一条路，所以这里补一条直接走宿主子代理服务的
// 退路，让导演链在这个 profile 上也能跑起来。
//
// 契约照抄 @deepseek-ai/dsh-tool-subagent 的真实用法：
//   const run = await subagents.start(provider, { label, prompt:[{type:"text",text}],
//                                                parent, signal, maxDepth? })
//   const result = await run.result          // { output, stopReason }
//   await run.dispose()                      // 无论成败都要 dispose
// 停止原因的判据照抄它的 stopReasonError()：只有 completed 算成功，
// 其余（aborted / error / max-tokens / refusal）都算失败——
// 判漏了就会把「子代理拒答」当成一份合格产出交回去。

/** 优先 spawn；宿主没列出来就取列表第一个。 */
function pickSubagentProvider(subagents) {
  try {
    const list = typeof subagents.list === "function" ? subagents.list() : [];
    const names = (Array.isArray(list) ? list : [])
      .map((p) => (typeof p === "string" ? p : p?.name))
      .filter((n) => typeof n === "string" && n !== "");
    if (names.includes("spawn")) return "spawn";
    if (names.length > 0) return names[0];
  } catch {
    /* 列表拿不到就按默认 provider 试 */
  }
  return "spawn";
}

/** 照抄 dsh-tool-subagent 的 stopReasonError：只有 completed 返回 null。 */
function subagentStopReasonError(result) {
  switch (result?.stopReason) {
    case "completed": return null;
    case "aborted": return "子代理运行被取消";
    case "error": return "子代理运行失败";
    case "max-tokens": return "子代理在写完前撞到 token 上限";
    case "refusal": return "子代理拒绝了任务";
    default: return `子代理异常结束（${String(result?.stopReason)}）`;
  }
}

/** 派一个子代理并收结果。dispose 放在 finally，且不让它盖掉结果。 */
async function runOneSubagent(subagents, provider, { label, prompt, parent, signal }) {
  const request = {
    label,
    prompt: [{ type: "text", text: prompt }],
    parent,
    ...(signal !== undefined ? { signal } : {}),
  };
  const run = await subagents.start(provider, request);
  try {
    const result = await run.result;
    const reason = subagentStopReasonError(result);
/**
 * SubagentResult.output 是 **ContentBlock[]**，不是字符串。
 *
 * 真机报「value.done[0].text must be a string」才暴露：直接把 output 当文本用，
 * 交回去的是一个数组。正确取法照抄 @deepseek-ai/dsh-tool-subagent:307。
 * 注意不能对数组盲目 join("")——那会得到 "[object Object]" 这种**看起来像文本的垃圾**，
 * 比直接报错危险得多。
 */
function contentBlocksToText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

    const text = contentBlocksToText(result?.output);
    if (reason) return { ok: false, reason, text };
    return { ok: true, text };
  } finally {
    try {
      await run.dispose?.();
    } catch {
      /* 清理失败不该盖掉上面的结果 */
    }
  }
}

/** runRound 的 subagents 版：产出与 PTC 版同形的结果。 */
async function runRoundViaSubagents(subagents, { label, prompt, prompts, mode, parent, signal }) {
  const parentProblem = checkParent(parent);
  if (parentProblem) return parentProblem;
  const provider = pickSubagentProvider(subagents);
  const isParallel = mode === "parallel" && Array.isArray(prompts) && prompts.length > 1;
  const tasks = isParallel ? prompts : [prompt ?? prompts?.[0]];

  try {
    const settled = await Promise.all(
      tasks.map(async (text, i) => {
        const one = { label: isParallel ? `${label}-${i}` : label };
        try {
          return { index: i, ...(await runOneSubagent(subagents, provider, { ...one, prompt: text, parent, signal })) };
        } catch (error) {
          return { index: i, ok: false, reason: String(error?.message ?? error) };
        }
      }),
    );
    // 空白输出当失败，不当成功——与 PTC 版同一条判据。
    const done = settled.filter((x) => x.ok).map((x) => x.text).filter((t) => typeof t !== "string" || t.trim() !== "");
    const failed = settled.filter((x) => !x.ok).map((x) => ({ ok: false, index: x.index, reason: x.reason }));
    if (done.length === 0) {
      return {
        ok: false, degraded: true, stage: "empty-run",
        detail: failed.length > 0 ? failed.map((f) => f.reason).join("；") : "子代理跑完了但一个结果都没交回来。",
        done: [], failed,
      };
    }
    return {
      ok: true,
      degraded: failed.length > 0,
      mode: isParallel ? "parallel" : "single",
      done, failed,
      stopReason: null,
      detail: failed.length > 0
        ? `${done.length} 份成功，${failed.length} 份失败：${failed.map((f) => f.reason).join("；")}`
        : `${done.length} 份全部成功。`,
    };
  } catch (error) {
    return { ok: false, degraded: true, stage: "run-threw", detail: String(error?.message ?? error), done: [], failed: [] };
  }
}

/** runFanout 的 subagents 版：每件工件带回自己的 id。 */
async function runFanoutViaSubagents(subagents, { jobs, label, parent, signal }) {
  const parentProblem = checkParent(parent);
  if (parentProblem) return { ...parentProblem, done: [], failed: [] };
  const provider = pickSubagentProvider(subagents);

  try {
    const settled = await Promise.all(
      jobs.map(async (job) => {
        try {
          const one = await runOneSubagent(subagents, provider, { label: `${label}-${job.id}`, prompt: job.prompt, parent, signal });
          return one.ok ? { id: job.id, ok: true, text: one.text } : { id: job.id, ok: false, reason: one.reason };
        } catch (error) {
          return { id: job.id, ok: false, reason: String(error?.message ?? error) };
        }
      }),
    );
    const done = settled.filter((x) => x.ok).filter((x) => typeof x.text !== "string" || x.text.trim() !== "");
    const failed = settled.filter((x) => !x.ok);
    if (done.length === 0) {
      return {
        ok: false, degraded: true, stage: failed.length > 0 ? "all-failed" : "empty-run",
        detail: failed.length > 0 ? failed.map((f) => `${f.id}：${f.reason}`).join("；") : "子代理跑完了但一件工件都没产出。",
        done: [], failed,
      };
    }
    return {
      ok: true, degraded: failed.length > 0, done, failed,
      detail: failed.length > 0
        ? `${done.map((d) => d.id).join("、")} 成功；${failed.map((f) => `${f.id}（${f.reason}）`).join("、")} 失败。`
        : `${done.length} 件全部成功：${done.map((d) => d.id).join("、")}`,
    };
  } catch (error) {
    return { ok: false, degraded: true, stage: "run-threw", detail: String(error?.message ?? error), done: [], failed: [] };
  }
}

/**
 * 跑一轮。
 * @param engine ctx.workflowEngine（宿主提供）
 * @returns 一律 resolve：失败也返回结构化结果，让调用方能决定是降级还是停下。
 */
export async function runRound(engine, { label, prompt, prompts, mode, parent, signal, subagents }) {
  if (!engine || typeof engine.start !== "function") {
    // 退路：本 profile 拿不到 workflowEngine，但 subagents 服务可达（真机实测）。
    if (subagents && typeof subagents.start === "function") {
      return runRoundViaSubagents(subagents, { label, prompt, prompts, mode, parent, signal });
    }
    return { ok: false, stage: "no-engine", detail: "宿主既没有 workflowEngine，也没有 subagents 服务，无法派子代理。" };
  }
  const parentProblem = checkParent(parent);
  if (parentProblem) return parentProblem;
  const isParallel = mode === "parallel" && Array.isArray(prompts) && prompts.length > 1;
  const script = isParallel ? SCRIPT_PARALLEL : SCRIPT_SINGLE;

  let run;
  try {
    run = engine.start({
      script,
      meta: runMeta(label),
      args: isParallel ? { label, prompts } : { label, prompt: prompt ?? prompts?.[0] },
      parent,
      signal,
    });
  } catch (error) {
    return { ok: false, stage: "start-failed", detail: String(error?.message ?? error) };
  }
  if (!run) return { ok: false, stage: "start-failed", detail: "workflowEngine.start 没返回 run 句柄。" };

  try {
    const result = await run.result;
    const value = result?.value ?? {};
    // 空白输出要当失败，不当成功：审读子代理交白卷时，调用方会拿着
    // 自报的 covered 去凑一次「零发现项空审通过」——整卷就这样带着没审过的章出厂，
    // 而且看上去一切正常。空串比报错危险得多。
    const done = (Array.isArray(value.done) ? value.done : [])
      .filter((x) => x !== null && x !== undefined)
      .filter((x) => (typeof x !== "string") || x.trim() !== "");
    const failed = Array.isArray(value.failed) ? value.failed.filter(Boolean) : [];

    // 引擎层面的非正常停止（例如被取消）也走降级，不往上抛。
    const stopped = result?.stopReason && result.stopReason !== "completed";
    if (stopped && done.length === 0) {
      return {
        ok: false, degraded: true, stage: "run-stopped",
        detail: `工作流以 ${result.stopReason} 结束，没有拿到任何结果。`,
        done: [], failed,
      };
    }
    if (done.length === 0) {
      return {
        ok: false, degraded: true, stage: "empty-run",
        detail: failed.length > 0 ? failed.map((f) => f.reason).join("；") : "工作流跑完了但一个结果都没交回来。",
        done: [], failed,
      };
    }
    return {
      ok: true,
      degraded: failed.length > 0 || Boolean(stopped),
      mode: isParallel ? "parallel" : "single",
      done,
      failed,
      stopReason: result?.stopReason ?? null,
      detail: failed.length > 0
        ? `${done.length} 份成功，${failed.length} 份失败：${failed.map((f) => f.reason).join("；")}`
        : `${done.length} 份全部成功。`,
    };
  } catch (error) {
    return { ok: false, degraded: true, stage: "run-threw", detail: String(error?.message ?? error), done: [], failed: [] };
  } finally {
    try {
      await run.dispose?.();
    } catch {
      /* 清理失败不该盖掉上面的结果 */
    }
  }
}

/**
 * fan-out 专用脚本：每个任务带回自己的 id。
 * 通用并行脚本只回 index，映射回工件身份要靠调用方猜——这里直接带回来。
 */
const FANOUT_SCRIPT = `
phase(args.label)
const settled = await parallel(
  args.jobs.map((job) => async () => {
    // 同上：子代理跑砸是 resolve null，try/catch 接不住，必须显式判 null。
    // 这里不判的话，一件失败的工件会带着 text:null 被当成"已产出"交回。
    try {
      const text = await agent(job.prompt, { label: args.label + "-" + job.id })
      if (text === null || text === undefined) {
        return { id: job.id, ok: false, reason: "子代理没有交回结果（agent 返回空）。" }
      }
      return { id: job.id, ok: true, text }
    } catch (error) {
      return { id: job.id, ok: false, reason: String(error?.message ?? error) }
    }
  })
)
const kept = settled.filter(Boolean)
return { done: kept.filter((x) => x.ok), failed: kept.filter((x) => !x.ok) }
`;

/**
 * 并行派发多个设计工件。
 * 一件失败不影响其余：成功的照常返回，失败的带 id 与原因单列，调用方决定补哪一件。
 */
export async function runFanout(engine, { jobs, label = "fanout", parent, signal, subagents }) {
  if (!engine || typeof engine.start !== "function") {
    if (subagents && typeof subagents.start === "function") {
      return runFanoutViaSubagents(subagents, { jobs, label, parent, signal });
    }
    return { ok: false, stage: "no-engine", detail: "宿主既没有 workflowEngine，也没有 subagents 服务，无法派子代理。", done: [], failed: [] };
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { ok: false, stage: "nothing-to-do", detail: "没有可派发的工件。", done: [], failed: [] };
  }
  const parentProblem = checkParent(parent);
  if (parentProblem) return { ...parentProblem, done: [], failed: [] };

  let run;
  try {
    run = engine.start({ script: FANOUT_SCRIPT, meta: runMeta(label), args: { label, jobs }, parent, signal });
  } catch (error) {
    return { ok: false, stage: "start-failed", detail: String(error?.message ?? error), done: [], failed: [] };
  }
  if (!run) return { ok: false, stage: "start-failed", detail: "workflowEngine.start 没返回 run 句柄。", done: [], failed: [] };

  try {
    const result = await run.result;
    const value = result?.value ?? {};
    const done = (Array.isArray(value.done) ? value.done : [])
      .filter(Boolean)
      .filter((x) => (typeof x !== "string") || x.trim() !== "");
    const failed = (Array.isArray(value.failed) ? value.failed : []).filter(Boolean);
    if (done.length === 0) {
      return {
        ok: false, degraded: true, stage: failed.length > 0 ? "all-failed" : "empty-run",
        detail: failed.length > 0 ? failed.map((f) => `${f.id}：${f.reason}`).join("；") : "工作流跑完了但一件工件都没产出。",
        done: [], failed,
      };
    }
    return {
      ok: true, degraded: failed.length > 0, done, failed,
      detail: failed.length > 0
        ? `${done.map((d) => d.id).join("、")} 成功；${failed.map((f) => `${f.id}（${f.reason}）`).join("、")} 失败。`
        : `${done.length} 件全部成功：${done.map((d) => d.id).join("、")}`,
    };
  } catch (error) {
    return { ok: false, degraded: true, stage: "run-threw", detail: String(error?.message ?? error), done: [], failed: [] };
  } finally {
    try {
      await run.dispose?.();
    } catch {
      /* 清理失败不该盖掉结果 */
    }
  }
}
