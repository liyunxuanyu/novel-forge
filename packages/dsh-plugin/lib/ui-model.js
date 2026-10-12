/**
 * 界面视图模型 —— 纯函数。
 *
 * 这一层是「UI 零业务判断」的落地方式：所有判断（该做什么、哪条 stop、
 * 哪句 AI 味、哪条机制别用）都在既有工具里算完了，这里只做**搬运与排版**。
 * 组件拿到什么就渲染什么，不自己读盘、不自己推状态机、不自己判门禁。
 *
 * 输入全部是既有工具的输出对象，一个字段都不新增：
 *   forge_book_status   → { ok, books?, status? }
 *   assembleMaterials   → { segments: [{ id, name, status, reason? }] }
 *   forge_director_next → { ok, node?, requiresDecision?, question?, detail? }
 *   forge_gate_check    → { ok, node, level, requiresDecision, question }
 *   forge_ai_flavor_scan→ { ok, origin, lines, sentences, total, byKind, groups }
 *   forge_scan_mechanisms → { ok, total, tally, rows }
 *   forge_ref_status    → { ok, totalBatches, doneBatches, complete, consented }
 *
 * 坏数据不许崩。缺什么就显示「数据不足」，不静默渲染成"没问题"——
 * 一个把坏数据显示成好消息的面板比没有面板更坏。
 */

/** 统一的数据不足态。永远显式，绝不假装正常。 */
export function insufficient(what, reason) {
  return { state: "insufficient", what, reason: what ? `${what}：数据不足` : "数据不足" };
}

export function isUsable(x) {
  return x !== null && typeof x === "object" && x.ok === true;
}

/**
 * 嵌套载荷（如结果信封里的 status 对象）不带 ok 字段。
 * 之前拿 isUsable 判它，永远为假，徽标一直取不到数据。
 */
export function isPayload(x) {
  return x !== null && typeof x === "object";
}

// ── 徽标 ─────────────────────────────────────────────────────────────────

/**
 * 会话视图右上角那一枚。
 * 只回答三件事：哪本书、写到第几章、现在卡在人工闸门上没有。
 */
export function buildBadge(bookStatus) {
  if (!isUsable(bookStatus)) return { state: "insufficient", tone: "muted", label: "Novel Forge", detail: "未连接书仓" };
  const books = Array.isArray(bookStatus.books) ? bookStatus.books : [];
  const hasStatus = isPayload(bookStatus.status);
  if (!hasStatus && books.length === 0) return { state: "insufficient", tone: "muted", label: "Novel Forge", detail: "书仓里还没有书" };
  const s = hasStatus ? bookStatus.status : books[0];
  const count = Number(s.finalizedChapterCount ?? 0);
  const label = String(s.title ?? "(未命名)");
  return {
    state: "ok",
    tone: "normal",
    label,
    detail: count > 0 ? `已定稿 ${count} 章${s.lastChapter ? ` · 最新 ${s.lastChapter}` : ""}` : "还没定稿章节",
    chapterCount: count,
    bookId: s.bookId ?? null,
  };
}

/** 把一个待决闸门叠到徽标上——这是最该在界面上被看见的东西。 */
export function badgeWithGate(badge, gate) {
  if (!gate || gate.ok !== true || gate.requiresDecision !== true) return badge;
  return {
    ...badge,
    tone: "blocked",
    detail: `待你裁决：${gate.question ?? gate.node ?? "有个闸门等着"}`,
    gateNode: gate.node ?? null,
  };
}

// ── 十段材料就绪度 ───────────────────────────────────────────────────────

export function buildMaterials(materials) {
  if (!materials || !Array.isArray(materials.segments)) return insufficient("十段材料");
  const segments = materials.segments.map((s) => ({
    id: String(s?.id ?? "?"),
    name: String(s?.name ?? s?.id ?? "?"),
    ready: s?.status === "ready" || s?.ready === true,
    reason: s?.reason ?? null,
  }));
  const ready = segments.filter((s) => s.ready).length;
  return {
    state: "ok",
    segments,
    ready,
    total: segments.length,
    ratio: segments.length === 0 ? 1 : ready / segments.length,
    missing: segments.filter((s) => !s.ready),
  };
}

// ── 当前该做什么 + 待决闸门 ─────────────────────────────────────────────

