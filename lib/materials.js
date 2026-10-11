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
import { renderWriterRole } from "./writer-role.js";

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
    // multi：这一段的通配要收全，不能只挑一个文件。理由见 readSegment 里的注释。
    multi: true,
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

/**
 * 把一个候选路径展开成**全部**匹配的文件（按名字排序）。
 *
 * 与 resolveOne 的区别只在最后一步：resolveOne 取 `.pop()`（最新一个），
 * 这里保留整份列表。「相关人物」要的是后者——五个文件都是这一章的人，
 * 挑一个交上去等于把另外四个人的设定扔了。
 */
async function resolveAll(rootFor, candidates) {
  const out = [];
  for (const raw of candidates ?? []) {
    // 候选可以是字符串（用本段的默认根），也可以是 { path, at }。
    // 这一行必须和 resolveOne 里的一模一样——我第一版漏了它，
    // 于是 spec.path 是 undefined，undefined.includes 直接把 13 个测试文件全打挂了。
    const spec = typeof raw === "string" ? { path: raw } : raw;
    const baseRoot = rootFor(spec);
    const candidate = spec.path;
    if (!candidate.includes("*")) {
      const abs = path.join(baseRoot, candidate);
      if (existsSync(abs)) out.push(abs);
      continue;
    }
    const dir = path.dirname(path.join(baseRoot, candidate));
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
    for (const f of entries.filter((x) => x.startsWith(prefix) && x.endsWith(suffix)).sort()) {
      out.push(path.join(dir, f));
    }
  }
  return out;
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

  // 多文件段：`resolve` 给出通配时，**收全**而不是挑一个。
  //
  // 「相关人物」这一段的语义本来就是多份——一章里有主角、有配角。而这里原来
  // 走的是 resolveOne，它按排序 .pop() 挑一个文件。实测后果：试跑那本书的
  // 设定/人物/ 下有五个文件（主角、身边人、替死者、未来自我、追查者），
  // 而任务包里只装进了「舅妈」——**主角的名字从来没有到过写作者手上**。
  // 起草子代理于是各自发明：一个叫「陈默」，一个干脆全程用「他」，
  // 而任务包自己还写着「材料里没有提到的东西，不要凭空发明关键设定」。
  //
  // 只对显式声明 `multi: true` 的段生效：定稿/卷01/0001-*.md 那种通配要的是
  // 「最新的一章」，不是「全部章节」，一刀切会把整本书塞进任务包。
  if (seg.multi) {
    // 候选可能是字符串也可能是 { path, at }，两边都要能取到 path。
    const cands = seg.resolve({ chapter, volume, workspaceRoot, book: bookTitle }) ?? [];
    const hasGlob = cands.some((c) => String(typeof c === "string" ? c : c?.path ?? "").includes("*"));
    if (hasGlob) {
      const hits = await resolveAll(rootFor, cands);
      if (hits.length === 0) return { ...base, ok: false, content: "", reason: "真源里还没有这一段" };
      const parts = [];
      for (const f of hits) {
        const body = await fs.readFile(f, "utf8");
        parts.push(`<!-- ${path.relative(workspaceRoot, f).replace(/\\/g, "/")} -->\n${body.trim()}`);
      }
      const content = parts.join("\n\n");
      return {
        ...base,
        ok: true,
        content,
        source: hits.map((f) => path.relative(workspaceRoot, f).replace(/\\/g, "/")).join(" + "),
        hash: hash(content),
      };
    }
  }

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
    // 书仓绝对路径。oh-story 的做法是「项目目录：{dir}」单独一行，
    // 各段只给文件名或相对路径，写手用目录拼绝对路径去读。
    // 我们原来每段给的是工作区相对路径，而子代理没有工作区根，拼不出绝对路径——
    // 给了路径却读不到，等于没给。
    bookDir: bookPaths(workspaceRoot, bookTitle).base,
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

/**
 * 起草任务包的材料投递形态。
 *
 * 三个参考项目在这里走了两条路，我都不照单全收：
 *
 * - **oh-story**（`build_writer_prompt.py`）只给**路径**，让写手自己读全文：
 *   「细纲文件（动笔前完整读到 EOF）：{路径}」、「文风路径：…（读全文）」、
 *   「涉及角色：列出本章要读的角色卡」。但它自己留了一个反例，理由写得很清楚：
 *   「必读设定：**直接写出那几句**，不要只给路径让写手去查
 *   （Grep 遇超长行会被截断，最关键那句往往正好被吞）」。
 * - **Scriptor**（`novel-drafting/SKILL.md`）反过来，坚持全内联的自包含任务包：
 *   「子代理隔离运行，看不到主会话、不预装技能」、
 *   「一切事实必须来自真源或材料包切片，严禁把聊天印象当设定塞给子代理」。
 *
 * 我取前者为主、后者那句警语为限。理由是实测出来的，不是偏好：
 *
 * 今天真机上翻的车是「人物段按排序 `.pop()` 挑一个文件」，5 份角色卡只装进 1 份，
 * **主角的名字从来没到过写作者手上**，三个起草样本里两个自述「材料未给主角姓名」。
 * 全内联的每一段都要挑、都要截断、都要去重——每多内联一段就多一个能挑错的点。
 * 只给路径等于把这个会错的操作删掉。但纯路径也不行：关键那句被吞掉时，
 * 子代理不会报错，它会**静默地编**——这正是 oh-story 那个例外要防的。
 *
 * 所以每一段都带「路径」，另按 `inline` 声明**必须内联**的那部分：
 * 篇幅短、且少一句就会出错的（人名、〔硬〕约束、本章意图）。
 * 长材料（细纲全文、写法库、卷纲）只给路径。
 */
const INLINE_MODES = {
  /** 全文内联，同时给路径。角色卡是这一类：短，而且少一个名字就写错。 */
  full: "full",
  /** 只内联关键几行，其余指向路径。细纲、契约是这一类。 */
  keys: "keys",
  /** 只给路径，一个字都不内联。卷纲、写法库是这一类。 */
  path: "path",
};

/**
 * 从长文本里摘「最关键的那几句」。
 *
 * 不是为了省字数，是为了防 oh-story 说的那个「Grep 遇超长行会被截断，
 * 最关键那句往往正好被吞」。所以摘的是**结构行**，不是按长度截断。
 *
 * 第一版只认「分级标记行」和「带冒号的定义行」，结果把契约的
 * 「明确不要什么」整张清单滤掉了——那节写的是 `- 不要系统流、不要后宫`
 * 这种**没有冒号的短横线列表**。测试当场抓到「契约红线缺失」。
 * 教训是：这几类真源的内容行**主要就是短横线**，不认短横线等于不认内容。
 */
function extractKeyLines(text, { max = 80 } = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  const picked = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const heading = /^#{1,6}\s/.test(line);
    // 〔硬〕〔软〕〔自由〕是本书自己的约束分级标记，最要紧，先认。
    const graded = /^[-*+]?\s*〔(硬|软|自由)〕/.test(line);
    // 定义行：「姓名：周砚」「说话方式：短，不解释」这种一行一条的硬事实。
    const defined = /^[-*+]?\s*\*{0,2}[^\s：:]{2,14}\*{0,2}\s*[：:]/.test(line);
    // 短横线列表项。契约红线、人物档案、伏笔台账的内容行大多是这一类。
    const bullet = /^[-*+]\s+\S/.test(line);
    if (heading || graded || defined || bullet) {
      picked.push(line.length > 120 ? `${line.slice(0, 120)}…` : line);
      if (picked.length >= max) {
        picked.push(`（还有更多，此处只摘前 ${max} 行；完整原文见上面的来源路径。）`);
        break;
      }
    }
  }
  return picked;
}

