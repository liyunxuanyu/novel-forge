/**
 * 会话投影：把工具算出来的东西推给客户端面板。
 *
 * 为什么是这条路：宿主给每个 slot 组件发的 standardProps 里**本来就有**
 * `useProjection`（见 dsh-cordis-client-runner 的 slot 契约表，
 * conversation.input.dock 与 conversation.session.header.utilities 都有）。
 * 宿主自带的 todos 就是这么做的：
 *   dsh-tool-todo        ctx.sessionProjections.register({ key: "todos", … })
 *                        exec.agent.session.append("todo/write", { todos })
 *   dsh-client-ui-…      function TodoDock({ useProjection }) { … useProjection("todos") … }
 * 全程运行时 API，**不需要 typert 生成器**。
 * stages.md 里「数据通路被宿主工具链挡死」那条结论因此作废。
 *
 * 铁律：**推送失败绝不能让工具失败。**
 * 面板没数据只该显示「数据不足」，不该把一次成功的写作搞挂。
 */

export const PROJECTION_KEY = "novelForge";
export const PUBLISH_EVENT = "novelForge/state";

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
 * @returns {boolean} 真的推上去了才 true；没会话、没 append、抛错都是 false。
 */
export function publish(exec, patch) {
  try {
    const session = exec?.agent?.session;
    if (!session || typeof session.append !== "function") return false;
    if (!patch || typeof patch !== "object") return false;
    session.append(PUBLISH_EVENT, patch);
    return true;
  } catch {
    // 推送是锦上添花，绝不能把工具本身搞挂。
    return false;
  }
}

/** 闸门是列表：按 node 合并，同一个节点的最新一次覆盖旧的。 */
export function mergeGates(previous, incoming) {
  const byNode = new Map();
  for (const g of Array.isArray(previous) ? previous : []) byNode.set(g?.node ?? null, g);
  for (const g of Array.isArray(incoming) ? incoming : []) byNode.set(g?.node ?? null, g);
  return [...byNode.values()];
}