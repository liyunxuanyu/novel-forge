/**
 * 十段基础材料 —— 让起草子代理在零会话上下文下也能写对。
 *
 * 每段材料都带来源路径、内容哈希与过期判定：
 *   · 有内容 → 起草任务包自包含，子代理不需要再读任何东西
 *   · 来源变了 → 标过期，重新组装，不静默沿用旧摘录
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { LAYOUT, bookPaths } from "./warehouse.js";

const hash = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
const pad2 = (n) => String(n).padStart(2, "0");
const chapterNum = (key) => {
  const m = /^ch(\d{4})$/.exec(String(key ?? ""));
  return m ? Number(m[1]) : 1;
};

/** 粗略卷号推断：每 20 章一卷。真实卷号以书仓里的 卷NN 目录为准。 */
export function guessVolume(chapter) {
  return Math.max(1, Math.ceil(chapterNum(chapter) / 20));
}

export const SEGMENTS = [
  { id: "task", name: "本章任务", kind: "truth", describe: "本章要发生什么、必须落到的结果",
    resolve: ({ chapter, volume }) => [
      `${LAYOUT.outline}/卷${pad2(volume)}/${chapter}-细纲.md`,
      `${LAYOUT.outline}/卷${pad2(volume)}/${chapter}.md`,
    ] },
  { id: "prevChapter", name: "上一章结尾", kind: "truth", describe: "上一章末尾原文，接笔时必须无缝",
    resolve: ({ chapter, volume }) => {
      const n = chapterNum(chapter) - 1;
      if (n < 1) return [];
      const out = [];
      for (const dv of [0, -1, 1]) {
        const v = volume + dv;
        if (v < 1) continue;
        out.push(`${LAYOUT.final}/卷${pad2(v)}/${String(n).padStart(4, "0")}-*.md`);
      }
      return out;
    } },
  { id: "recap", name: "前情提要", kind: "truth", describe: "到本章为止的已定稿事实摘要",
    resolve: () => [`${LAYOUT.ledger}/前情提要.md`] },
  { id: "characters", name: "相关人物", kind: "truth", describe: "本章出场人物的身份、动机、当前处境与说话方式",
    resolve: () => [`${LAYOUT.setting}/人物/*.md`] },
  { id: "settings", name: "场景与规则", kind: "truth", describe: "本章场景设定与该世界生效的规则",
    resolve: () => [`${LAYOUT.setting}/地点/*.md`, `${LAYOUT.setting}/规则/*.md`] },
  { id: "contract", name: "契约与红线", kind: "truth", describe: "作品契约与明确不要什么——违反即退稿",
    resolve: () => [`${LAYOUT.contract}/作品契约.md`] },
  { id: "foreshadow", name: "伏笔与线索", kind: "truth", describe: "当前已埋、待收的线索与悬念",
    resolve: () => [`${LAYOUT.ledger}/伏笔台账.md`] },
  { id: "volumePlan", name: "卷规划与节奏位置", kind: "truth", describe: "本章在整卷里的位置与节奏要求",
    resolve: ({ volume }) => [`${LAYOUT.outline}/卷${pad2(volume)}/卷纲.md`] },
  { id: "style", name: "风格基准", kind: "memory", describe: "作者已确认的文风与写法约定，含从已定稿沉淀出来的本书写法库",
    resolve: () => [`${LAYOUT.setting}/写法/*.md`, `${LAYOUT.studio}/作者记忆/*.md`] },
  { id: "authorNote", name: "作者本次指令", kind: "supplement", describe: "作者对这一章的额外要求；没有就明说没有",
    resolve: () => [] },
];

