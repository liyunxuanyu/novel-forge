/**
 * 章节流程状态机 —— 章节流水线的骨架。
 *
 * 状态分两处，这是阶段二那条原则的延续：
 *   · 真源状态（细纲已确认、定稿入档）从 Git 推导，不落文件。
 *   · 过程状态（候选稿、备料、审核）落在草稿区的 状态.json，因为它是过程物不是真源。
 * 状态.json 里记下每一步产生的 Git 提交，两边能互相校验。
 *
 * 关键闸门：审读没有发现项时，必须同时给出覆盖维度，否则拒绝流转——
 * 否则自动导演会把"什么都没审"当成"审过了"。
 */
import fs from "node:fs/promises";
import path from "node:path";

export const DRAFT_AREA = "草稿";

export const CHAPTER_STAGES = [
  "细纲待确认",
  "细纲已确认",
  "已备料",
  "起草中",
  "待审",
  "审读中",
  "待改",
  "待定稿",
  "已定稿",
];


/**
 * 改稿轮次上限。
 *
 * 技能手册里写着「最多三轮」，但约定挡不住真模型——一个每轮都能挑出新毛病的稿子
 * 会把无人值守的链条拖成死循环，而死循环本身就是需要人工救火。
 * 到顶之后交回作者：继续改，还是就这样定稿。
 */
export const MAX_REVISION_ROUNDS = 3;

/** 这一章已经派发过几轮审读。没流程记录就是 0。 */
export function reviewRoundsOf(state) {
  return state?.review?.revisions ?? 0;
}
/**
 * 篇幅下限比例。
 *
 * 目标字数以前只是提示词里的一句「目标篇幅：约 3000 字」——真模型交回 300 字的
 * 截断稿（上下文截断、偷懒、或者干脆写崩了），没人拦，照样定稿出厂。
 * 结果是一卷字斟句酌的空壳，而且日志上一片正常。
 *
 * 取一半：正文打个对折以内就不是这一章。留 `allowShort` 出口，
 * 短章（过场、楔子、番外）是合法体裁，不做陷阱。
 */
export const MIN_LENGTH_RATIO = 0.5;

/** 正文汉字数：与 import_draft 一致的口径，不计空白。 */
export function countWords(body) {
  return String(body ?? "").replace(/\s/g, "").length;
}

/**
 * 拿实际字数对照目标字数。target 缺失时放行——不是每本书都定了篇幅。
 * @returns {{ok:true}} 或 {{ok:false, stage:"too-short", detail:string}}
 */
export function checkChapterLength(words, target, label = "这一章") {
  const t = Number(target ?? 0);
  if (!Number.isFinite(t) || t <= 0) return { ok: true };
  const floor = Math.floor(t * MIN_LENGTH_RATIO);
  if (words >= floor) return { ok: true };
  return {
    ok: false, stage: "too-short",
    detail: `${label}只有 ${words} 字，目标 ${t} 字，下限 ${floor} 字（目标的一半）。` +
      "多半是起草子代理被截断了——重派一次，或确实要短章就带 allowShort 明确放行。",
  };
}

/** 状态迁移表。from 为 null 表示任意态都允许（重入）。 */
export const TRANSITIONS = {
  draft_outline: { from: null, to: "细纲待确认" },
  confirm_outline: { from: ["细纲待确认"], to: "细纲已确认" },
  assemble_materials: { from: ["细纲已确认", "已备料"], to: "已备料" },
  // 起草中也能再进一次：重派起草（上一次派失败了、或换了目标字数）不该被
  // 状态机挡住。挡住的话导演链会在这一步卡死，而卡死本身就是人工救火。
  build_draft_task: { from: ["已备料", "起草中"], to: "起草中" },
  import_draft: { from: ["起草中", "待审", "待改", "已备料"], to: "待审" },
  dispatch_review: { from: ["待审"], to: "审读中" },
  // 审读是按维度并行拆开跑的，每个审读子代理都可能自己回写一次，所以
  // 「待改」「待定稿」下也必须允许再回写——那是同一轮的后续维度在补交，
  // 不是越权。只允许「审读中」的话，第一个写完的维度会把门关上，
  // 后面几个维度的发现项全部被拒（真机上就是这么丢的：五维审出十几条，
  // 只有先落地的那个维度进了状态）。
  // 同一轮的多次回写由 recordFindings 按 itemsRound 合并；换了轮次就整份替换。
  record_findings: { from: ["审读中", "待改", "待定稿"], to: "按发现项定" },
  prepare_settlement: { from: ["待审", "待改", "审读中"], to: "待定稿" },
  settle: { from: ["待定稿"], to: "已定稿" },
};

export function chapterKey(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1) throw new Error(`章号必须是正整数，收到 ${n}`);
  return `ch${String(num).padStart(4, "0")}`;
}