/**
 * 段内容短到这个程度就直接全文内联，不管它声明的是哪种投递方式。
 *
 * ## 为什么要有这条短路
 *
 * `keys` 模式（只摘结构行）我连着两次漏内容：
 * 第一次漏了契约的 `- 不要系统流`（无冒号短横线列表），第二次漏了
 * `## 明确不要什么` 下面的**裸段落**「不要系统流。」——真源里真实存在的两种写法。
 *
 * 每漏一次就往正则里加一条格式，加到最后是「枚举真源可能有的所有写法」，
 * 而那正是它必然失败的地方：下一个没见过的格式照样漏，而漏掉的**静默**——
 * 模型不会报错，它会以为自己已经拿到了红线。
 *
 * 这条短路把判断挪到一个可靠的地方：**长度**。短到 1200 字的内容，
 * 全量内联没有任何代价，也就没有任何漏的风险。`keys` 只在内容真的长时才启用，
 * 而真长的材料（长细纲、写法库）几乎总是有标题或列表，摘行器在那种情况下够用。
 *
 * 阈值 1200 不是我拍的：三段最长的必保材料（细纲、契约、设定）实测都在
 * 400–900 字之间，而卷纲、写法库、前情提要这些真长的都在数千字以上。
 */
const INLINE_FULL_BELOW = 1200;

