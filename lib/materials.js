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
import { listStyleEntries, renderStyleBrief } from "./style.js";
import { renderProseSpec } from "./prose.js";

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
    // 这一段不是「读一个文件」，是**合成**的，所以没有 resolve、走 compose：
    //   · 写法库有多条目、按类别分组，得用 style.js 的 renderStyleBrief 渲染。
    //     裸 glob 只会取到按文件名排序的最后一个文件，而且会顶掉另一个来源。
    //   · 两个来源在两个根下：写法库在**书仓**（书仓/<书名>/设定/写法，由 style.js 维护），
    //     作者记忆在**书房**（工作区根，不入库）。
    // 从前整段按 kind:"memory" 吃工作区根，于是「设定/写法」被解析成
    // <工作区>/设定/写法 —— 这个目录从来不存在，而失败毫无声响：
    // 只要作者记忆还在，这一段就报「已备齐」，本书写法一条都进不了起草任务包。
    // 更糟的是它长得像没事——所以这里的 compose 宁可两边都空时报缺，也不假装齐全。
    resolve: () => [],
    compose: async ({ workspaceRoot, bookTitle }) => {
      const parts = [];
      const sources = [];

      const listed = await listStyleEntries(workspaceRoot, bookTitle);
      if (listed.ok && listed.count > 0) {
        parts.push(renderStyleBrief(listed.entries));
        sources.push(`${LAYOUT.books}/${bookTitle}/${LAYOUT.setting}/写法（${listed.count} 条）`);
      }

      const memDir = path.join(workspaceRoot, LAYOUT.studio, "作者记忆");
      const memFiles = (await fs.readdir(memDir).catch(() => []))
        .filter((f) => f.endsWith(".md")).sort();
      for (const f of memFiles) {
        const text = String(await fs.readFile(path.join(memDir, f), "utf8")).trim();
        if (text === "") continue;
        parts.push(`## 作者记忆｜${f.replace(/\.md$/, "")}\n\n${text}`);
        sources.push(`${LAYOUT.studio}/作者记忆/${f}`);
      }

      if (parts.length === 0) return { content: "", reason: "既没有本书写法条目，也没有作者记忆" };
      return { content: parts.join("\n\n---\n\n"), source: sources.join(" + ") };
    } },
  { id: "authorNote", name: "作者本次指令", kind: "supplement", describe: "作者对这一章的额外要求；没有就明说没有",
    resolve: () => [] },
];

