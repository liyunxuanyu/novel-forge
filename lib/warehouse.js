/**
 * 书仓协议与 Git 状态机 —— 核心实现。
 *
 * 三条不变量，后面每个阶段都靠它们：
 *   1. 一本书 = 书仓/<书名>/ 一个目录；一切状态从 Git 推导，不从目录扫描猜测。
 *   2. 模型不碰 git 写操作。所有提交经由本模块，由作者确认后调用方触发。
 *   3. 书房（作者层资产）不入 Git；书仓（真源）逐次提交。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);

export const SCHEMA_VERSION = 1;
const GIT_TIMEOUT_MS = 30_000;

// ── 目录与文件布局 ────────────────────────────────────────────────────────

export const LAYOUT = {
  studio: "书房",
  books: "书仓",
  contract: "契约",
  outline: "大纲",
  setting: "设定",
  ledger: "卷账",
  final: "定稿",
  concept: "构想",
  state: ".novel-forge.json",
};

/** 书房是作者层资产：灵感池、构想草案、作者记忆。 */
export const STUDIO_DIRS = ["灵感池", "构想", "作者记忆"];

/** 提交前缀白名单。新增前缀必须先在这里登记，避免出现无法解析的提交。 */
export const COMMIT_KINDS = ["init", "vol", "design", "ch", "retcon", "fix"];

const GITIGNORE = `# 书房是作者层资产，不是书仓真源，不入库。
${LAYOUT.studio}/

# 草稿区与定稿准备区是过程物，随时可重生成。
草稿/
`;

export function bookDir(root, title) {
  return path.join(root, LAYOUT.books, title);
}

export function bookPaths(root, title) {
  const base = bookDir(root, title);
  return {
    base,
    state: path.join(base, LAYOUT.state),
    concept: path.join(base, LAYOUT.concept, "构想快照.md"),
    contract: path.join(base, LAYOUT.contract, "作品契约.md"),
    outline: path.join(base, LAYOUT.outline),
    setting: path.join(base, LAYOUT.setting),
    ledger: path.join(base, LAYOUT.ledger),
    final: path.join(base, LAYOUT.final),
  };
}

// ── git ───────────────────────────────────────────────────────────────────

export async function git(args, cwd) {
  try {
    const { stdout, stderr } = await exec("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.replace(/\r\n/g, "\n"), stderr };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("git 不在 PATH。书仓真源依赖 Git，请安装 Git 或把它加入 PATH。");
    }
    return {
      ok: false,
      stdout: String(error?.stdout ?? "").replace(/\r\n/g, "\n"),
      stderr: String(error?.stderr ?? error?.message ?? error),
      code: error?.code,
    };
  }
}

/** 规范化绝对路径用于比较：统一分隔符、去尾斜杠、忽略大小写。 */
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** dir 所属仓库的根；若 dir 嵌在别人的仓库里，返回的是那个上层仓库。 */
export async function repoRootOf(dir) {
  const r = await git(["rev-parse", "--show-toplevel"], dir);
  const top = String(r.stdout ?? "").trim();
  return r.ok && top !== "" ? normalizePath(top) : null;
}

/**
 * dir 自身就是仓库根才算数。
 *
 * 不能用 `rev-parse --is-inside-work-tree`：它向上遍历，会把任何嵌套在别人仓库里的
 * 目录误判成"已经是仓库"。本机家目录 C:\Users\<user> 本身就是个空 Git 仓库，
 * 于是 %TEMP% 下的工作区会被认成已初始化，提交直接落进那个仓库的历史里。
 */
export async function isRepo(dir) {
  try {
    const top = await repoRootOf(dir);
    return top !== null && top === normalizePath(dir);
  } catch {
    return false;
  }
}