/**
 * 材料投递分层。
 *
 * `inline` 的判据是**漏一句会不会写错**，不是篇幅：
 * - `full`：短，且少一个名字/一句话就写错。角色卡、上一章结尾、作者本次指令。
 * - `keys`：长，但里面的约束行一条都不能漏。细纲、契约、设定、伏笔。
 * - `path`：真正的长文，读全文才有意义，摘了反而误导。卷纲、前情、写法库。
 *
 * 长度在 INLINE_FULL_BELOW 以下的一律全文内联，见那里的理由。
 *
 * `group` 是 Biz 那套「必保组 / 可丢组」的简化版：超预算时先丢可丢组。
 */
const SEGMENT_PRIORITY = {
  task: { group: "必保", inline: INLINE_MODES.keys },
  contract: { group: "必保", inline: INLINE_MODES.keys },
  characters: { group: "必保", inline: INLINE_MODES.full },
  settings: { group: "必保", inline: INLINE_MODES.keys },
  foreshadow: { group: "必保", inline: INLINE_MODES.keys },
  prevChapter: { group: "必保", inline: INLINE_MODES.full },
  authorNote: { group: "必保", inline: INLINE_MODES.full },
  volumePlan: { group: "可丢", inline: INLINE_MODES.path },
  recap: { group: "可丢", inline: INLINE_MODES.path },
  style: { group: "可丢", inline: INLINE_MODES.path },
};