async function resolveOne(rootFor, candidates) {
  for (const raw of candidates ?? []) {
    // 候选可以是字符串（用本段的默认根），也可以是 { path, at } —— 后者用来覆盖根。
    const spec = typeof raw === "string" ? { path: raw } : raw;
    const baseRoot = rootFor(spec);
    const candidate = spec.path;
    if (candidate.includes("*")) {
      const dir = path.dirname(path.join(baseRoot, candidate));
      // 通配得按前后缀分别匹配。以前是把 "*" 直接删掉再 includes：
      // 定稿/卷01/0001-*.md 变成 "0001-.md"，而文件名是 "0001-开口.md"，
      // 永远匹配不上——于是「上一章结尾」这一段从来没有取到过，
      // 每一章都当成全书第一章在写。
      const pattern = path.basename(candidate);
      const star = pattern.indexOf("*");
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      let entries;
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      const hit = entries
        .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
        .sort()
        .pop();
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

  // 合成段：内容不是从某个文件里读出来的，而是算出来的。
  if (typeof seg.compose === "function") {
    const got = (await seg.compose({ workspaceRoot, bookTitle, chapter, volume })) ?? {};
    const content = String(got.content ?? "");
    if (content === "") {
      return { ...base, ok: false, content: "", reason: got.reason ?? "真源里还没有这一段" };
    }
    return { ...base, ok: true, content, source: got.source ?? "合成", hash: hash(content) };
  }

  // 段的默认根由 kind 决定：作者记忆类在工作区根（书房，不入库），其余在书仓里。
  // 单个候选可以用 { at: "book" | "memory" } 覆盖。
  const bookBase = bookPaths(workspaceRoot, bookTitle).base;
  const rootFor = (spec) => {
    const at = spec.at ?? (seg.kind === "memory" ? "memory" : "book");
    return at === "memory" ? workspaceRoot : bookBase;
  };

  const hit = await resolveOne(rootFor, seg.resolve({ chapter, volume, workspaceRoot, book: bookTitle }));
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

/**
 * 从作品契约里取题材与目标读者。
 *
 * 真源里这一段是 warehouse.renderContract 写的 `## 题材与目标读者` 加一段正文；
 * 手写契约常用「题材与目标读者：…」一行。两种都认。
 *
 * 为什么要专门写一个提取器：`genre` 是 buildDraftTask 的一个参数，
 * 而**没有一个调用方传过它**——正文里的「本书题材：…」那句从来没出现过。
 * 让每个调用方记得传，就是把「调用方会不会记得」当成了正确性前提；
 * 而题材本来就摆在材料包里，取它不需要任何人配合。
 */
export function genreFromContract(content) {
  const text = String(content ?? "");
  const heading = /^#{1,6}\s*题材与目标读者[^\S\n]*\n+([\s\S]{0,300}?)(?=\n\s*#{1,6}\s|\n*$)/m.exec(text);
  if (heading) {
    const v = heading[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ").trim();
    if (v && v !== "留白") return v;
  }
  const inline = /题材与目标读者\s*[：:]\s*([^\n]+)/.exec(text);
  if (inline) {
    const v = inline[1].trim();
    if (v && v !== "留白") return v;
  }
  return "";
}

/** 由材料包生成自包含起草任务包：子代理拿到这段文本就能直接写。 */
export function buildDraftTask(
  materials,
  { title = "", targetWords = 3000, extraInstructions = "", genre = "", styleBrief = "" } = {},
) {
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

  // 写作纪律 —— 这一段是拿真实语料校准出来的**正向**要求。
  //
  // 为什么必须有它：真机上第 1 章 v8 那稿，禁用词 0、套词 0、弱化副词 0，
  // 一条禁令都没违反，而读起来仍然是机器味。它的病不是「写了不该写的」，
  // 是「该写的没写」——整句均长 17 字（真人 22–24）、逗号长句占 42%（真人 74–80%）、
  // 虚词密度 65/千字（真人 ≥85）、对话占 3%（网文典型 40–60%）。
  // 材料只决定「写什么」，这一段决定「写成什么样」；缺了它，模型会把
  // 细纲里的每一条〔硬〕「不解释、不写内心、只写动作」最大化执行成电报体。
  //
  // 放在材料之后、交稿要求之前：这是动笔前最后读到的一段。
  const styleSeg = materials.segments?.find((s) => s.id === "style" && s.ok && String(s.content ?? "").trim() !== "");
  const brief = String(styleBrief ?? "").trim() !== "" ? styleBrief : (styleSeg?.content ?? "");
  // 题材不靠调用方传：契约段就在材料包里，直接从它取。
  // 调用方传了就用调用方的（比如作者临时指定），没传才回落到契约。
  const contractSeg = materials.segments?.find((s) => s.id === "contract" && s.ok);
  const genreText = String(genre ?? "").trim() !== ""
    ? String(genre).trim()
    : genreFromContract(contractSeg?.content);
  out.push("---");
  out.push("");
  out.push(renderProseSpec({ genre: genreText, styleBrief: brief }));
  out.push("");

  out.push("---");
  out.push("");
  out.push("## 交稿要求");
  // 这两行是互相打架的，A/B 试跑的五个起草子代理里有三个当场指出来了：
  // 头一句说「不要任何交代性的话」，第二句要求「在正文末尾单独一行写说明」。
  // 子代理没法同时照做，只能自己挑一个——三个都挑了「不写说明」，
  // 于是本该交上来的未处置说明就这么丢了：作者该看见的东西没人看见。
  //
  // 修法不是删掉任何一条，是把两者划清界限：正文内部不许混进交代性的话，
  // 而正文**之后**的那一行说明是要的，而且管道会自动把它摘掉。
  out.push("正文从第一字开始，到最后一字为止，中间不要插标题、小标题、交代、说明或统计。");
  out.push("写完正文之后，如果还有拿不准怎么写的地方，单独起一行写出来，前面用「【存疑】」标示，例如「【存疑】第三个声音的身份材料没给，这里留成可回收的接口。」");
  out.push("那一行不算正文，会被自动摘掉；**但你必须写**——它是你唯一能告诉作者「这里我做了选择」的渠道，省掉就等于静默交烂稿。");
  out.push("没有拿不准的地方，就不要凑这一行。");
  return out.join("\n");
}
