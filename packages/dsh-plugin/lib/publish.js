/**
 * 会话投影：把工具算出来的东西推给客户端面板。
 *
 * ── 2026-10-10 重大更正：这条路对**仓外插件**是封死的，而且硬走会毁掉会话 ──
 *
 * 以前这里写着「宿主自带的 todos 就是这么做的，所以运行时 API 走得通」。
 * 那个类比是错的。todo 能走通是因为 `todo/write` 是**仓内**事件类型：
 *   dsh-session/lib/types/types.d.ts:319  'todo/write': { todos: TodoItem[] }
 *   —— 注释还专门写了「Log-only UI state; never derived history」。
 *
 * 仓外插件没有这个待遇，证据三条：
 *   1. dsh-session/lib/types/index.d.ts:212
 *        append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts)
 *      T 被钉死在仓内类型的联合上；`...opts` 只有 SurfaceIntent
 *      （sourceEventSeqs / surfaceOp），**没有任何口子能设 ignorable**。
 *   2. dsh-session/lib/index.js:1050-1052 原文：
 *        「Downstream (out-of-repo) plugin events are outside this list by
 *          construction; a registration surface for them is deferred until
 *          such a consumer exists.」
 *      KNOWN_SESSION_EVENT_TYPES 是 gen-persistence-catalog 从仓内
 *      SessionEventMap 生成的，插件加不进去。
 *   3. dsh-session-persistence/lib/index.js:184
 *        if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
 *          throw unsupported(...)
 *      读回路径**拒读**整份日志。不是跳过这一条，是整份会话打不开。
 *
 * 后果是实测过的：本插件写过 `novelForge/state` 之后，重启 DSH，
 * 那个会话直接打不开——
 *   failed to observe session "…": contains event type "novelForge/state"
 *   (seq 22) unknown to this harness and not marked ignorable;
 *   refusing to interpret the log
 * 而且**写进去就拔不出来了**：事件已经落在 zstd 日志里，
 * 只要那一行还在，这个会话就永远读不回来（除非手工改日志）。
 *
 * 所以这里不再写事件。宁可面板没有数据（显示「数据不足」），
 * 也绝不能把作者的会话写成不可读——那是拿整本书换一个面板数字。
 *
 * 面板要真能工作，得等宿主给出仓外事件的注册面，或者给 append 开一个
 * 能标 ignorable 的口子。在那之前，这个功能就是**做不了**，不是「暂时没做」。
 *
 * 投影注册本身留着：key 在、值恒为 {}，客户端读到「数据不足」——
 * 这正是「坏数据显示数据不足，绝不伪装成正常态」该有的样子。
 */

export const PROJECTION_KEY = "novelForge";

/**
 * 曾经用来推状态的事件类型。
 *
 * **绝不能再 append 它。** 保留这个名字是因为 lib/index.js 的 apply 还在比对它，
 * 将来宿主开了注册面，改回 append 即可；但当前 append 一次 = 毁一个会话。
 */
export const PUBLISH_EVENT = "novelForge/state";

/** 为什么推不出去。测试与界面都用它说明「数据不足」的根因，而不是装作没这回事。 */
export const PUBLISH_BLOCKED_REASON =
  "宿主不给仓外插件注册会话事件类型，append 也没有设 ignorable 的口子；" +
  "硬写会让整份会话日志读不回来（dsh-session-persistence/lib/index.js:184）。";

/**
 * 状态 schema。宿主的 register() 只会对它调 .parse()，
 * 并不要求是 zod（zod 在本插件的解析路径里拿不到）。
 * 形状不对就退成空对象 —— 空对象在界面上显示「数据不足」，
 * 符合「坏数据显示数据不足，绝不伪装成正常态」。
 */
export const projectionStateSchema = {
  parse(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  },
};

/** 送出去的视图。只带界面上真要用的字段，不整包回传工具结果。 */
export function projectionView(state) {
  const s = state ?? {};
  const out = {};
  if (s.bookStatus !== undefined) out.bookStatus = s.bookStatus;
  if (s.materials !== undefined) out.materials = s.materials;
  if (s.director !== undefined) out.director = s.director;
  if (Array.isArray(s.gateList)) out.gateList = s.gateList;
  if (s.flavor !== undefined) out.flavor = s.flavor;
  if (s.scan !== undefined) out.scan = s.scan;
  if (s.ref !== undefined) out.ref = s.ref;
  return out;
}

/**
 * 把一段状态并进投影。
 *
 * **当前恒定返回 false，且绝不碰 session.append。** 见文件头：写自定义事件
 * 会把会话日志写成宿主读不回来的样子。
 *
 * 签名保持不变，是为了调用点（lib/index.js 的 withPublish）不用改，
 * 也为了宿主补上注册面之后能一处改回。
 *
 * @returns {boolean} 永远是 false —— 推不上去，面板显示「数据不足」。
 */
export function publish() {
  return false;
}

/** 闸门是列表：按 node 合并，同一个节点的最新一次覆盖旧的。 */
export function mergeGates(previous, incoming) {
  const byNode = new Map();
  for (const g of Array.isArray(previous) ? previous : []) byNode.set(g?.node ?? null, g);
  for (const g of Array.isArray(incoming) ? incoming : []) byNode.set(g?.node ?? null, g);
  return [...byNode.values()];
}