async function resolveOne(baseRoot, candidates) {
  for (const candidate of candidates ?? []) {
    if (candidate.includes("*")) {
      const dir = path.dirname(path.join(baseRoot, candidate));
      const needle = path.basename(candidate).replace(/\*/g, "");
      let entries;
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      const hit = entries.filter((f) => f.includes(needle)).sort().pop();
      if (hit) return path.join(dir, hit);
      continue;
    }
    const abs = path.join(baseRoot, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

async function readSegment(workspaceRoot, bookTitle, chapter, volume, seg, extras) {
  const base = { id: seg.id, name: seg.name, kind: seg.kind, describe: seg.describe };

  if (seg.kind === "supplement") {
    const text = String(extras?.authorNote ?? "").trim();
    if (text === "") return { ...base, ok: false, content: "", reason: "作者未给本章额外指令" };
    return { ...base, ok: true, content: text, source: "本次补充", hash: hash(text) };
  }

  const baseRoot = seg.kind === "memory"
    ? workspaceRoot
    : bookPaths(workspaceRoot, bookTitle).base;

  const hit = await resolveOne(baseRoot, seg.resolve({ chapter, volume, workspaceRoot, book: bookTitle }));
  if (!hit) return { ...base, ok: false, content: "", reason: "真源里还没有这一段" };

  const text = await fs.readFile(hit, "utf8");
  return {
    ...base,
    ok: true,
    content: text,
    source: path.relative(workspaceRoot, hit).replace(/\\/g, "/"),
    hash: hash(text),
  };
}

/** 组装本章十段材料。extras.previous 里同名段哈希不同 → 标过期。 */
export async function assembleMaterials(workspaceRoot, bookTitle, chapterKeyStr, extras = {}) {
  const key = chapterKeyStr ?? "ch0001";
  const volume = Number(extras.volume ?? guessVolume(key));

  const segments = [];
  for (const seg of SEGMENTS) {
    segments.push(await readSegment(workspaceRoot, bookTitle, key, volume, seg, extras));
  }

  const previous = new Map((extras.previous ?? []).map((s) => [s.id, s]));
  const stale = [];
  for (const s of segments) {
    const prior = previous.get(s.id);
    if (prior && prior.hash !== s.hash) {
      s.stale = true;
      s.staleReason = `来源已变（上次 ${prior.hash} → 现在 ${s.hash}）`;
      stale.push(s.id);
    }
  }

  return {
    ok: true,
    book: bookTitle,
    chapter: key,
    volume,
    assembledAt: new Date().toISOString(),
    segments,
    missing: segments.filter((s) => !s.ok).map((s) => s.id),
    stale,
    packageHash: hash(segments.map((s) => `${s.id}:${s.hash ?? "-"}`).join("|")),
  };
}

/** 由材料包生成自包含起草任务包：子代理拿到这段文本就能直接写。 */
export function buildDraftTask(materials, { title = "", targetWords = 3000, extraInstructions = "" } = {}) {
  const out = [];
  out.push(`# 起草任务：《${materials.book}》${materials.chapter}`);
  out.push("");
  out.push(`目标篇幅：约 ${targetWords} 字。`);
  out.push("");
  out.push("你是一位独立作者。下面是这一章所需的全部材料，已备齐。");
  out.push("你不需要读任何其他文件、不需要回忆任何此前的对话。");
  out.push("材料里没有提到的东西，不要凭空发明关键设定。");
  out.push("");

  if (title) {
    out.push(`## 本章标题`);
    out.push(title);
    out.push("");
  }

  for (const seg of materials.segments) {
    out.push("---");
    out.push("");
    const flag = !seg.ok ? "（缺）" : seg.stale ? "（来源已变，以当前内容为准）" : "";
    out.push(`## ${seg.name}${flag}`);
    out.push(`*${seg.describe}*`);
    out.push("");
    if (seg.ok) {
      out.push(`> 来源：${seg.source}｜指纹 ${seg.hash}`);
      out.push("");
      out.push(seg.content.trim());
    } else {
      out.push(`*${seg.reason}。若本章必须用到它，先停下来问，不要编。*`);
    }
    out.push("");
  }

  if (extraInstructions) {
    out.push("---");
    out.push("");
    out.push("## 本次的额外要求");
    out.push(extraInstructions);
    out.push("");
  }

  out.push("---");
  out.push("");
  out.push("## 交稿要求");
  out.push("只输出正文本身，不要标题、不要小标题、不要任何交代性的话。");
  out.push("遇到不确定怎么写的地方，写出你能拿到的最好版本，并在正文末尾单独一行用「【存疑】」标出来。");
  return out.join("\n");
}
