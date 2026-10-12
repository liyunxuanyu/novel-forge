/**
 * 自动生成，请勿手改。由 scripts/bundle-client.mjs 从下列源文件拼出：
 *   lib/ui-model.js
 *   lib/ui-components.js
 *   lib/client.js
 * 改行为请改源文件，然后重跑打包器。
 */
window.__ModuleLoader__.load({
	id: "dsh-novel-forge",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const { createElement } = require("react");


/* ── lib/ui-model.js ─────────────────────────────────── */
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
function insufficient(what, reason) {
  return { state: "insufficient", what, reason: what ? `${what}：数据不足` : "数据不足" };
}

function isUsable(x) {
  return x !== null && typeof x === "object" && x.ok === true;
}

/**
 * 嵌套载荷（如结果信封里的 status 对象）不带 ok 字段。
 * 之前拿 isUsable 判它，永远为假，徽标一直取不到数据。
 */
function isPayload(x) {
  return x !== null && typeof x === "object";
}

// ── 徽标 ─────────────────────────────────────────────────────────────────

/**
 * 会话视图右上角那一枚。
 * 只回答三件事：哪本书、写到第几章、现在卡在人工闸门上没有。
 */
function buildBadge(bookStatus) {
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
function badgeWithGate(badge, gate) {
  if (!gate || gate.ok !== true || gate.requiresDecision !== true) return badge;
  return {
    ...badge,
    tone: "blocked",
    detail: `待你裁决：${gate.question ?? gate.node ?? "有个闸门等着"}`,
    gateNode: gate.node ?? null,
  };
}

// ── 十段材料就绪度 ───────────────────────────────────────────────────────

function buildMaterials(materials) {
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
function buildAction(director) {
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

function buildGates(gateList) {
  const list = Array.isArray(gateList) ? gateList : [];
  const decisions = list
    .filter((g) => g && g.ok === true && g.requiresDecision === true)
    .map((g) => ({ node: g.node ?? null, level: g.level ?? null, question: g.question ?? null }));
  return { state: "ok", decisions, count: decisions.length };
}

/** 一个面板的完整视图模型。数据不足的段单独标出来，不整块崩。 */
function buildWorkspaceView(inputs) {
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
function buildFlavorView(scan) {
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

function buildScanView(scan) {
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

function buildRefProgress(ref) {
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
function buildAll(inputs) {
  return {
    workspace: buildWorkspaceView(inputs),
    flavor: buildFlavorView(inputs?.flavor),
    scan: buildScanView(inputs?.scan),
    ref: buildRefProgress(inputs?.ref),
  };
}


/* ── lib/ui-components.js ─────────────────────────────────── */
/**
 * 界面组件 —— 只渲染，不判断。
 *
 * 每个组件都从 `ui-model.js` 拿已经算好的视图模型，自己不做任何业务判断：
 * 不读盘、不推状态机、不判门禁、不自己判断「这句有没有 AI 味」。
 *
 * 组件绝不许抛异常（通过标准 3）：写作这件事不该被界面 bug 卡住。
 * 外层统一走 safe() 包一层，任何异常都退化成一行纯文本。
 *
 * **为什么是工厂而不是直接 import react**：
 * 宿主的客户端插件走 `window.__ModuleLoader__`，包体是 CJS 工厂 + `require`，
 * 里面没有 ESM 解析器。裸 `import "react"` 在浏览器里直接解析失败 ——
 * 2026-10-08 真机加载就是这么挂的（web boot: 1 entry did not activate）。
 * 改成从宿主注入 createElement，组件本身对 react 零依赖，还更好测。
 */

/** 造出整套组件。createElement 由调用方给（真机上来自 require("react")）。 */
function makeComponents(createElement) {
  const h = createElement;

  /** 包一层：渲染失败退化成纯文本，绝不把异常抛给宿主。 */
  function safe(Component, fallback = "Novel Forge") {
    return function Guarded(props) {
      try {
        return Component(props ?? {});
      } catch {
        return h("span", { title: "面板渲染失败，工具链不受影响" }, fallback);
      }
    };
  }

  function box(kind, tone, children, title) {
    return h(
      "div",
      { "data-forge": kind, "data-tone": tone ?? "normal", title: title ?? undefined },
      ...children,
    );
  }

  function text(value) {
    return h("span", null, String(value ?? ""));
  }

  /**
   * 读会话投影。宿主给每个 slot 组件发的 standardProps 里本来就有 useProjection
   * （宿主自带的 TodoDock 就是 `useProjection("todos")`），所以这里直接调。
   *
   * 拿不到就返回 null，组件退回 props.view 或显示「数据不足」——
   * 没数据就说没数据，绝不假装正常。
   */
  function useProjectionData(props) {
    const read = props?.useProjection;
    if (typeof read !== "function") return null;
    const value = read("novelForge");
    return value && typeof value === "object" ? value : null;
  }
  // ── 徽标 ───────────────────────────────────────────────────────────────

  function ForgeBadgeInner(props) {
    const data = useProjectionData(props);
    const v = props?.view ?? props?.badge ?? (data ? buildWorkspaceView(data).badge : null);
    if (!v || v.state === "insufficient") {
      return h("span", { "data-forge": "badge", "data-tone": "muted" }, `Novel Forge · ${v?.detail ?? "未连接书仓"}`);
    }
    return h(
      "span",
      { "data-forge": "badge", "data-tone": v.tone ?? "normal", title: v.detail ?? undefined },
      text(v.label),
      " · ",
      text(v.detail),
    );
  }

  // ── 十段材料 ───────────────────────────────────────────────────────────

  function MaterialsInner(props) {
    const v = props?.view;
    if (!v || v.state === "insufficient") return box("materials", "muted", [text(v?.reason ?? "十段材料：数据不足")]);
    return box("materials", v.missing.length === 0 ? "ok" : "warn", [
      h("span", { key: "h" }, `十段材料 ${v.ready}/${v.total}`),
      ...v.segments.map((s) =>
        h(
          "span",
          { key: s.id, "data-ready": String(s.ready), title: s.reason ?? undefined },
          s.ready ? "● " : "○ ",
          s.name,
        ),
      ),
    ]);
  }

  // ── 当前动作 ───────────────────────────────────────────────────────────

  function ActionInner(props) {
    const v = props?.view;
    if (!v || v.state === "insufficient") return box("action", "muted", [text(v?.reason ?? "当前动作：数据不足")]);
    return box("action", v.tone, [
      v.requiresDecision
        ? h("strong", { key: "q" }, `待你裁决：${v.question ?? v.node ?? "有个闸门等着"}`)
        : text(v.detail || v.node || "继续"),
    ]);
  }

  // ── 待决闸门 ───────────────────────────────────────────────────────────

  function GatesInner(props) {
    const v = props?.view;
    const list = v?.decisions ?? [];
    if (list.length === 0) return box("gates", "ok", [text("没有待决闸门")]);
    return box("gates", "blocked", [
      h("strong", { key: "h" }, `${list.length} 个待决闸门`),
      ...list.map((g, i) => h("div", { key: `${g.node ?? "g"}-${i}` }, `· ${g.question ?? g.node ?? "?"}`)),
    ]);
  }

  function WorkspacePanel(props) {
    const data = useProjectionData(props);
    const w = props?.view ?? (data ? buildWorkspaceView(data) : {});
    // 整体色调跟着待决闸门走，而不是只看当前动作：
    // 有闸门等着人来拍板，整块面板就该显出来，而不是被一条普通动作的色调盖过去。
    const tone = w?.gates?.count > 0 ? "blocked" : (w?.action?.tone ?? "normal");
    return box("workspace", tone, [
      h(safe(ForgeBadgeInner, "Novel Forge"), { key: "b", view: w.badge }),
      h(safe(MaterialsInner, "十段材料"), { key: "m", view: w.materials }),
      h(safe(ActionInner, "当前动作"), { key: "a", view: w.action }),
      h(safe(GatesInner, "闸门"), { key: "g", view: w.gates }),
    ]);
  }

  // ── AI 味清单 ──────────────────────────────────────────────────────────

  function FlavorInner(props) {
    const v = props?.view;
    if (!v || v.state === "insufficient") return box("flavor", "muted", [text(v?.reason ?? "AI 味：数据不足")]);
    if (v.clean) return box("flavor", "ok", [text(`${v.origin}：未命中`), h("small", { key: "d" }, text(v.disclaimer))]);
    return box("flavor", "warn", [
      h("strong", { key: "h" }, `${v.origin}：命中 ${v.total} 处（只报不改）`),
      ...v.groups.map((g) =>
        h(
          "div",
          { key: `l${g.line}`, "data-line": g.line, title: g.notes.join("；") },
          `第 ${g.line} 行　${g.text}`,
          ...(g.notes.length > 0 ? [h("small", { key: "n" }, `　${g.notes.join("；")}`)] : []),
        ),
      ),
      h("small", { key: "d" }, text(v.disclaimer)),
    ]);
  }

  // ── 扫榜 ───────────────────────────────────────────────────────────────

  function ScanInner(props) {
    const v = props?.view;
    if (!v || v.state === "insufficient") return box("scan", "muted", [text(v?.reason ?? "扫榜：数据不足")]);
    if (v.total === 0) return box("scan", "muted", [text("没有可扫的机制")]);
    return box("scan", "normal", [
      h("strong", { key: "h" }, `可用 ${v.tally["可用"]} · 要改着用 ${v.tally["要改着用"]} · 别用 ${v.tally["别用"]}`),
      ...v.rows.map((r, i) =>
        h(
          "div",
          { key: r.id ?? `r${i}`, "data-verdict": r.verdict, "data-tone": r.tone, title: r.reason },
          `${r.tone === "blocked" ? "✗" : r.tone === "ok" ? "✓" : "△"} ${r.name}${r.kind ? `（${r.kind}）` : ""}`,
        ),
      ),
    ]);
  }

  // ── 拆书进度 ───────────────────────────────────────────────────────────

  function RefInner(props) {
    const v = props?.view;
    if (!v || v.state === "insufficient") return box("ref", "muted", [text(v?.reason ?? "拆书进度：数据不足")]);
    const pct = Math.round(v.ratio * 100);
    return box("ref", v.complete ? "ok" : v.consented ? "normal" : "warn", [
      h("span", { key: "h" }, `${v.sourceId}：${v.done}/${v.total} 批（${pct}%），机制 ${v.mechanismCount} 条`),
      v.next ? h("span", { key: "n" }, `　下一批 ${v.next}`) : null,
      v.consented ? null : h("strong", { key: "c" }, "　尚未记录处理许可"),
    ]);
  }

  const ForgeBadge = safe(ForgeBadgeInner, "Novel Forge");
  return {
    ForgeBadge,
    MaterialsPanel: safe(MaterialsInner, "十段材料"),
    ActionPanel: safe(ActionInner, "当前动作"),
    GatesPanel: safe(GatesInner, "闸门"),
    WorkspacePanel: safe(WorkspacePanel, "工作台"),
    FlavorPanel: safe(FlavorInner, "AI 味清单"),
    ScanPanel: safe(ScanInner, "扫榜"),
    RefPanel: safe(RefInner, "拆书进度"),
  };
}


/* ── lib/client.js ─────────────────────────────────── */
/**
 * Novel Forge —— 浏览器侧入口的**源码**。
 *
 * 注意：浏览器加载的不是这个文件，而是由 scripts/bundle-client.mjs 生成的
 * lib/client.bundle.js。宿主的客户端插件走 `window.__ModuleLoader__`，
 * 那是个 CJS 工厂 + require，没有 ESM 解析器 —— 裸 import 在浏览器里解析不了。
 * 所以源码保持 ESM（好测），发布时转成 __ModuleLoader__ 形态。
 *
 * 注册两个位置，都是 **list 型** slot：
 *   conversation.session.header.utilities → 徽标（右上角）
 *   conversation.input.dock              → 工作台面板（输入框上方整宽）
 *
 * 为什么不用 conversation.session.header.corner：它是 **single** 型，
 * 占过去就跟别人撞上并直接抛错，会把别的插件顶掉。list 型是追加，安全。
 *
 * 组件只渲染，数据由 ui-model.js 算好后从 props 进来。
 * 这里不做任何业务判断，也绝不因为渲染失败而影响工具链。
 */

const UTILITIES = "conversation.session.header.utilities";

/**
 * 造出入口。createElement 由调用方注入：
 *   真机 = require("react").createElement
 *   测试 = 从 react 拿的同一个
 * 组件因此对 react 零静态依赖。
 */
function createEntry(createElement) {
  const COMPONENTS = makeComponents(createElement);

  /** 注册描述符集中在这里，测试直接对着它验。 */
  // 只留右上角徽标。
  //
  // 工作台面板原先挂在 conversation.input.dock（输入框上方整宽）。真机看下来
  // 作者说「位置不好，不要放这里，后面放书架里面」——那一整块压在输入区上方，太吵。
  //
  // 面板要挪进书架。宿主给出的两个候选（读自 slot 契约表）：
  //   sidebar.panellist（图标，replaceRisk: none）+ main（面板体，key 相同）
  //     —— 但 main 的 standardProps 里**没有** useProjection，读不到会话投影。
  //   sidebar.right.pane.tab（右侧面板 tab，scope: session）
  //     —— standardProps 里**有** useProjection，scriptor 也是走这条。
  // 所以书架落 sidebar.right.pane.tab。
  //
  // 在书架做出来之前先不挂：宁可不显示，也不占着输入框。
  // WorkspacePanel 组件本身留着，挪过去时直接用。
  const ENTRIES = [
    { slot: UTILITIES, component: "ForgeBadge", id: "novel-forge-badge", label: "Novel Forge", order: 100 },
  ];

  function apply(ctx) {
    if (typeof ctx?.logger?.info !== "function") return undefined;

    const slots = typeof ctx.get === "function" ? ctx.get("slots") : undefined;
    if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
      // 宿主没有 slots 服务：只记一条日志，不抛。
      // 面板挂不上不影响任何工具——工具是另一条路注册的。
      ctx.logger.warn?.("[novel-forge] 宿主缺少 slots 服务，界面面板未挂载；工具链不受影响。");
      return undefined;
    }

    const fibers = [];
    // inject 返回的是 disposer，不是描述符——只有 factory 真跑起来才算挂上。
    // 按 fiber 数统计会把「slot 没声明、什么都没注册」报成 2/2。
    let mounted = 0;
    for (const entry of ENTRIES) {
      try {
        fibers.push(
          slots.inject(entry.slot, () => {
            const reg = slots.register(
              {
                name: entry.slot,
                id: entry.id,
                label: entry.label,
                order: entry.order,
                locale: "conversation",
                // 组件从 props 拿 view；没有 view 就显示数据不足。
                inject: () => ({}),
              },
              COMPONENTS[entry.component],
            );
            mounted += 1;
            return reg;
          }),
        );
      } catch (error) {
        // 一个面板注册失败不能拖垮另一个，更不能拖垮插件。
        ctx.logger.warn?.(`[novel-forge] ${entry.slot} 注册失败：${error?.message ?? error}`);
      }
    }

    ctx.logger.info(`[novel-forge] 客户端入口已加载（${mounted}/${ENTRIES.length} 个面板挂载）`);

    return () => {
      for (const fiber of fibers) {
        try {
          if (fiber && typeof fiber.dispose === "function") fiber.dispose();
        } catch {
          /* 卸载失败不影响别的 */
        }
      }
    };
  }

  return { ENTRIES, apply };
}


		const __entry = createEntry(createElement);
		module.exports = { name: "novel-forge-client", apply: __entry.apply, ENTRIES: __entry.ENTRIES };
		return module.exports;
	},
});