export function parseChapterKey(key) {
  const m = /^ch(\d{4})$/.exec(String(key ?? ""));
  return m ? Number(m[1]) : null;
}

export function chapterDir(workspaceRoot, bookTitle, key) {
  return path.join(workspaceRoot, DRAFT_AREA, bookTitle, key);
}

export function newState(volume, key) {
  return {
    schema: 1,
    chapter: key,
    volume,
    stage: null,
    history: [],
    outline: { confirmed: false, commit: null },
    materials: { assembled: false, at: null },
    draftTask: { built: false, at: null },
    draft: { version: 0, latest: null, commit: null },
    review: { dispatched: false, findings: 0, covered: [], passed: false, record: null },
    settlement: { prepared: false, items: [], commit: null },
  };
}

function pushHistory(state, action, from, to, extra) {
  state.history.push({
    at: new Date().toISOString(),
    action,
    from,
    to,
    ...(extra ?? {}),
  });
}

export function canTransition(currentStage, action) {
  const rule = TRANSITIONS[action];
  if (!rule) return { ok: false, reason: `未知迁移 "${action}"` };
  if (currentStage === null) {
    return rule.from === null ? { ok: true, to: rule.to } : { ok: false, reason: `当前还没有任何流程状态，不能执行 "${action}"` };
  }
  if (rule.from === null) return { ok: true, to: rule.to };
  if (!rule.from.includes(currentStage)) {
    return {
      ok: false,
      reason: `当前状态「${currentStage}」不能执行 "${action}"，只允许在 ${rule.from.join(" / ")} 下执行`,
    };
  }
  return { ok: true, to: rule.to };
}

export async function readState(workspaceRoot, bookTitle, key) {
  const file = path.join(chapterDir(workspaceRoot, bookTitle, key), "状态.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeState(workspaceRoot, bookTitle, key, state) {
  const dir = chapterDir(workspaceRoot, bookTitle, key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "状态.json"), JSON.stringify(state, null, 2), "utf8");
  return state;
}

async function loadOrInit(workspaceRoot, bookTitle, key, volume) {
  return (await readState(workspaceRoot, bookTitle, key)) ?? newState(volume, key);
}

/**
 * 执行一次状态迁移。mutator 拿到 state 自行补充细节；返回 false 表示放弃本次迁移
 * （已由调用方判断）。commit 用于把产生的 Git 提交记进状态。
 */
export async function advance(workspaceRoot, bookTitle, key, volume, action, mutator, commit) {
  const state = await loadOrInit(workspaceRoot, bookTitle, key, volume);
  const from = state.stage;
  const gate = canTransition(from, action);
  if (!gate.ok) return { ok: false, stage: "transition", detail: gate.reason, state };

  const draft = {};
  if (typeof mutator === "function") {
    const outcome = await mutator(state, draft);
    if (outcome === false) {
      return { ok: false, stage: action, detail: draft.reason ?? "本次迁移被拒绝", state };
    }
  }

  const to = draft.to ?? gate.to;
  // 派发审读**就是**「新的一轮」这件事本身，所以轮次由状态机来数，而不是由
  // 某一个调用方记得去数。以前只有 dispatchReviewTool 手动 +1，任何直接走
  // advance 的入口（测试、脚本、以后新增的调用点）都不会让它动：于是
  // 「这一轮的发现项」和「上一轮的」分不开，回写时会把上一轮已经改掉的问题
  // 并进新一轮，稿子明明改干净了却一直判「待改」，改稿轮次上限也跟着失灵。
  if (action === "dispatch_review") {
    state.review = { ...(state.review ?? {}), revisions: (state.review?.revisions ?? 0) + 1 };
  }
  state.stage = to;
  if (commit) draft.commit = commit;
  pushHistory(state, action, from, to, { commit: draft.commit ?? null, ...(draft.note ? { note: draft.note } : {}) });
  await writeState(workspaceRoot, bookTitle, key, state);
  return { ok: true, stage: action, from, to: state, chapterKey: key };
}

/** 同一条发现项的指纹：引文与说明都逐字相同才算同一条。 */
function findingKey(f) {
  return `${String(f?.quote ?? "").trim()}\u0000${String(f?.note ?? "").trim()}`;
}