/**
 * 面板不该自己判断该做什么。导演算出来什么就显示什么，
 * requiresDecision 为真时单独提出来置顶——那是唯一必须人来拍板的东西。
 */
export function buildAction(director) {
  if (!isUsable(director)) return insufficient("当前动作");
  const requiresDecision = director.requiresDecision === true;
  return {
    state: "ok",
    node: director.node ?? null,
    question: director.question ?? null,
    requiresDecision,
    detail: director.detail ?? director.summary ?? "",
    level: director.level ?? null,
    tone: requiresDecision ? "blocked" : "normal",
  };
}

export function buildGates(gateList) {
  const list = Array.isArray(gateList) ? gateList : [];
  const decisions = list
    .filter((g) => g && g.ok === true && g.requiresDecision === true)
    .map((g) => ({ node: g.node ?? null, level: g.level ?? null, question: g.question ?? null }));
  return { state: "ok", decisions, count: decisions.length };
}

/** 一个面板的完整视图模型。数据不足的段单独标出来，不整块崩。 */
export function buildWorkspaceView(inputs) {
  const { bookStatus, materials, director, gateList } = inputs ?? {};
  return {
    badge: badgeWithGate(buildBadge(bookStatus), Array.isArray(gateList) ? gateList.find((g) => g?.ok === true && g.requiresDecision === true) : null),
    materials: buildMaterials(materials),
    action: buildAction(director),
    gates: buildGates(gateList),
  };
}

// ── AI 味清单 ────────────────────────────────────────────────────────────

/** 只报不改。面板把「行号 + 原句 + 为什么」摊开，改不改由人决定。 */
export function buildFlavorView(scan) {
  if (!isUsable(scan)) return insufficient("AI 味检测");
  const groups = Array.isArray(scan.groups) ? scan.groups : [];
  const total = Number(scan.total ?? groups.length);
  return {
    state: "ok",
    origin: String(scan.origin ?? "(未知来源)"),
    lines: Number(scan.lines ?? 0),
    sentences: Number(scan.sentences ?? 0),
    total,
    clean: total === 0,
    groups: groups.map((g) => ({
      line: Number(g?.line ?? 0),
      text: String(g?.text ?? ""),
      notes: Array.isArray(g?.notes) ? g.notes.map(String) : [],
    })),
    byKind: scan.byKind ?? {},
    disclaimer: "只报不改。五类判据覆盖不了 AI 味的全部，检测不出来不等于写得对。",
  };
}

// ── 扫榜 ─────────────────────────────────────────────────────────────────

const VERDICT_TONE = { "可用": "ok", "要改着用": "warn", "别用": "blocked" };

export function buildScanView(scan) {
  if (!isUsable(scan)) return insufficient("扫榜");
  const rows = Array.isArray(scan.rows) ? scan.rows : [];
  return {
    state: "ok",
    total: Number(scan.total ?? rows.length),
    tally: scan.tally ?? { "可用": 0, "要改着用": 0, "别用": 0 },
    rows: rows.map((r) => ({
      id: r?.id ?? null,
      name: String(r?.name ?? "(无名)"),
      kind: r?.kind ?? null,
      verdict: String(r?.verdict ?? "要改着用"),
      tone: VERDICT_TONE[r?.verdict] ?? "warn",
      reason: String(r?.reason ?? ""),
    })),
  };
}

// ── 拆书进度 ─────────────────────────────────────────────────────────────

export function buildRefProgress(ref) {
  if (!isUsable(ref)) return insufficient("拆书进度");
  const total = Number(ref.totalBatches ?? 0);
  const done = Number(ref.doneBatches ?? 0);
  return {
    state: "ok",
    sourceId: String(ref.sourceId ?? ""),
    total,
    done,
    ratio: total === 0 ? 1 : done / total,
    complete: ref.complete === true,
    mechanismCount: Number(ref.mechanismCount ?? 0),
    consented: ref.consented === true,
    next: ref.nextFrom ? `第 ${ref.nextFrom}–${ref.nextTo} 行` : null,
  };
}

/** 全部面板一次性成形，供测试与宿主侧共用。 */
export function buildAll(inputs) {
  return {
    workspace: buildWorkspaceView(inputs),
    flavor: buildFlavorView(inputs?.flavor),
    scan: buildScanView(inputs?.scan),
    ref: buildRefProgress(inputs?.ref),
  };
}
