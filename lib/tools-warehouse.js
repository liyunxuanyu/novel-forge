/**
 * 书仓工具集 —— 宿主可见的模型接口。
 *
 * 这里是"模型不碰 git"这条铁律的落地点：所有真源写入都必须经 forge_write_truth，
 * 由它统一校验前缀、统一提交。模型没有任何绕过这条路子的通路。
 *
 * 工具参数一律用 ASCII 键（模型侧更稳），中文概念字段在内部映射。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  LAYOUT, COMMIT_KINDS, bookPaths, validateTitle,
  initWorkspace, createBook, listBooks, bookStatus, commitPaths,
} from "./warehouse.js";

const OK_FAIL = {
  ok: { type: "boolean", required: true },
  stage: { type: "string", description: "失败发生在哪一步；成功时缺省。" },
  detail: { type: "string", description: "失败原因；成功时缺省。" },
};

/** 构想七要素：ASCII 参数键 → 契约里的中文字段名。 */
const CONCEPT_KEYS = [
  ["coreIdea", "核心创意"],
  ["genreAndAudience", "题材与目标读者"],
  ["keyAppeal", "核心看点"],
  ["differentiation", "差异化方向"],
  ["protagonistDesire", "主角核心欲望"],
  ["mainConflict", "主要冲突"],
  ["explicitlyAvoid", "明确不要什么"],
];

function buildConcept(args) {
  const concept = {};
  for (const [ascii, cn] of CONCEPT_KEYS) concept[cn] = args?.[ascii] ?? "留白";
  return concept;
}

const stringList = { type: "array", required: true, items: { type: "string" } };

