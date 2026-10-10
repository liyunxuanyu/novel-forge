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

    // 起草要的是任务包，不是一堆分段。用同一份材料现场组，而不是让调用方
    // 再走一遍 forge_draft_task —— 两条路各生成一份，早晚会分叉，
    // 而子代理拿到哪一份全看调用顺序。
    if (needTask && out.taskText === undefined) {
      const targetWords = Number(state?.draftTask?.targetWords) || 3000;
      out.taskText = buildDraftTask(materials, { title: bookTitle, targetWords });
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

  return out;
}