/** 提交一条变更。relPaths 均为相对 workspace 根的路径。 */
export async function commitPaths(root, relPaths, subject) {
  const kind = parseSubject(subject)?.kind;
  if (!kind || !COMMIT_KINDS.includes(kind)) {
    return { ok: false, stage: "validate-subject", detail: `提交前缀必须是 ${COMMIT_KINDS.join(" / ")} 之一，收到 "${subject}"` };
  }
  if (relPaths.length === 0) return { ok: false, stage: "empty-paths", detail: "没有要提交的文件" };

  const add = await git(["add", "--", ...relPaths], root);
  if (!add.ok) return { ok: false, stage: "git-add", detail: add.stderr };

  const staged = await git(["diff", "--cached", "--name-only"], root);
  if (!staged.ok) return { ok: false, stage: "git-diff", detail: staged.stderr };
  if (staged.stdout.trim() === "") {
    return { ok: false, stage: "no-change", detail: "内容没有变化，没有产生提交" };
  }

  const commit = await git(["commit", "-q", "-m", subject], root);
  if (!commit.ok) return { ok: false, stage: "git-commit", detail: commit.stderr };

  const head = await git(["rev-parse", "HEAD"], root);
  return { ok: true, commit: head.stdout.trim(), files: staged.stdout.trim().split("\n") };
}

// ── 提交语义 ──────────────────────────────────────────────────────────────

/** `design(ch0003): 确认章细纲` → { kind:"design", scope:"ch0003", message:"确认章细纲" } */
export function parseSubject(subject) {
  const m = /^([a-z]+)(?:\(([^)]+)\))?:\s*([\s\S]*)$/.exec(String(subject ?? "").trim());
  if (!m) return null;
  return { kind: m[1], scope: m[2] ?? null, message: m[3].trim() };
}

const CHAPTER_SCOPE = /^ch\d{4}$/;

/** 从一次提交改动的文件里认章号：`定稿/卷01/0001-标题.md` → `ch0001` */
export function chapterFromPaths(files) {
  for (const raw of files ?? []) {
    const m = /定稿\/卷\d+\/(\d{4})[-_]/.exec(String(raw).replace(/\\/g, "/"));
    if (m) return `ch${m[1]}`;
  }
  return null;
}

/**
 * 某工件上次改动在第几章。两级推导：
 *   1. 提交 Header 的 design(chNNNN) Scope
 *   2. 该提交改动的 定稿/卷NN/NNNN- 路径
 * 两级都不命中即「无章号」—— 契约、骨架、分卷、卷纲本来就不带章号。
 */
export async function artifactChapter(root, relPath) {
  const log = await git(["log", "-1", "--format=%H%x1f%s", "--", relPath], root);
  // 仓库一个提交都还没有时，git log 会失败，但那不是故障，是"确实没提交过"。
  const noCommitsYet = /does not have any commits yet/i.test(String(log.stderr ?? ""));
  if (!log.ok && !noCommitsYet) return { ok: false, stage: "git-log", detail: log.stderr };
  const line = log.stdout.trim();
  if (line === "") {
    return { ok: true, commit: null, subject: null, kind: null, chapter: null, reason: "该工件从未提交" };
  }
  const sep = line.indexOf("\x1f");
  const hash = line.slice(0, sep);
  const subject = line.slice(sep + 1);
  const parsed = parseSubject(subject);
  if (parsed?.scope && CHAPTER_SCOPE.test(parsed.scope)) {
    return { ok: true, commit: hash, subject, kind: parsed.kind, chapter: parsed.scope, via: "scope" };
  }
  // 显式带上 -c：这一条不能只靠仓库级配置，读别人的仓库时同样要拿到真路径。
  const show = await git(["-c", "core.quotepath=false", "show", "--name-only", "--format=", hash], root);
  const files = show.ok ? show.stdout.trim().split("\n").filter(Boolean) : [];
  const chapter = chapterFromPaths(files);
  return {
    ok: true, commit: hash, subject, kind: parsed?.kind ?? null, chapter,
    via: chapter ? "path" : null,
    reason: chapter ? undefined : "该提交不带章号",
  };
}

// ── 初始化工作区 ──────────────────────────────────────────────────────────

