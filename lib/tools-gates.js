/**
 * 门禁与质量债工具集。
 *
 * 门禁等级可查、可配置；审读结论按严重度分流；
 * 整卷定稿前有未清债务就会被挡，除非作者逐条写下豁免理由。
 */
import {
  SEVERITY, GATE_LEVELS, loadPolicy, gateCheck, decisionQueue,
  classify, recordFinding, listDebts, waiveDebt, resolveDebt, debtGate,
} from "./gates.js";
import { validateTitle } from "./warehouse.js";
import { chapterKey, readState, recordGateDecision } from "./chapter-state.js";

const OK_FAIL = {
  ok: { type: "boolean", required: true },
  stage: { type: "string" },
  detail: { type: "string" },
};

export function gateTools(ctx, resolveRoot) {
  const root = async () => {
    const r = resolveRoot();
    if (!r) throw new Error("当前会话没有有效工作区。");
    return r;
  };
  const titleOf = (t) => {
    const err = validateTitle(String(t ?? "").trim());
    return err ? null : String(t).trim();
  };

  // ── forge_gate_status ────────────────────────────────────────────────
  const gateStatusTool = {
    name: "forge_gate_status",
    description:
      "查这本书的门禁策略：每个流程节点是 auto（自动往下走）、stop（必须作者拍板）、" +
      "还是 stop-with-default（停下但有默认选项）。策略存在书仓里，作者可以改。" +
      "自动导演跑之前先看这个，知道哪儿会停下来。",
    parameters: { title: { type: "string", required: true, description: "书名" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          source: { type: "string", required: true, description: "book=书仓里有自定义策略；default=用的默认策略" },
          nodes: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                node: { type: "string", required: true },
                level: { type: "string", required: true },
                requiresDecision: { type: "boolean", required: true },
                // auto 档没有要问作者的问题，真的是 null。
          question: { oneOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `查门禁策略失败（${v.stage}）：${v.detail}` }];
        const rows = v.nodes.map((n) => `  ${n.level.padEnd(18)} ${n.node}${n.question ? `\n      → ${n.question}` : ""}`);
        const stops = v.nodes.filter((n) => n.requiresDecision).length;
        return [{ type: "text", text: `门禁策略（来源：${v.source}）\n${rows.join("\n")}\n共 ${v.nodes.length} 个节点，其中 ${stops} 个需要作者拍板。` }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。书仓里就有书，直接填书名。" };
      const policy = await loadPolicy(await root(), title);
      const nodes = Object.entries(policy.nodes).map(([node, level]) => {
        const c = gateCheck(policy, node);
        return { node, level, requiresDecision: c.requiresDecision, question: c.decisions[0]?.question ?? null };
      });
      return { ok: true, source: policy.source, nodes };
    },
    presentCall: (a) => ({ card: "generic", title: "查门禁策略", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_gate_check ─────────────────────────────────────────────────
  const gateCheckTool = {
    name: "forge_gate_check",
    description:
      "问一个具体流程节点现在能不能自动过。放行就直接过；要停就返回该作者决定的问题与可选动作。" +
      "自动导演在每一步推进前都应调它。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      node: { type: "string", required: true, description: `节点名，取 forge_gate_status 列出的那些` },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          node: { type: "string", required: true },
          level: { type: "string", required: true },
          proceed: { type: "boolean", required: true },
          requiresDecision: { type: "boolean", required: true },
          hasDefault: { type: "boolean", required: true },
          defaultOption: { oneOf: [{ type: "string" }, { type: "null" }] },
          stopReason: { oneOf: [{ type: "string" }, { type: "null" }] },
          decisions: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                question: { type: "string", required: true },
                options: { type: "array", required: true, items: { type: "string" } },
                defaultOption: { oneOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `门禁检查失败（${v.stage}）：${v.detail}` }];
        if (v.proceed) return [{ type: "text", text: `${v.node}：${v.level}，自动放行，无需询问作者。` }];
        const lines = [`${v.node}：${v.level}，需要作者拍板。`, v.stopReason];
        for (const d of v.decisions) {
          lines.push(`  问题：${d.question}`);
          lines.push(`  可选：${d.options.join(" / ")}${d.defaultOption ? `（默认：${d.defaultOption}）` : ""}`);
        }
        return [{ type: "text", text: lines.filter(Boolean).join("\n") }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const policy = await loadPolicy(await root(), title);
      return { ok: true, ...gateCheck(policy, String(args?.node ?? "")) };
    },
    presentCall: (a) => ({ card: "generic", title: "门禁检查", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_gate_decide ────────────────────────────────────────────────
  const gateDecideTool = {
    name: "forge_gate_decide",
    description:
      "把作者在一个 stop 闸门上的答复记进真源，让导演能继续。" +
      "答复必须逐字取该节点给出的可选项之一——写错的选项会被拒，" +
      "不会静默地什么都不做。目前支持章级闸门（例如 chapter.revise_exhausted）。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      node: { type: "string", required: true, description: "闸门节点名，如 chapter.revise_exhausted" },
      chapter: { type: "number", required: true, description: "章号（全书连续）" },
      choice: { type: "string", required: true, description: "作者选的那一项，必须逐字等于该节点给出的可选项" },
      note: { type: "string", description: "作者的原话或理由，会一并记下" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          chapter: { type: "string" },
          node: { type: "string" },
          choice: { type: "string" },
          grantedExtraRounds: { type: "number" },
          reviseWaiver: { type: "number" },
          stage: { type: "string" },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `记录闸门答复失败（${v.stage}）：${v.detail}` }];
        const extra = v.grantedExtraRounds > 0
          ? `，已放开 ${v.grantedExtraRounds} 轮改稿（本卷累计 ${v.reviseWaiver} 轮）`
          : "，这一项不放开任何约束";
        return [{ type: "text", text: `${v.chapter} 的 ${v.node}：已记下作者的选择「${v.choice}」${extra}。` }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const node = String(args?.node ?? "").trim();
      if (!node) return { ok: false, stage: "validate-node", detail: "缺少闸门节点名。" };
      const choice = String(args?.choice ?? "").trim();
      if (!choice) return { ok: false, stage: "validate-choice", detail: "缺少作者的选择。" };
      const n = Number(args?.chapter);
      if (!Number.isInteger(n) || n <= 0) return { ok: false, stage: "validate-chapter", detail: "章号必须是正整数。" };

      const policy = await loadPolicy(await root(), title);
      const gate = gateCheck(policy, node);
      const options = (gate.decisions ?? []).flatMap((d) => d.options ?? []);
      if (options.length === 0) {
        return { ok: false, stage: "unknown-node", detail: `${node} 没有登记可选项，不能作为闸门答复记录。` };
      }
      // 逐字比对，不做模糊匹配：答复是要驱动流程的，猜错等于没答。
      if (!options.includes(choice)) {
        return {
          ok: false,
          stage: "unknown-choice",
          detail: `${node} 的可选项是 ${options.join(" / ")}，没有「${choice}」。`,
        };
      }

      const key = chapterKey(n);
      const state = await readState(await root(), title, key);
      if (!state) return { ok: false, stage: "no-chapter", detail: `${key} 还没有流程记录，先把它跑到这一步。` };

      const rec = await recordGateDecision(await root(), title, key, state.volume ?? 1, {
        node, choice, note: args?.note ? String(args.note) : null,
      });
      if (!rec.ok) return { ok: false, stage: rec.stage, detail: rec.detail };
      return {
        ok: true,
        chapter: key,
        node: rec.node,
        choice: rec.choice,
        grantedExtraRounds: rec.grantedExtraRounds,
        reviseWaiver: rec.reviseWaiver,
        stage: rec.stage,
      };
    },
    presentCall: (a) => ({ card: "generic", title: "闸门答复", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_record_finding ─────────────────────────────────────────────
  const recordFindingTool = {
    name: "forge_record_finding",
    description:
      "回写一条审读结论，按严重度分流：s1/s2 当场阻断并停下；s3/s4 记为质量债继续跑，" +
      "但整卷定稿前必须结清或由作者写理由豁免。台账变更会落一次 design: 提交。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      chapter: { type: "integer", description: "章号（全书连续）。省略表示不限定章节。" },
      severity: { type: "string", required: true, description: `严重度 ${Object.keys(SEVERITY).join(" / ")}` },
      dimension: { type: "string", description: "所属审读维度" },
      quote: { type: "string", required: true, description: "逐字引文" },
      note: { type: "string", required: true, description: "问题说明" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          blocked: { type: "boolean", required: true },
          action: { type: "string", required: true },
          severity: { type: "string", required: true },
          // s1/s2 当场阻断时不建债，debt 为空，这里真的是 null。
          debtId: { oneOf: [{ type: "string" }, { type: "null" }] },
          commit: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      render: (_a, v) => [{
        type: "text",
        text: v.ok
          ? (v.blocked
            ? `${v.severity} 级问题：当场阻断。${v.detail}`
            : `${v.severity} 级问题：记为质量债 ${v.debtId}，流程继续。整卷定稿前需结清或豁免。`)
          : `回写审读结论被拒（${v.stage}）：${v.detail}`,
      }],
    },
    async execute(args) {
      const ws = await root();
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const key = args?.chapter ? `ch${String(args.chapter).padStart(4, "0")}` : null;
      const r = await recordFinding(ws, title, {
        chapter: key, severity: args?.severity,
        dimension: args?.dimension, quote: args?.quote, note: args?.note,
      });
      if (!r.ok) return r;
      const { debt, commit, ...rest } = r;
      return { ...rest, debtId: debt?.id ?? null, commit: commit ?? null };
    },
    presentCall: (a) => ({ card: "generic", title: "回写审读结论", kind: "other", rawInput: { title: a?.title, severity: a?.severity } }),
  };

  // ── forge_list_debts ─────────────────────────────────────────────────
  const listDebtsTool = {
    name: "forge_list_debts",
    description: "查质量债台账：未清债数量、按严重度分布、每条的引文与状态。整卷定稿前先查这个。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      status: { type: "string", description: "只看待处理 或 已处理 或 已豁免 的条目。省略则全列。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          total: { type: "integer", required: true },
          open: { type: "integer", required: true },
          s3: { type: "integer", required: true },
          s4: { type: "integer", required: true },
          entries: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                chapter: { oneOf: [{ type: "string" }, { type: "null" }] },
                severity: { type: "string", required: true },
                dimension: { oneOf: [{ type: "string" }, { type: "null" }] },
                quote: { type: "string", required: true },
                note: { type: "string", required: true },
                status: { type: "string", required: true },
                createdAt: { type: "string" },
                waiver: { oneOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `查台账失败（${v.stage}）：${v.detail}` }];
        if (!v.entries || v.entries.length === 0) return [{ type: "text", text: "质量债台账是空的。整卷定稿不会被挡。" }];
        const lines = v.entries.map((e) => `  ${e.id} ${e.severity} ${e.chapter ?? "全书"} [${e.status}] ${e.note}`);
        return [{ type: "text", text: `共 ${v.total} 条，未清 ${v.open} 条（s3 ${v.s3} / s4 ${v.s4}）\n${lines.join("\n")}` }];
      },
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const r = await listDebts(await root(), title, { status: args?.status });
      // bySeverity 不能以 undefined 形式留在返回值里：键还在，宿主校验会判
      // "not a declared property (additionalProperties: false)"。解构掉它。
      const { bySeverity, ...rest } = r;
      return { ...rest, s3: bySeverity.s3, s4: bySeverity.s4 };
    },
    presentCall: (a) => ({ card: "generic", title: "查质量债台账", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_settle_debt ────────────────────────────────────────────────
  const settleDebtTool = {
    name: "forge_settle_debt",
    description:
      "结清一条质量债。action=resolve 表示回头改掉了；action=waive 表示作者明确豁免——" +
      "两者都必须写说明，且都会落一次 design: 提交。口头放过不算数。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      id: { type: "string", required: true, description: "债务编号，如 d0001" },
      action: { type: "string", required: true, description: "resolve=已改掉；waive=作者豁免" },
      how: { type: "string", required: true, description: "怎么处理的 / 为什么豁免。必填，会进 Git 历史。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { ...OK_FAIL, id: { type: "string", required: true }, newStatus: { type: "string", required: true }, commit: { type: "string" } },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? `${v.id} → ${v.newStatus}（提交 ${v.commit.slice(0, 8)}）` : `结清失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const ws = await root();
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      const id = String(args?.id ?? "");
      if (String(args?.action) === "resolve") {
        const r = await resolveDebt(ws, title, id, args?.how);
        if (!r.ok) return r;
        return { ok: true, id, newStatus: r.debt.status, commit: r.commit };
      }
      const r = await waiveDebt(ws, title, id, args?.how);
      if (!r.ok) return r;
      return { ok: true, id, newStatus: r.debt.status, commit: r.commit };
    },
    presentCall: (a) => ({ card: "generic", title: "结清质量债", kind: "other", rawInput: { title: a?.title, id: a?.id } }),
  };

  // ── forge_debt_gate ──────────────────────────────────────────────────
  const debtGateTool = {
    name: "forge_debt_gate",
    description:
      "整卷定稿前的质量债闸门。有未清债务就拦住，并列出欠哪几条。" +
      "自动导演在整卷定稿前必须调它，被挡时不该硬闯。",
    parameters: { title: { type: "string", required: true, description: "书名" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ...OK_FAIL,
          passed: { type: "boolean", required: true },
          blocked: { type: "boolean", required: true },
          openCount: { type: "integer", required: true },
          node: { type: "string", required: true },
          level: { type: "string", required: true },
          // execute 直接透传 debtGate() 的结果，闸门字段一并带出来。
          proceed: { type: "boolean" },
          requiresDecision: { type: "boolean" },
          hasDefault: { type: "boolean" },
          defaultOption: { oneOf: [{ type: "string" }, { type: "null" }] },
          stopReason: { oneOf: [{ type: "string" }, { type: "null" }] },
          decisions: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                question: { type: "string", required: true },
                options: { type: "array", required: true, items: { type: "string" } },
                defaultOption: { oneOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
          detail: { type: "string", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.ok ? (v.passed ? `质量债闸门放行：${v.detail}` : `质量债闸门拦下：${v.detail}`) : `闸门检查失败（${v.stage}）：${v.detail}` }],
    },
    async execute(args) {
      const title = titleOf(args?.title);
      if (!title) return { ok: false, stage: "validate-title", detail: "书名不合法。" };
      return debtGate(await root(), title);
    },
    presentCall: (a) => ({ card: "generic", title: "质量债闸门", kind: "other", rawInput: a ?? {} }),
  };

  return [gateStatusTool, gateCheckTool, gateDecideTool, recordFindingTool, listDebtsTool, settleDebtTool, debtGateTool];
}
