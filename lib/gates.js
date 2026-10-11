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
  // 问句里不写死轮数：作者放过「再改一轮并放宽标准」之后上限会临时加高，
  // 写死「已改满三轮」就在作者正要拍板的那一刻报了假数。真实轮数在章状态里。
  // 「本章有未处置的阻断级问题」——这一条以前**根本不存在**。
  //
  // 起因是真机上第 1 章审读报了一条 s2（细纲第 14 章要回收的限定词「晚上」
  // 在第 1 章已被写成抹掉），recordFinding 照 s2 的定义返回 blocked:true 就
  // 结束了：没落档、没有闸门节点、也没有任何规则读它。于是导演的下一步仍是
  // chapter.review（审读中），又审一轮，又报 s2。
  //
  // 结果是**死循环，而且无声**：审读子代理以为自己上报过了，状态看着也正常，
  // 但那一章永远走不到改稿也走不到定稿。这正是「必须人工救火」的那一类故障，
  // 而且比崩溃更难发现——崩溃会报错，这个只是慢慢空转。
  //
  // 问题不是「该不该阻断」，阻断是对的；缺的是**阻断之后问谁、答了怎么执行**。
  // s1/s2 记成一条带阻塞标记的债，作者在 chapter.blocked 上拍板：
  // 按发现项改（自动放一轮改稿）／判定不算问题（就地豁免）／退回重写本章。
  "chapter.blocked": [{
    id: "blocked", question: "本章有阻断级问题（事实矛盾／因果断裂／与已定稿冲突），怎么处置？",
    options: ["按发现项改掉再定稿", "判定不算问题并记录理由", "退回重写这一章"], defaultOption: "按发现项改掉再定稿",
  }],
  "chapter.revise_exhausted": [{
    id: "exhausted", question: "这一章改到上限了仍没审过，继续改还是先定稿？",
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
    // 阻断级问题必须作者拍板：它不是「改不改」的口味问题，是「这本书的设定
    // 要不要动」的问题（真机上那条 s2 就得在「让第 14 章捞得回来」与
    // 「换掉第 14 章的回收物」之间二选一）。auto 会让模型替作者改设定。
    "chapter.blocked": "stop",
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
 * 记一条审读结论。S1/S2 阻断并**落档**；S3/S4 落台账并提交 design:，流程继续。
 *
 * ## 为什么阻断级问题也要落档
 *
 * 原来这里是 `if (cls.blocks) return { blocked: true }` —— 直接返回，什么都不写。
 * 当时的想法是「阻断就不该进台账，台账是留给可以延后的债的」。但结果是这条
 * 结论**在真源里不存在**：
 *
 *   - 子代理下一轮看不到它（它只活在本次工具返回值里）
 *   - 导演看不到它（没有规则读 blocked）
 *   - 会话一断就彻底没了
 *
 * 真机上第 1 章就这么空转了一轮：报 s2 → 蒸发 → 再审 → 再报 s2。无声死循环，
 * 比崩溃更难发现——崩溃会报错，这个只是慢慢空转。
 *
 * 现在落档，但**用状态区分**：阻断级记「未处置」，可延后的记「未处理」。
 * 两者都算未清债（整卷定稿前都拦），区别在导演会为「未处置」当场停下问作者。
 *
 * 用状态而不是 severity 来区分，是因为 severity 会随复核变化——作者判定
 * 「这条其实不算问题」之后，severity 不该再决定它挡不挡路。
 */
export async function recordFinding(workspaceRoot, bookTitle, { chapter, severity, dimension, quote, note }) {
  const cls = classify(severity);
  if (!cls) {
    return { ok: false, stage: "bad-severity", detail: `严重度必须是 ${Object.keys(SEVERITY).join(" / ")} 之一，收到 "${severity}"` };
  }
  if (!String(quote ?? "").trim() || !String(note ?? "").trim()) {
    return { ok: false, stage: "finding-invalid", detail: "每条结论都要有 quote（逐字引文）与 note（问题说明）。" };
  }

  const ledger = await readLedger(workspaceRoot, bookTitle);

  // 同一件事不该在台账里长出第二条。
  //
  // 审读每轮都重跑，而**没修掉的问题会被一轮轮重新报上来**。以前这里无条件
  // 新建，于是：一条 s2 改不掉 → 下一轮再报 → 又一条 → 导演每轮都停在
  // chapter.blocked 上问同一句。这正是这套链最难对付的失效方式——它不是报错，
  // 是无声地反复问同一句，而人只能一次次拍板，直到手酸为止。
  //
  // 复用旧条目的行为分两种：
  //   - 新结论本来就阻断，而旧条目是「未处理」（上一轮作者说「按发现项改掉」，
  //     改稿没改动）→ 退回「未处置」，让导演重新问一次。**这是升级，不是重复**：
  //     修不动就说明上一轮那次拍板不足以执行，该再问一次。
  //   - 其余情况原样返回，连 Git 提交都不产生。
  const open = ledger.entries.filter(
    (e) => OPEN_STATUSES.includes(e.status) && String(e.chapter ?? "") === String(chapter ?? ""),
  );
  const dup = open.find(
    (e) => String(e.quote ?? "") === String(quote).trim() && String(e.note ?? "") === String(note).trim(),
  );
  if (dup) {
    if (cls.blocks && dup.status !== "未处置") {
      dup.status = "未处置";
      dup.disposition = null;
      // **必须先落盘再提交**。少了这一句，状态只在内存里改过，
      // 提交就变成「没有改动可提交」而失败，返回 ok:false——
      // 而调用方看到的是「记阻断项失败」，完全看不出真正的原因是漏了一次写。
      await writeLedger(workspaceRoot, bookTitle, ledger);
      const reRel = path.relative(workspaceRoot, debtPath(workspaceRoot, bookTitle)).replace(/\\/g, "/");
      const reCommit = await commitPaths(workspaceRoot, [reRel], `design: 重新挂起阻断项 ${dup.id}（${chapter ?? "全书"} ${severity}）`);
      if (!reCommit.ok) return { ok: false, stage: reCommit.stage, detail: reCommit.detail };
      return {
        ok: true, blocked: true, reused: true, severity,
        action: `台账里已有同一条（${dup.id}），改稿没有消掉它，重新挂为阻断项`,
        debt: dup, commit: reCommit.commit,
      };
    }
    return {
      ok: true, blocked: dup.status === "未处置", reused: true, severity,
      action: `台账里已有同一条（${dup.id}），复用，不再新建`,
      debt: dup, commit: null,
    };
  }

  const entry = {
    id: nextDebtId(ledger.entries),
    chapter: chapter ?? null,
    severity,
    dimension: dimension ?? null,
    quote: String(quote).trim(),
    note: String(note).trim(),
    createdAt: new Date().toISOString(),
    // 阻断级落「未处置」：同样是未清债，但导演会当场停下来问作者。
    status: cls.blocks ? "未处置" : "未处理",
    waiver: null,
  };
  ledger.entries.push(entry);
  await writeLedger(workspaceRoot, bookTitle, ledger);

  const rel = path.relative(workspaceRoot, debtPath(workspaceRoot, bookTitle)).replace(/\\/g, "/");
  const subject = cls.blocks
    ? `design: 记阻断项 ${entry.id}（${chapter ?? "全书"} ${severity}）`
    : `design: 记质量债 ${entry.id}（${chapter ?? "全书"} ${severity}）`;
  const commit = await commitPaths(workspaceRoot, [rel], subject);
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };

  return {
    ok: true,
    blocked: cls.blocks,
    action: cls.blocks ? "记为阻断项，当场停下等作者拍板" : "记为质量债，继续",
    severity,
    debt: entry,
    commit: commit.commit,
  };
}

/** 未清债 = 未处理 + 未处置。两者整卷定稿前都必须清掉或豁免。 */
const OPEN_STATUSES = ["未处理", "未处置"];

export async function listDebts(workspaceRoot, bookTitle, { status } = {}) {
  const ledger = await readLedger(workspaceRoot, bookTitle);
  // 调用方传 "未处理" 是想问「还有哪些没清」，那必须把「未处置」也算进来，
  // 否则一条阻断项会让 openDebts 显示为 0，整卷闸门形同虚设。
  const entries = status
    ? ledger.entries.filter((e) => (status === "未处理" ? OPEN_STATUSES.includes(e.status) : e.status === status))
    : ledger.entries;
  const open = entries.filter((e) => OPEN_STATUSES.includes(e.status));
  return {
    ok: true,
    total: entries.length,
    open: open.length,
    blocking: open.filter((e) => e.status === "未处置").length,
    bySeverity: {
      s1: open.filter((e) => e.severity === "s1").length,
      s2: open.filter((e) => e.severity === "s2").length,
      s3: open.filter((e) => e.severity === "s3").length,
      s4: open.filter((e) => e.severity === "s4").length,
    },
    entries,
  };
}

/** 还没处置的阻断项。导演据此当场停下问作者。 */
export async function blockingFindings(workspaceRoot, bookTitle, chapterKey = null) {
  const ledger = await readLedger(workspaceRoot, bookTitle);
  return ledger.entries.filter(
    (e) => e.status === "未处置" && (chapterKey === null || String(e.chapter ?? "") === String(chapterKey)),
  );
}

/**
 * 作者在 chapter.blocked 上拍板之后，把本章的阻断项就地处置掉。
 *
 * 不这么做闸门会一直问同一句：答复记下了，但那条债还是「未处置」，导演下一轮
 * 照样命中同一条规则。**闸门能问却不能执行答复**——仓里因为这一类问题返工过
 * 好几次（chapter.revise_exhausted 当初就是这样：给出三个选项，作者选一个，
 * 然后没有然后了）。
 *
 * 处置方式与选项一一对应：
 *   按发现项改掉再定稿 → 转「未处理」，改稿带着它走，整卷前仍需结清
 *   判定不算问题       → 转「已豁免」，理由进 Git（口头放过不算数）
 *   退回重写这一章     → 转「未处理」，本章回起草中，债跟着新稿继续
 */
export async function dispositionBlocking(workspaceRoot, bookTitle, chapterKey, choice, reason = null) {
  const ledger = await readLedger(workspaceRoot, bookTitle);
  const targets = ledger.entries.filter(
    (e) => e.status === "未处置" && String(e.chapter ?? "") === String(chapterKey),
  );
  if (targets.length === 0) return { ok: true, changed: 0, ids: [] };

  const waived = /判定不算问题/.test(String(choice ?? ""));
  if (waived && !String(reason ?? "").trim()) {
    return { ok: false, stage: "reason-required", detail: "豁免阻断项必须写理由——这条会进 Git，以后翻得到。" };
  }

  const at = new Date().toISOString();
  for (const e of targets) {
    if (waived) {
      e.status = "已豁免";
      e.waiver = { reason: String(reason).trim(), at, via: "chapter.blocked" };
    } else {
      e.status = "未处理";
      // reason 必须一起存。
      //
      // 答复的**选项名**几乎从来不足以执行：d0007 的选项是「按发现项改掉再定稿」，
      // 而具体动作（「删掉『靠前两个字先没了』，让限定词只是渐糊」）全在作者
      // 补的理由里。以前这里只存 choice，于是改稿者拿到的是「按发现项改掉」，
      // 而发现项自己的 note 里列着「二选一：A 或 B」——它只能自己挑，
      // 真机上挑中的正是作者否掉的那支。存了理由，这一跳才闭合。
      e.disposition = { choice: String(choice ?? "").trim(), reason: String(reason ?? "").trim() || null, at };
    }
  }
  await writeLedger(workspaceRoot, bookTitle, ledger);

  const rel = path.relative(workspaceRoot, debtPath(workspaceRoot, bookTitle)).replace(/\\/g, "/");
  const commit = await commitPaths(
    workspaceRoot, [rel],
    `design: 处置阻断项 ${targets.map((e) => e.id).join("、")}（${waived ? "豁免" : "转为待改"}）`,
  );
  if (!commit.ok) return { ok: false, stage: commit.stage, detail: commit.detail };

  return { ok: true, changed: targets.length, ids: targets.map((e) => e.id), waived, commit: commit.commit };
}

/** 作者明确豁免一条债。理由必填，且进 Git——口头放过不算数。 */
export async function waiveDebt(workspaceRoot, bookTitle, id, reason) {
  if (!String(reason ?? "").trim()) {
    return { ok: false, stage: "reason-required", detail: "豁免必须写理由。这条会进 Git 提交历史，以后翻得到。" };
  }
  const ledger = await readLedger(workspaceRoot, bookTitle);
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry) return { ok: false, stage: "no-entry", detail: `台账里没有 ${id}` };
  // 未处置也算未清债，作者可以直接结清，不必绕道 chapter.blocked。
  if (!OPEN_STATUSES.includes(entry.status)) return { ok: false, stage: "already-settled", detail: `${id} 已经是「${entry.status}」，不用再豁免。` };

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
  if (!OPEN_STATUSES.includes(entry.status)) return { ok: false, stage: "already-settled", detail: `${id} 已经是「${entry.status}」。` };

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
  // 未处置（阻断项）同样算未清债。漏掉它，一条没答的 s2 会让整卷闸门显示
  // 「没有未清质量债，可以整卷定稿」——那是这个闸门最不该犯的错。
  const open = ledger.entries.filter((e) => OPEN_STATUSES.includes(e.status));
  const blocking = open.filter((e) => e.status === "未处置");
  const passed = open.length === 0;
  return {
    ok: true,
    passed,
    openCount: open.length,
    node: "debt.settle",
    detail: passed
      ? "没有未清质量债，可以整卷定稿。"
      : `还有 ${open.length} 条未清质量债（${open.map((e) => e.id).join("、")}）`
        + (blocking.length > 0
          ? `，其中 ${blocking.length} 条是还没处置的阻断项（${blocking.map((e) => e.id).join("、")}）`
          : "")
        + "。逐条处理，或由作者明确豁免并写理由。",
    ...gateCheck({ nodes: { "debt.settle": "stop" } }, "debt.settle"),
    blocked: !passed,
  };
}
