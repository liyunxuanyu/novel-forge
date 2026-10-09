/**
 * 一轮的执行层。
 *
 * 决策层说"该做什么"，这里负责"把它跑完，并且跑砸了不炸"。
 * 关键约束：单个子代理失败**不许毁掉整轮**——成功的结果照常落地，失败的记下来降级继续。
 * 无人值守的底线在这里：任何一次派发失败都必须变成可读的状态，而不是抛异常打断全书。
 */

/** 工作流脚本很薄：任务文本走 args 传，不拼进脚本文本，避免引号与 ${} 被打包。 */
const SCRIPT_SINGLE = `
phase(args.label)
const out = await agent(args.prompt, { label: args.label })
return { done: [out], failed: [] }
`;

const SCRIPT_PARALLEL = `
phase(args.label)
const settled = await parallel(
  args.prompts.map((p, i) => async () => {
    try {
      return { ok: true, index: i, text: await agent(p, { label: args.label + "-" + i }) }
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
 * 跑一轮。
 * @param engine ctx.workflowEngine（宿主提供）
 * @returns 一律 resolve：失败也返回结构化结果，让调用方能决定是降级还是停下。
 */
export async function runRound(engine, { label, prompt, prompts, mode, parent, signal }) {
  if (!engine || typeof engine.start !== "function") {
    return { ok: false, stage: "no-engine", detail: "宿主没有提供 workflowEngine 服务，无法派子代理。" };
  }
  const isParallel = mode === "parallel" && Array.isArray(prompts) && prompts.length > 1;
  const script = isParallel ? SCRIPT_PARALLEL : SCRIPT_SINGLE;

  let run;
  try {
    run = engine.start({
      script,
      meta: { name: `novel-forge:${label}` },
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
    try {
      return { id: job.id, ok: true, text: await agent(job.prompt, { label: args.label + "-" + job.id }) }
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
export async function runFanout(engine, { jobs, label = "fanout", parent, signal }) {
  if (!engine || typeof engine.start !== "function") {
    return { ok: false, stage: "no-engine", detail: "宿主没有提供 workflowEngine 服务，无法派子代理。", done: [], failed: [] };
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { ok: false, stage: "nothing-to-do", detail: "没有可派发的工件。", done: [], failed: [] };
  }

  let run;
  try {
    run = engine.start({ script: FANOUT_SCRIPT, meta: { name: `novel-forge:${label}` }, args: { label, jobs }, parent, signal });
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