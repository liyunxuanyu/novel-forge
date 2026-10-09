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
  build_draft_task: { from: ["已备料"], to: "起草中" },
  import_draft: { from: ["起草中", "待审", "待改", "已备料"], to: "待审" },
  dispatch_review: { from: ["待审"], to: "审读中" },
  record_findings: { from: ["审读中"], to: "按发现项定" },
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
  state.stage = to;
  if (commit) draft.commit = commit;
  pushHistory(state, action, from, to, { commit: draft.commit ?? null, ...(draft.note ? { note: draft.note } : {}) });
  await writeState(workspaceRoot, bookTitle, key, state);
  return { ok: true, stage: action, from, to: state, chapterKey: key };
}

/**
 * 回写审读发现项。零发现项时必须给出 covered（本次审读了哪些维度），
 * 否则拒绝——这是"空审通过"的闸门。
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
      state.review = {
        ...(state.review ?? {}),
        dispatched: true,
        findings: list.length,
        covered: dims,
        passed: list.length === 0,
        summary,
        record: new Date().toISOString(),
      };
      draft.to = list.length === 0 ? "待定稿" : "待改";
      draft.note = list.length === 0 ? `零发现项，覆盖 ${dims.length} 个维度` : `发现 ${list.length} 条问题`;
    },
  );
  if (result.ok) result.pass = list.length === 0;
  return result;
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