/** 由材料包生成自包含起草任务包：子代理拿到这段文本就能直接写。 */
export function buildDraftTask(
  materials,
  { title = "", targetWords = 3000, extraInstructions = "", genre = "", styleBrief = "" } = {},
) {
  const out = [];
  const bookDir = materials.bookDir ?? "";
  out.push(`# 起草任务：《${materials.book}》${materials.chapter}`);
  out.push("");
  out.push(`目标篇幅：约 ${targetWords} 字。`);
  out.push("");
  // 这一行改过。原先写的是「下面是全部材料，已备齐，你不需要读任何其他文件」——
  // 而实际上人物段只装进了一份角色卡。子代理照这句话就不会去读盘，
  // 于是「主角叫什么」永远没人知道，而它也不会觉得自己缺东西。
  // 现在如实说明：清单在这里，**能自己去读的就去读**。
  out.push("你是一位独立作者。这一章的材料清单在下面。");
  out.push("每段都给了真源路径——**标注「读全文」的，动笔前完整读到 EOF**；标注「以下为关键行」的，");
  out.push("只摘了最要紧的几句，需要更多时按路径去读原文。");
  out.push("材料里没有提到的东西，不要凭空发明关键设定；缺了什么就照实说，不要编一个补上。");
  if (bookDir) {
    out.push("");
    out.push(`书仓目录：${bookDir}`);
  }
  out.push("");

  if (title) {
    out.push(`## 本章标题`);
    out.push(title);
    out.push("");
  }

  const dropped = [];
  for (const seg of materials.segments) {
    const meta = SEGMENT_PRIORITY[seg.id] ?? { group: "可丢", inline: INLINE_MODES.path };
    out.push("---");
    out.push("");
    const flag = !seg.ok ? "（缺）" : seg.stale ? "（来源已变，以当前内容为准）" : "";
    out.push(`## ${seg.name}${flag}`);
    out.push(`*${seg.describe}*`);
    out.push("");
    if (!seg.ok) {
      out.push(`*${seg.reason}。若本章必须用到它，先停下来问，不要编。*`);
      out.push("");
      continue;
    }
    out.push(`> 来源：${seg.source}｜指纹 ${seg.hash}`);
    out.push("");
    const content = String(seg.content ?? "").trim();
    // 短内容一律全量内联，不管声明的是哪种方式——理由见 INLINE_FULL_BELOW。
    // 这条必须排在 mode 判断**之前**：keys 与 path 的摘法与省略只有在内容
    // 真长时才有意义，短内容走它们只会平白多一个漏内容的机会。
    const shortEnough = content.length <= INLINE_FULL_BELOW;
    if (meta.inline === INLINE_MODES.full || shortEnough) {
      out.push(content);
    } else if (meta.inline === INLINE_MODES.keys) {
      const keys = extractKeyLines(content);
      if (keys.length > 0) {
        out.push("以下为关键行（完整原文见上面的来源路径，动笔前读完）：");
        out.push("");
        for (const k of keys) out.push(k);
      } else {
        out.push("（这一段没有可摘的结构行，动笔前按上面的路径读全文。）");
      }
    } else {
      out.push(`（这一段不内联。动笔前按上面的路径读全文。共 ${content.length} 字。）`);
      dropped.push(seg.id);
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
  // 材料只决定「写什么」，这一段决定「写成什么样」。
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
  // 写手身份 + 写作纪律并成一段。原先只发 renderProseSpec，那是「纪律」不是「身份」——
  // 模型分不清哪条压哪条，于是「不解释设定」和「交代清楚动机」各写各的：
  // 真机上五个起草子代理有三个当场指出交稿要求自相矛盾。
  // 现在第一节就是优先级链：同一维度上谁说了算，明写出来。
  out.push(renderWriterRole({ genre: genreText, styleBrief: brief }));
  out.push("");
  out.push("以上是你的身份与铁律，本章全程适用。下面的材料只决定**写什么**，不改变上面的纪律；");
  out.push("两者冲突时按第一节的优先级走。这一节下面不会再重复一遍。");
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
  out.push("");
  // ── 候选事实段 ──
  //
  // 搬自 Scriptor 的 `skills/novel-drafting/SKILL.md`：「候选事实段（必交）」。
  // 它要的是「正文之后另起一行写标题 `## 草稿候选事实`，其下逐条列出本章写下的
  // 事实……宁缺毋滥：只登记正文里真实写到的；该段供沉淀对账分拣，不进正文」。
  //
  // 我加这一节的直接理由来自第 1 章：三个起草样本各自「发明」了第三个声音的身份、
  // 自作主张解释了录音里在争什么、还各自编了一个主角姓名。这些**都是正文里真实
  // 写到的**，只有把它们显式登记出来，沉淀环节才知道哪些是既定事实、哪些是
  // 起草时的自由发挥——否则下一章读到正文会当成既成设定照抄，越写越实。
  // 「宁缺毋滥」是 Scriptor 的原话，这条纪律要跟着搬。
  out.push("---");
  out.push("");
  out.push("## 交稿要求（接上）");
  out.push("写完那一行【存疑】之后，另起一行写标题 `## 草稿候选事实`，其下逐条列出本章写下的事实，每行一条，以类别前缀开头：");
  out.push("");
  out.push("- 事实：<一句话，主语明确>");
  out.push("- 时间线：<事件名>｜<相对时点>");
  out.push("- 线索埋设：<线索名>｜<埋在哪一幕>");
  out.push("- 线索兑现：<线索名>｜<兑现方式>");
  out.push("- 人物变化：<人物>｜<状态或关系变化>");
  out.push("");
  out.push("**宁缺毋滥**：只登记正文里真实写到的，不要登记你打算写但没写的。");
  out.push("你在这里做的每一个选择（尤其是自己补的身份、自己解释的动机）都要登记——");
  out.push("它们下一章会被当既成设定照抄，不登记就再也分不清哪句是你自己编的。");
  out.push("这一段与上面的【存疑】一样**不属于正文**，会被自动摘掉。");
  return out.join("\n");
}