/**
 * 回写审读发现项。零发现项时必须给出 covered（本次审读了哪些维度），
 * 否则拒绝——这是"空审通过"的闸门。
 *
 * 两件事必须一起做对，否则「自动导演」在审读→改稿这一跳上会断掉：
 *
 * 1. **发现项正文要留下来**，不能只留条数。以前 `findings` 只存 `list.length`，
 *    于是改稿步骤（requires: draftText + findings）永远拿不到输入，只能
 *    missing-input，靠调用方把发现项再粘一遍——自动链在这里退化成人工搬运。
 * 2. **同一轮里的多次回写要合并**，不能整体覆盖。审读是按维度并行拆开的，
 *    每个审读子代理都可能自己回写一次；整体赋值的话**最后写的那一份赢**，
 *    五个维度审出十几条，落到状态里只剩一条，covered 也跟着缩成一个维度。
 *
 * 合并的边界是「轮」：dispatch_review 每派一轮就把 revisions 加一，所以
 * revisions 没变就是同一轮，该并；变了就是新一稿，上一轮的问题清单作废。
 */
export async function recordFindings(workspaceRoot, bookTitle, key, volume, { findings = [], covered = [], summary = "" }) {
  const list = Array.isArray(findings) ? findings : [];
  const dims = Array.isArray(covered) ? covered.filter((d) => String(d).trim() !== "") : [];

  if (list.length === 0 && dims.length === 0) {
    return {
      ok: false,
      stage: "empty-review",
      detail: "空审通过被拒绝：既没有发现项，也没有给出本次覆盖的审读维度。" +
        "要么给出发现项，要么在 covered 里列出确实审过的维度。",
    };
  }
  for (const f of list) {
    const quote = String(f?.quote ?? "").trim();
    const note = String(f?.note ?? "").trim();
    if (quote === "" || note === "") {
      return { ok: false, stage: "finding-invalid", detail: "每条发现项都要有 quote（逐字引文）和 note（问题说明）。" };
    }
  }

  const result = await advance(
    workspaceRoot, bookTitle, key, volume, "record_findings",
    (state, draft) => {
      // 展开在前：revisions 是这一章累计的审读轮次，回写发现项不能把它抹掉。
      // 抹掉的话改稿轮次上限永远数不到，改稿就成了没有尽头的循环。
      const round = state.review?.revisions ?? 0;
      const sameRound = state.review?.itemsRound === round && Array.isArray(state.review?.items);
      const prev = sameRound ? state.review.items : [];

      const seen = new Set(prev.map(findingKey));
      const merged = [...prev];
      for (const f of list) {
        const k = findingKey(f);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push({
          dimension: f.dimension ?? f.severity ?? null,
          quote: String(f.quote).trim(),
          note: String(f.note).trim(),
        });
      }
      const coveredMerged = sameRound ? [...new Set([...(state.review?.covered ?? []), ...dims])] : dims;

      state.review = {
        ...(state.review ?? {}),
        dispatched: true,
        findings: merged.length,
        items: merged,
        itemsRound: round,
        covered: coveredMerged,
        passed: merged.length === 0,
        summary: sameRound && state.review?.summary && summary
          ? `${state.review.summary}\n\n${summary}`
          : summary,
        record: new Date().toISOString(),
      };
      draft.to = merged.length === 0 ? "待定稿" : "待改";
      draft.note = merged.length === 0 ? `零发现项，覆盖 ${coveredMerged.length} 个维度` : `发现 ${merged.length} 条问题`;
    },
  );
  if (result.ok) result.pass = (result.to?.review?.findings ?? 0) === 0;
  return result;
}

/**
 * 把起草任务包的目标字数记进章节状态。
 *
 * 这不是记账，是**篇幅闸门的输入**：导入稿件时 checkChapterLength 拿
 * state.draftTask.targetWords 对账，而它对缺失的 target 是**放行**的
 * （「不是每本书都定了篇幅」）。所以忘了记 = 闸门静默失效，起草子代理
 * 交回三分之二篇幅的稿子也一路绿灯。导演链以前绕过 forge_draft_task，
 * draftTask.built 一直是 false，闸门在自动链上就是死的。
 */
export async function recordDraftTask(workspaceRoot, bookTitle, key, volume, { targetWords, packageHash = null } = {}) {
  const t = Number(targetWords);
  if (!Number.isFinite(t) || t <= 0) {
    return { ok: false, stage: "bad-target", detail: `目标字数必须是正数，收到 "${targetWords}"` };
  }
  return advance(workspaceRoot, bookTitle, key, volume, "build_draft_task", (s) => {
    s.draftTask = { built: true, at: new Date().toISOString(), packageHash, targetWords: t };
  });
}

/** 列出某本书草稿区里的全部章节状态，按章号升序。 */
export async function listChapterStates(workspaceRoot, bookTitle) {
  const dir = path.join(workspaceRoot, DRAFT_AREA, bookTitle);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (parseChapterKey(entry.name) === null) continue;
    const s = await readState(workspaceRoot, bookTitle, entry.name);
    if (s) states.push(s);
  }
  return states.sort((a, b) => parseChapterKey(a.chapter) - parseChapterKey(b.chapter));
}
