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
import { makeComponents } from "./ui-components.js";

const UTILITIES = "conversation.session.header.utilities";
const INPUT_DOCK = "conversation.input.dock";

/**
 * 造出入口。createElement 由调用方注入：
 *   真机 = require("react").createElement
 *   测试 = 从 react 拿的同一个
 * 组件因此对 react 零静态依赖。
 */
export function createEntry(createElement) {
  const COMPONENTS = makeComponents(createElement);

  /** 注册描述符集中在这里，测试直接对着它验。 */
  const ENTRIES = [
    { slot: UTILITIES, component: "ForgeBadge", id: "novel-forge-badge", label: "Novel Forge", order: 100 },
    { slot: INPUT_DOCK, component: "WorkspacePanel", id: "novel-forge-workspace", label: "Novel Forge 工作台", order: 100 },
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