export function warehouseTools(ctx, resolveRoot) {
  const root = async () => {
    const r = resolveRoot();
    if (!r) throw new Error("当前会话没有有效工作区。请先切到一个工作区目录，或显式给工具传 root 参数。");
    return r;
  };

  // ── forge_init_workspace ────────────────────────────────────────────
  const initWorkspaceTool = {
    name: "forge_init_workspace",
    description:
      "初始化书仓工作区：建 书仓/ 与 书房/ 目录骨架、写 .gitignore（书房不入库）、git init 并做一次 init: 提交。" +
      "在写第一本书之前必须先调一次。已初始化时幂等，不会重复提交。",
    parameters: {
      root: { type: "string", description: "工作区根目录绝对路径。缺省用当前会话工作区。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...OK_FAIL,
          root: { type: "string", required: true },
          alreadyRepo: { type: "boolean", required: true },
          committed: { type: "boolean", required: true },
          created: stringList,
        },
      },
      render: (_a, v) => [
        {
          type: "text",
          text: v.ok
            ? `书仓工作区就绪：${v.root}${v.alreadyRepo ? "（此前已初始化，本次未提交）" : `（新建 ${v.created.length} 个目录，完成 init: 提交）`}`
            : `初始化失败（${v.stage}）：${v.detail}`,
        },
      ],
    },
    async execute(args) {
      const target = args?.root ? args.root : await root();
      const r = await initWorkspace(target);
      return { ...r, root: target };
    },
    presentCall: (a) => ({ card: "generic", title: "初始化书仓工作区", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_create_book ───────────────────────────────────────────────
  const createBookTool = {
    name: "forge_create_book",
    description:
      "建一本书：建目录骨架、把构想七要素冻结成只读快照、写作品契约、生成书 id，并自动完成首次 vol: 提交。" +
      "同一书名重复建会被拒绝。书名不要含路径分隔符与 : * ? \" < > |。",
    parameters: {
      title: { type: "string", required: true, description: "书名。同时作为书仓目录名，不要含路径分隔符与 : * ? \" < > |" },
      coreIdea: { type: "string", required: true, description: "核心创意：一句话说清这本书最独特的那件事" },
      genreAndAudience: { type: "string", required: true, description: "题材与目标读者" },
      keyAppeal: { type: "string", required: true, description: "核心看点：读者为什么读下去" },
      differentiation: { type: "string", required: true, description: "差异化方向：与同类作品的区别" },
      protagonistDesire: { type: "string", required: true, description: "主角核心欲望" },
      mainConflict: { type: "string", required: true, description: "主要冲突：欲望与现实的正面碰撞" },
      explicitlyAvoid: { type: "string", required: true, description: "明确不要什么：创作禁区，写清楚就不容易跑偏" },
      currentVolume: { type: "integer", description: "起始卷号，缺省 1" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...OK_FAIL,
          title: { type: "string" },
          bookId: { type: "string" },
          commit: { type: "string", description: "首次 vol: 提交的哈希" },
          path: { type: "string" },
          files: stringList,
        },
      },
      render: (_a, v) => [
        {
          type: "text",
          text: v.ok
            ? `已建书《${v.title}》\n书 id：${v.bookId}\n书仓：${v.path}\n首次提交：${v.commit}`
            : `建书失败（${v.stage}）：${v.detail}`,
        },
      ],
    },
    async execute(args) {
      const target = await root();
      return createBook(target, {
        title: args?.title,
        concept: buildConcept(args),
        currentVolume: args?.currentVolume ?? 1,
      });
    },
    presentCall: (a) => ({ card: "generic", title: "建书", kind: "other", rawInput: { title: a?.title } }),
  };

  // ── forge_book_status ───────────────────────────────────────────────
  const bookStatusTool = {
    name: "forge_book_status",
    description:
      "查书仓状态，一切从 Git 推导而不是扫描目录：书 id、当前卷、已定稿章数与最后一章、卷分布、最近提交谱系。" +
      "不带书名时列出全部书。写任何一章之前先调它，确认现在该做什么。",
    parameters: {
      title: { type: "string", description: "书名。缺省列出书仓里全部书。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...OK_FAIL,
          books: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", required: true },
                bookId: { type: "string", required: true },
                currentVolume: { type: "integer" },
                createdAt: { type: "string" },
              },
            },
          },
          status: {
            type: "object",
            additionalProperties: false,
            description: "指定了书名时的详细状态",
            properties: {
              title: { type: "string", required: true },
              bookId: { type: "string", required: true },
              path: { type: "string", required: true },
              currentVolume: { type: "integer" },
              finalizedChapterCount: { type: "integer", required: true },
              lastChapter: { type: "string" },
              volumesPresent: stringList,
              commitCount: { type: "integer", required: true },
              recentCommits: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    subject: { type: "string", required: true },
                    kind: { type: "string" },
                    chapter: { type: "string" },
                    at: { type: "string", required: true },
                  },
                },
              },
              lastCommit: {
                type: "object",
                additionalProperties: false,
                properties: {
                  subject: { type: "string", required: true },
                  kind: { type: "string" },
                  chapter: { type: "string" },
                  at: { type: "string", required: true },
                },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: "text", text: `查状态失败（${v.stage}）：${v.detail}` }];
        if (!v.status) {
          if (!v.books || v.books.length === 0) {
            return [{ type: "text", text: `书仓里还没有书。目录：${LAYOUT.books}/` }];
          }
          const lines = v.books.map((b) => `《${b.title}》 ${b.bookId}（当前第 ${b.currentVolume ?? 1} 卷）`);
          return [{ type: "text", text: `书仓共 ${v.books.length} 本：\n${lines.join("\n")}` }];
        }
        const s = v.status;
        const lines = [
          `《${s.title}》 ${s.bookId}`,
          `已定稿 ${s.finalizedChapterCount} 章${s.lastChapter ? `，最新 ${s.lastChapter}` : ""}`,
          `涉及卷：${s.volumesPresent.join("、") || "无"}；共 ${s.commitCount} 次提交`,
        ];
        if (s.lastCommit) lines.push(`最近一次：${s.lastCommit.subject}（${s.lastCommit.at}）`);
        if (s.recentCommits?.length > 1) {
          lines.push("提交谱系（新→旧）：");
          for (const c of s.recentCommits) lines.push(`  ${c.subject}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const target = await root();
      if (!args?.title) {
        const books = await listBooks(target);
        return { ok: true, books };
      }
      const s = await bookStatus(target, args.title);
      if (!s.ok) return s;
      // 成功形状必须是 { ok, status }：与 output.schema 和 render 对齐。
      // defineTool 只校验入参、不校验返回值，所以这个形状要靠测试守。
      const { ok: _ok, ...rest } = s;
      return { ok: true, status: rest };
    },
    presentCall: (a) => ({ card: "generic", title: "查书仓状态", kind: "other", rawInput: a ?? {} }),
  };

  // ── forge_write_truth ───────────────────────────────────────────────
  const writeTruthTool = {
    name: "forge_write_truth",
    description:
      "写书仓真源并自动提交。这是唯一的写入通路——不要用别的文件工具改书仓下的东西，否则状态与提交历史会对不上。" +
      `提交前缀只能用 ${COMMIT_KINDS.join(" / ")}：design 设计侧、design(chNNNN) 章细纲、ch 定稿入档、vol 建书、retcon 吃书补偿、fix 作者手改。` +
      "内容无变化时不产生提交，会如实回报。",
    parameters: {
      title: { type: "string", required: true, description: "书名" },
      subject: {
        type: "string",
        required: true,
        description: `提交信息，前缀必须在 ${COMMIT_KINDS.join("/")} 之内，例如 "design(ch0003): 确认章细纲"`,
      },
      files: {
        type: "array",
        required: true,
        description: "要写入的文件，路径相对书仓/<书名>/。整批作为一次提交。",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true, description: "相对书仓/<书名>/ 的路径，例如 大纲/卷01/0001-细纲.md" },
            content: { type: "string", required: true, description: "文件全文" },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...OK_FAIL,
          commit: { type: "string" },
          files: stringList,
        },
      },
      render: (_a, v) => [
        {
          type: "text",
          text: v.ok
            ? `已提交 ${v.commit.slice(0, 8)}，改动 ${v.files.length} 个文件`
            : `写入失败（${v.stage}）：${v.detail}`,
        },
      ],
    },
    async execute(args) {
      const target = await root();
      const title = String(args?.title ?? "").trim();
      const titleError = validateTitle(title);
      if (titleError) return { ok: false, stage: "validate-title", detail: titleError };

      const base = bookPaths(target, title).base;

      const rels = [];
      for (const file of args?.files ?? []) {
        const rel = String(file?.path ?? "").trim();
        if (rel === "" || path.isAbsolute(rel) || rel.includes("..")) {
          return { ok: false, stage: "validate-path", detail: `路径必须相对书仓且不含 ..，收到 "${file?.path}"` };
        }
        const abs = path.join(base, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, String(file?.content ?? ""), "utf8");
        rels.push(path.relative(target, abs).replace(/\\/g, "/"));
      }
      return commitPaths(target, rels, String(args?.subject ?? ""));
    },
    presentCall: (a) => ({ card: "generic", title: "写书仓真源并提交", kind: "other", rawInput: { title: a?.title, subject: a?.subject } }),
  };

  return [initWorkspaceTool, createBookTool, bookStatusTool, writeTruthTool];
}

export { CONCEPT_KEYS };
