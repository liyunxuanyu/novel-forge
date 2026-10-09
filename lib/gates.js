/**
 * 门禁分级与质量债。
 *
 * 分级的唯一依据是**可逆性**：
 *   错在草稿里，代价是重写一遍 → 可以自动往下走
 *   错在定稿里，代价是全书要补偿 → 必须停下来问作者
 *
 * 另一个正交的问题是"审读发现问题怎么办"。答案是按严重度分流：
 *   S1/S2 立刻阻断；S3/S4 记为质量债继续跑，但整书定稿前必须清空或由作者明确豁免。
 *
 * 门禁策略是一份真源配置（书仓里的 JSON），不是代码常量——作者可以调。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { bookPaths, commitPaths } from "./warehouse.js";

export const GATE_LEVELS = ["auto", "stop-with-default", "stop"];

export const POLICY_FILE = "门禁策略.json";
export const DEBT_FILE = "卷账/质量债.json";

/** 严重度分级。blocks=是否当场阻断；asDebt=是否可降级为质量债继续。 */
export const SEVERITY = {
  s1: { label: "阻断性", hint: "事实矛盾 / 人物崩坏 / 与已定稿冲突", blocks: true, asDebt: false },
  s2: { label: "结构性", hint: "本章目标未达成 / 因果断裂 / 节奏塌陷", blocks: true, asDebt: false },
  s3: { label: "可优化", hint: "信息密度失衡 / 铺垫不足 / 重复表达", blocks: false, asDebt: true },
  s4: { label: "风格润色", hint: "措辞、句式、AI 味等表层问题", blocks: false, asDebt: true },
};

/** 作者在每个 stop 节点上真正要决定的事。停下来时把这些摆给他看。 */
export const DECISIONS = {
  "book.create": [{
    id: "proceed", question: "确认按这份七要素建书？",
    options: ["确认建书", "先改构图要素", "暂不建书"], defaultOption: "确认建书",
  }],
  "book.concept_change": [{
    id: "scope", question: "这份改动只影响当前卷，还是全书重算？",
    options: ["仅当前卷生效", "全书重算并出影响分析", "撤回改动"], defaultOption: "全书重算并出影响分析",
  }],
  "design.skeleton": [{
    id: "shape", question: "故事骨架走向哪一版？",
    options: ["采用本版", "回到上一版", "在关键处先聊再定"], defaultOption: "采用本版",
  }],
  "design.volume_layout": [{
    id: "split", question: "分卷边界按这版定？",
    options: ["确认", "调整某卷边界", "重排"], defaultOption: "确认",
  }],
  "design.volume_plan": [{
    id: "plan", question: "本卷规划确认？",
    options: ["确认", "改本卷目标", "拆细每章目标"], defaultOption: "确认",
  }],
  "chapter.revise_exhausted": [{
    id: "exhausted", question: "这一章已改满三轮仍没审过，继续改还是先定稿？",
    options: ["再改一轮并放宽标准", "带现状定稿入档", "退回重写这一章"], defaultOption: "再改一轮并放宽标准",
  }],  "chapter.settle": [{
    id: "settle", question: "这一章定稿入档？",
    options: ["定稿入档", "先改一版", "退回重写"], defaultOption: "定稿入档",
  }],
  "volume.settle": [{
    id: "volume", question: "整卷定稿？",
    options: ["确认整卷定稿", "先处理质量债", "退回某章"], defaultOption: "先处理质量债",
  }],
  "debt.settle": [{
    id: "debt", question: "还有未清的质量债，是否带债继续？",
    options: ["逐条处理", "明确豁免并记录理由", "退回相关章"], defaultOption: "逐条处理",
  }],
};

export const DEFAULT_POLICY = {
  schema: 1,
  nodes: {
    "book.create": "stop",
    "book.concept_change": "stop",
    "design.skeleton": "stop",
    "design.volume_layout": "stop",
    "design.volume_plan": "stop-with-default",
    "design.outline": "auto",
    "design.worldbook": "auto",
    "chapter.outline_confirm": "auto",
    "chapter.materials": "auto",
    "chapter.draft": "auto",
    "chapter.review": "auto",
    "chapter.revise": "auto",
    "chapter.revise_exhausted": "stop",
    "chapter.settle": "stop",
    "volume.settle": "stop",
  },
};