export async function initWorkspace(root) {
  const created = [];
  for (const dir of [path.join(root, LAYOUT.books), ...STUDIO_DIRS.map((d) => path.join(root, LAYOUT.studio, d))]) {
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
      created.push(path.relative(root, dir).replace(/\\/g, "/"));
    }
  }

  const ignorePath = path.join(root, ".gitignore");
  let wroteIgnore = false;
  if (!existsSync(ignorePath)) {
    await fs.writeFile(ignorePath, GITIGNORE, "utf8");
    wroteIgnore = true;
  }

  if (await isRepo(root)) {
    return { ok: true, alreadyRepo: true, created, wroteIgnore, committed: false };
  }

  const parentRepo = await repoRootOf(root);
  if (parentRepo) {
    return {
      ok: false,
      stage: "nested-in-other-repo",
      detail:
        `工作区落在另一个 Git 仓库（${parentRepo}）内部。` +
        "书仓必须是独立仓库，否则这本书的提交会混进别人的历史。换一个工作区目录。",
    };
  }

  const init = await git(["init", "-q"], root);
  if (!init.ok) return { ok: false, stage: "git-init", detail: init.stderr };

  // 非 ASCII 路径默认会被转义成八进制（书仓/… → "书仓/…"）。
  // 关掉之后，状态查询、章号推导、日志才是真路径而不是乱码。
  const quoted = await git(["config", "core.quotepath", "false"], root);
  if (!quoted.ok) return { ok: false, stage: "git-config", detail: quoted.stderr };

  if (!wroteIgnore) return { ok: true, alreadyRepo: false, created, wroteIgnore: false, committed: false };

  const commit = await commitPaths(root, [".gitignore"], "init: 初始化书仓工作区");
  if (!commit.ok) return { ok: false, stage: "commit-init", detail: commit.detail };
  return { ok: true, alreadyRepo: false, created, wroteIgnore: true, committed: true, commit: commit.commit };
}

// ── 建书 ──────────────────────────────────────────────────────────────────

