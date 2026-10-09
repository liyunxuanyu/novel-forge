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
export function makeComponents(createElement) {
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

  // ── 徽标 ───────────────────────────────────────────────────────────────

  function ForgeBadgeInner(props) {
    const v = props?.view ?? props?.badge ?? null;
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
    const w = props?.view ?? {};
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