export function policyPath(workspaceRoot, bookTitle) {
  return path.join(bookPaths(workspaceRoot, bookTitle).base, POLICY_FILE);
}
export function debtPath(workspaceRoot, bookTitle) {
  return path.join(bookPaths(workspaceRoot, bookTitle).base, DEBT_FILE);
}

export async function loadPolicy(workspaceRoot, bookTitle) {
  const raw = await fs.readFile(policyPath(workspaceRoot, bookTitle), "utf8").catch(() => null);
  if (raw === null) return { ...DEFAULT_POLICY, source: "default", isDefault: true };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_POLICY, source: "default", isDefault: true, parseError: "门禁策略.json 解析失败，已回退默认策略" };
  }
  const nodes = { ...DEFAULT_POLICY.nodes, ...(parsed.nodes ?? {}) };
  const bad = Object.entries(nodes).filter(([, v]) => !GATE_LEVELS.includes(v));
  for (const [k] of bad) delete nodes[k];
  return { ...DEFAULT_POLICY, ...parsed, nodes, source: "book", isDefault: false, invalidEntries: bad.map(([k]) => k) };
}

export function gateLevel(policy, node) {
  return policy.nodes?.[node] ?? "stop"; // 未登记的节点按最保守处理
}

export function gateCheck(policy, node) {
  const level = gateLevel(policy, node);
  const decisions = DECISIONS[node] ?? [];
  return {
    node,
    level,
    proceed: level === "auto",
    requiresDecision: level !== "auto",
    hasDefault: level === "stop-with-default",
    defaultOption: level === "stop-with-default" ? (decisions[0]?.defaultOption ?? null) : null,
    decisions,
    // 停也要停得有信息量：作者至少要知道现在在干什么、会影响什么
    stopReason: level === "auto" ? null : `${node} 是 ${level} 级门禁：这一步错了要补偿，所以必须作者拍板。`,
  };
}

/** 未登记决策的 auto 节点不该出现在决策表里，否则噪声很大。 */
export function decisionQueue(policy, pendingNodes) {
  return (pendingNodes ?? []).map((n) => gateCheck(policy, n)).filter((g) => g.requiresDecision);
}

// ── 质量债 ───────────────────────────────────────────────────────────────

function nextDebtId(entries) {
  const max = entries.reduce((m, e) => Math.max(m, Number(String(e.id).replace(/\D/g, "")) || 0), 0);
  return `d${String(max + 1).padStart(4, "0")}`;
}

async function readLedger(workspaceRoot, bookTitle) {
  const raw = await fs.readFile(debtPath(workspaceRoot, bookTitle), "utf8").catch(() => null);
  if (raw === null) return { schema: 1, entries: [] };
  try {
    const p = JSON.parse(raw);
    return { schema: p.schema ?? 1, entries: Array.isArray(p.entries) ? p.entries : [] };
  } catch {
    return { schema: 1, entries: [], parseError: "质量债.json 解析失败" };
  }
}

async function writeLedger(workspaceRoot, bookTitle, ledger) {
  const abs = debtPath(workspaceRoot, bookTitle);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(ledger, null, 2), "utf8");
  return ledger;
}

export function classify(severity) {
  const s = SEVERITY[severity];
  if (!s) return null;
  return { severity, ...s, action: s.blocks ? "阻断" : "记为质量债，继续" };
}

/**
 * 记一条审读结论。S1/S2 直接阻断（不进台账，返回阻断说明）；
 * S3/S4 落台账并提交 design:，流程继续。
 */
export async function recordFinding(workspaceRoot, bookTitle, { chapter, severity, dimension, quote, note }) {
  const cls = classify(severity);
  if (!cls) {
    return { ok: false, stage: "bad-severity", detail: `严重度必须是 ${Object.keys(SEVERITY).join(" / ")} 之一，收到 "${severity}"` };
  }
  if (!String(quote ?? "").trim() || !String(note ?? "").trim()) {
    return { ok: false, stage: "finding-invalid", detail: "每条结论都要有 quote（逐字引文）与 note（问题说明）。" };
  }

  if (cls.blocks) {
    return {
      ok: true, blocked: true, action: "阻断", severity,
      detail: `${cls.label}级问题当场阻断，不进质量债台账：${note}`,
    };
  }

  const ledger = await readLedger(workspaceRoot, bookTitle);
  const entry = {
    id: nextDebtId(ledger.entries),
    chapter: chapter ?? null,
    severity,
    dimension: dimension ?? null,
    quote: String(quote).trim(),
    note: String(note).trim(),
    createdAt: new Date().toISOString(),
    status: "未处理",
    waiver: null,
  };
  ledger.entries.push(entry);
  await writeLedger(workspaceRoot, bookTitle, ledger);

  const rel = path.relative(workspaceRoot, debtPath(workspaceRoot, bookTitle)).replace(/\\/g, "/");
  const commit = await commitPaths(workspaceRoot, [rel], `design: 记质量债 ${entry.id}（${chapter ?? "全书"} ${severity}）`);
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };

  return { ok: true, blocked: false, action: "记为质量债，继续", severity, debt: entry, commit: commit.commit };
}

