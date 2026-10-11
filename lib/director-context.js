/**
 * 施工单的自动取材 —— 让导演链真的「自动」。
 *
 * 导演每一步都要给子代理一段自包含的任务文本，而那段文本里必须嵌着真源原文：
 * 卷纲、契约红线、上一章结尾、伏笔台账。这些内容**书仓里本来就有**，而且多半
 * 就是上一步刚确认进真源的。
 *
 * 以前这一步要求调用方先把它们一段段复制进 context，复制漏一段，子代理就拿着
 * 「（调用方未提供）」四个字去写——写出来的东西看起来很正常，错得很安静。
 * 更糟的是它把「自动导演」降级成了「人工搬运」：作者得盯着每一步，把刚确认过的
 * 卷纲再粘一遍。
 *
 * 所以这里按材料层的同一套解析规则去真源里取，调用方显式给的一律优先。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assembleMaterials, buildDraftTask, guessVolume } from "./materials.js";
import { chapterKey, chapterDir, readState } from "./chapter-state.js";
import { STEP_SPECS } from "./director.js";

/** 真源分段 id → 施工单 context 里的键。 */
const FROM_SEGMENT = {
  volumePlan: "volumePlan",
  contract: "contract",
  foreshadow: "foreshadow",
  prevChapter: "prevChapter",
};

/**
 * 只在步骤**显式要求**时才取的分段。
 *
 * 上面那四个是每一步都可能要的（细纲要看卷纲与上一章，改稿要看契约），
 * 所以无条件补。这两个不一样：给细纲塞一份人物表、给审读塞一份写法库，
 * 都只是让返回体变大，不解决任何问题。
 *
 * `characters` 是给改稿者的：改稿的规矩是「人名一个字都不能动」，可它手上
 * 从来没有人物材料——于是「材料里给了名字、正文通篇没写出来」这种**漏**
 * 它补不了，也看不出是漏。第 1 章就是这样：设定里写着「主角：周砚」，
 * 而任务包只装进了舅妈，稿子全程用「他」，改稿者连该补什么都不知道。
 */
const EXTRA_SEGMENT = { characters: "characters", style: "styleBrief" };

/**
 * 空串和纯空白不算「调用方给过」——那跟没给一样，却会把自动取材顶掉，
 * 结果还是「（调用方未提供）」，只不过错得更难查。
 */
function isGiven(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 只保留真正给过值的键。 */
export function givenOnly(supplied) {
  const out = {};
  for (const [k, v] of Object.entries(supplied ?? {})) if (isGiven(v)) out[k] = v;
  return out;
}

/**
 * 把这一步缺的真源内容补齐。
 *
 * 非章节步骤、以及不需要模型的纯工具步骤（备料、定稿）原样返回——
 * 给它们塞材料只会让返回体无谓地变大。
 */
export async function autoFillContext(workspaceRoot, bookTitle, action, supplied = {}) {
  const out = givenOnly(supplied);

  const spec = action?.kind === "chapter" ? STEP_SPECS[action.step] : null;
  if (!spec?.needsModel) return out;

  const key = chapterKey(action.chapter);
  const volume = Number.isInteger(action.volume) ? action.volume : guessVolume(key);
  const state = await readState(workspaceRoot, bookTitle, key).catch(() => null);

  const needTask = spec.requires?.includes("taskText") ?? false;
  if (needTask || Object.keys(FROM_SEGMENT).length > 0) {
    const materials = await assembleMaterials(workspaceRoot, bookTitle, key, { volume });
    const byId = new Map(materials.segments.map((s) => [s.id, s]));

    for (const [segId, ctxKey] of Object.entries(FROM_SEGMENT)) {
      if (out[ctxKey] !== undefined) continue;
      const seg = byId.get(segId);
      if (seg?.ok && seg.content.trim() !== "") out[ctxKey] = seg.content;
    }

    // 补料：步骤在 wantsContext 里点名的才取，且**取不到也照常跑**。
    // 判据是 wantsContext 而不是 requires——requires 是硬性必需，缺了要由
    // missing-input 闸门拦下；补料不是必需项。放进 requires 是个真犯过的错：
    // 这本书没有自定义文风，styleBrief 取到空，闸门把整条链拦死，
    // 而 oh-story 对这种情况的处置是「未进入自定义文风模式」，继续写。
    for (const [segId, ctxKey] of Object.entries(EXTRA_SEGMENT)) {
      if (!(spec.wantsContext ?? []).includes(ctxKey)) continue;
      if (out[ctxKey] !== undefined) continue;
      const seg = byId.get(segId);
      if (seg?.ok && seg.content.trim() !== "") out[ctxKey] = seg.content;
    }

    // 细纲按步骤给，不能一律塞进 FROM_SEGMENT：
    // 起草细纲的人**不该**先拿到细纲（那是他该提的方案，先给了等于替他定好）；
    // 改稿的人**必须**拿到（细纲里的〔硬〕约束是他判断「这条发现项能不能照办」
    // 的唯一依据）。真机上就是这么翻的车：改稿子代理只拿到正文与发现项，
    // 于是照着「给『数』一个具体所指」去改，正好撞上细纲〔硬〕「不写他在数什么」——
    // 发现项本身没错，改稿者却没有否决它的依据，只能照办，改完又出新问题。
    if ((spec.requires ?? []).includes("outlineBrief") && out.outlineBrief === undefined) {
      const seg = byId.get("task");
      if (seg?.ok && seg.content.trim() !== "") out.outlineBrief = seg.content;
    }

    // 起草要的是任务包，不是一堆分段。用同一份材料现场组，而不是让调用方
    // 再走一遍 forge_draft_task —— 两条路各生成一份，早晚会分叉，
    // 而子代理拿到哪一份全看调用顺序。
    if (needTask && out.taskText === undefined) {
      const targetWords = Number(state?.draftTask?.targetWords) || 3000;
      out.taskText = buildDraftTask(materials, { title: bookTitle, targetWords });
      // 把这一步用的目标字数一并交回调用方。**这里只算不写**——plan 是干跑，
      // 不该动状态；真正落库由 runTool 在跑之前做。
      // 不落库的后果不是「少记一笔账」：导入时的篇幅闸门拿 target 对账，
      // 而它对缺失的 target 是放行的，闸门会静默失效。
      out.__draftTask = { targetWords, packageHash: materials.packageHash ?? null };
    }
  }

  // 审读与改稿要的是「当前这一稿」。让调用方手喂等于把正文复制一遍，
  // 复制错了，审读的就是另一篇——直接从流程状态里取那一稿。
  if ((spec.requires?.includes("draftText") ?? false) && out.draftText === undefined) {
    const rel = state?.draft?.latest ?? null;
    if (rel) {
      const abs = path.join(chapterDir(workspaceRoot, bookTitle, key), rel);
      const body = await fs.readFile(abs, "utf8").catch(() => "");
      if (body.trim() !== "") out.draftText = body;
    }
  }

  // 改稿要的是「上一轮审出来的问题」。以前这里没有取处——recordFindings 只存
  // 条数不存正文——于是改稿这一步永远 missing-input，只能由调用方把发现项
  // 再粘一遍。现在从流程状态里取，审读→改稿这一跳才真的能自动接上。
  if ((spec.requires?.includes("findings") ?? false) && out.findings === undefined) {
    const items = state?.review?.items;
    if (Array.isArray(items) && items.length > 0) out.findings = items;
  }

  return out;
}