const INVALID_TITLE = /[\\/:*?"<>|]/;
const RESERVED_TITLES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export function validateTitle(title) {
  if (typeof title !== "string" || title.trim() === "") return "书名不能为空";
  const t = title.trim();
  if (t.length > 64) return "书名最长 64 个字符";
  if (INVALID_TITLE.test(t)) return "书名不能包含 \\ / : * ? \" < > | 这些路径分隔符";
  if (RESERVED_TITLES.has(t.toUpperCase())) return `书名「${t}」是系统保留名，换一个`;
  if (t === "." || t === "..") return "书名不能是 . 或 ..";
  return null;
}

const CONCEPT_FIELDS = [
  ["题材与目标读者", "题材与目标读者"],
  ["核心看点", "核心看点"],
  ["差异化方向", "差异化方向"],
  ["主角核心欲望", "主角核心欲望"],
  ["主要冲突", "主要冲突"],
  ["明确不要什么", "明确不要什么"],
  ["核心创意", "核心创意"],
];

function renderConcept(concept, title, bookId) {
  const lines = [`# 构想快照 · 《${title}》`, "", `书 id：${bookId}`, "", "> 本文件在建书时冻结，之后只读。改构想要走提案，不要直接改这里。", ""];
  for (const [key, label] of CONCEPT_FIELDS) {
    lines.push(`## ${label}`, "", String(concept?.[key] ?? "留白").trim() || "留白", "");
  }
  return lines.join("\n");
}

function renderContract(concept, title, bookId, createdAt) {
  const lines = [
    `# 作品契约 · 《${title}》`, "",
    `书 id：${bookId}`, `创建于：${createdAt}`, "",
    "> 契约是本书的创作宪法。修改任何一条都要经作者确认，并走一次 `design:` 提交。", "",
    "## 明确不要什么", "",
    String(concept?.["明确不要什么"] ?? "留白").trim() || "留白", "",
    "## 题材与目标读者", "",
    String(concept?.["题材与目标读者"] ?? "留白").trim() || "留白", "",
    "## 核心看点与差异化", "",
    `**核心看点**：${String(concept?.["核心看点"] ?? "留白").trim() || "留白"}`, "",
    `**差异化方向**：${String(concept?.["差异化方向"] ?? "留白").trim() || "留白"}`, "",
  ];
  return lines.join("\n");
}

export async function createBook(root, { title, concept, currentVolume = 1 }) {
  const titleError = validateTitle(title);
  if (titleError) return { ok: false, stage: "validate-title", detail: titleError };
  const clean = title.trim();

  const paths = bookPaths(root, clean);
  if (existsSync(paths.state)) {
    const existing = await fs.readFile(paths.state, "utf8").then(JSON.parse).catch(() => ({}));
    return {
      ok: false,
      stage: "duplicate",
      detail: `《${clean}》已经存在（书 id ${existing.bookId ?? "未知"}），不要重复建书。继续写它，或换一个书名。`,
      bookId: existing.bookId ?? null,
    };
  }

  if (!(await isRepo(root))) {
    return { ok: false, stage: "no-repo", detail: "工作区还不是 Git 仓库，先调 forge_init_workspace 初始化。" };
  }

  const bookId = `b-${randomBytes(4).toString("hex")}`;
  const createdAt = new Date().toISOString();

  for (const dir of [paths.base, path.dirname(paths.concept), path.dirname(paths.contract), paths.outline, paths.setting, paths.ledger, paths.final]) {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(paths.concept, renderConcept(concept, clean, bookId), "utf8");
  await fs.writeFile(paths.contract, renderContract(concept, clean, bookId, createdAt), "utf8");
  await fs.writeFile(
    paths.state,
    JSON.stringify({ schema: SCHEMA_VERSION, bookId, title: clean, currentVolume, createdAt }, null, 2),
    "utf8",
  );

  const relBase = path.relative(root, paths.base).replace(/\\/g, "/");
  const commit = await commitPaths(root, [relBase], `vol: 建书《${clean}》`);
  if (!commit.ok) return { ok: false, stage: "commit-vol", detail: commit.detail };

  return { ok: true, bookId, title: clean, commit: commit.commit, files: commit.files, path: relBase };
}

// ── 状态查询 ──────────────────────────────────────────────────────────────

async function walkMarkdown(dir) {
  const out = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

export async function listBooks(root) {
  const booksDir = path.join(root, LAYOUT.books);
  let entries;
  try {
    entries = await fs.readdir(booksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(booksDir, entry.name, LAYOUT.state);
    if (!existsSync(statePath)) continue;
    const state = await fs.readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    if (state) books.push({ title: entry.name, ...state });
  }
  return books.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
}

export async function bookStatus(root, title) {
  const clean = String(title ?? "").trim();
  const titleError = validateTitle(clean);
  if (titleError) return { ok: false, stage: "validate-title", detail: titleError };

  const paths = bookPaths(root, clean);
  if (!existsSync(paths.state)) {
    return { ok: false, stage: "no-book", detail: `书仓里没有《${clean}》。用 forge_book_status 不带书名可以列出全部书。` };
  }
  const state = await fs.readFile(paths.state, "utf8").then(JSON.parse).catch(() => ({}));
  const relBase = path.relative(root, paths.base).replace(/\\/g, "/");

  const finalized = (await walkMarkdown(paths.final))
    .map((full) => {
      // 两种命名都认：0007-标题.md 与 ch0007-标题.md。
      // 章号是全书连续的，卷号只是它被归档到哪个卷目录。
      const m = /卷(\d+)[\\/](?:ch)?(\d{4})[-_]/.exec(full.replace(/\\/g, "/"));
      if (!m) return null;
      return { volume: Number(m[1]), chapter: Number(m[2]), chapterId: `ch${m[2]}`, file: path.relative(root, full).replace(/\\/g, "/") };
    })
    .filter(Boolean)
    .sort((a, b) => a.volume - b.volume || a.chapter - b.chapter);

  const last = await git(["log", "-1", "--format=%H%x1f%s%x1f%aI", "--", relBase], root);
  const lastLine = last.stdout.trim();
  let lastCommit = null;
  if (lastLine !== "") {
    const [hash, subject, at] = lastLine.split("\x1f");
    const parsed = parseSubject(subject);
    lastCommit = { hash, subject, at, kind: parsed?.kind ?? null, chapter: parsed?.scope ?? null };
  }

  const log = await git(["log", "--format=%H%x1f%s%x1f%aI", "--", relBase], root);
  const commits = log.ok && log.stdout.trim() !== ""
    ? log.stdout.trim().split("\n").map((line) => {
        const [hash, subject, at] = line.split("\x1f");
        const parsed = parseSubject(subject);
        return { hash, subject, at, kind: parsed?.kind ?? null, chapter: parsed?.scope ?? null };
      })
    : [];

  const volumes = new Set(finalized.map((c) => c.volume));
  return {
    ok: true,
    title: clean,
    bookId: state.bookId ?? null,
    schema: state.schema ?? null,
    currentVolume: state.currentVolume ?? null,
    createdAt: state.createdAt ?? null,
    path: relBase,
    finalizedChapterCount: finalized.length,
    lastChapter: finalized.length > 0 ? finalized[finalized.length - 1].chapterId : null,
    volumesPresent: [...volumes].sort((a, b) => a - b),
    lastCommit,
    commitCount: commits.length,
    recentCommits: commits.slice(0, 8),
  };
}