export async function listDebts(workspaceRoot, bookTitle, { status } = {}) {
  const ledger = await readLedger(workspaceRoot, bookTitle);
  const entries = status ? ledger.entries.filter((e) => e.status === status) : ledger.entries;
  const open = entries.filter((e) => e.status === "未处理");
  return {
    ok: true,
    total: entries.length,
    open: open.length,
    bySeverity: {
      s3: open.filter((e) => e.severity === "s3").length,
      s4: open.filter((e) => e.severity === "s4").length,
    },
    entries,
  };
}

/** 作者明确豁免一条债。理由必填，且进 Git——口头放过不算数。 */
export async function waiveDebt(workspaceRoot, bookTitle, id, reason) {
  if (!String(reason ?? "").trim()) {
    return { ok: false, stage: "reason-required", detail: "豁免必须写理由。这条会进 Git 提交历史，以后翻得到。" };
  }
  const ledger = await readLedger(workspaceRoot, bookTitle);
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry) return { ok: false, stage: "no-entry", detail: `台账里没有 ${id}` };
  if (entry.status !== "未处理") return { ok: false, stage: "already-settled", detail: `${id} 已经是「${entry.status}」，不用再豁免。` };

  entry.status = "已豁免";
  entry.waiver = { reason: String(reason).trim(), at: new Date().toISOString() };
  await writeLedger(workspaceRoot, bookTitle, ledger);

  const rel = path.relative(workspaceRoot, debtPath(workspaceRoot, bookTitle)).replace(/\\/g, "/");
  const commit = await commitPaths(workspaceRoot, [rel], `design: 豁免质量债 ${id}（${entry.severity}）`);
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };
  return { ok: true, debt: entry, commit: commit.commit };
}

/** 已处理：真正回头改掉了，而不是豁免。 */
export async function resolveDebt(workspaceRoot, bookTitle, id, how) {
  const ledger = await readLedger(workspaceRoot, bookTitle);
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry) return { ok: false, stage: "no-entry", detail: `台账里没有 ${id}` };
  if (entry.status !== "未处理") return { ok: false, stage: "already-settled", detail: `${id} 已经是「${entry.status}」。` };

  entry.status = "已处理";
  entry.resolution = { how: String(how ?? "").trim() || "已在正文中处理", at: new Date().toISOString() };
  await writeLedger(workspaceRoot, bookTitle, ledger);

  const rel = path.relative(workspaceRoot, debtPath(workspaceRoot, bookTitle)).replace(/\\/g, "/");
  const commit = await commitPaths(workspaceRoot, [rel], `design: 结清质量债 ${id}`);
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };
  return { ok: true, debt: entry, commit: commit.commit };
}

/**
 * 整书 / 整卷定稿前的质量债闸门：有未清债务就不能过，除非作者逐条豁免过。
 */
export async function debtGate(workspaceRoot, bookTitle) {
  const ledger = await readLedger(workspaceRoot, bookTitle);
  const open = ledger.entries.filter((e) => e.status === "未处理");
  const passed = open.length === 0;
  return {
    ok: true,
    passed,
    openCount: open.length,
    node: "debt.settle",
    detail: passed
      ? "没有未清质量债，可以整卷定稿。"
      : `还有 ${open.length} 条未清质量债（${open.map((e) => e.id).join("、")}）。逐条处理，或由作者明确豁免并写理由。`,
    ...gateCheck({ nodes: { "debt.settle": "stop" } }, "debt.settle"),
    blocked: !passed,
  };
}
