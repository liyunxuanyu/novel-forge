/**
 * 客户端入口打包器 —— 不依赖 esbuild。
 *
 * 宿主的客户端插件是 `window.__ModuleLoader__` 的 CJS 工厂，里面没有 ESM 解析器。
 * 我们手上没有 esbuild（宿主和 story profile 都没装），但也不需要：
 * 三个源文件之间只有 import/export 关键字，去掉即可拼进同一个作用域。
 *
 * 用法：
 *   node scripts/bundle-client.mjs           生成
 *   node scripts/bundle-client.mjs --check   校验产物与源码同步（测试用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["lib/ui-model.js", "lib/ui-components.js", "lib/client.js"];
const OUT = "lib/client.bundle.js";

/** 去掉 ESM 关键字，拼进同一个作用域。只处理行首关键字，遇到就报错。 */
function flatten(rel) {
  const raw = readFileSync(path.join(root, rel), "utf8");
  const lines = raw.split(/\r?\n/);
  const out = [];
  let statics = 0;
  let imports = 0;
  for (const line of lines) {
    if (/^export\s+\{/.test(line) || /^export\s+default\b/.test(line) || /^export\s+\*/.test(line)) {
      throw new Error(`${rel}: 不支持这种 export 形态，打包器只认 export 关键字开头：${line.trim()}`);
    }
    if (/^import\b/.test(line)) {
      imports += 1;
      continue; // 同作用域里不需要
    }
    out.push(line.replace(/^export\s+/, ""));
  }
  return { code: out.join("\n"), statics, imports, rel };
}

export function build() {
  const parts = SOURCES.map(flatten);
  const body = parts
    .map((p) => `\n/* ── ${p.rel} ─────────────────────────────────── */\n${p.code}`)
    .join("\n");

  const banner = `/**
 * 自动生成，请勿手改。由 scripts/bundle-client.mjs 从下列源文件拼出：
 *   ${SOURCES.join("\n *   ")}
 * 改行为请改源文件，然后重跑打包器。
 */
window.__ModuleLoader__.load({
\tid: "dsh-novel-forge",
\tfactory: (require) => {
\t\tconst module = { exports: {} };
\t\tconst exports = module.exports;
\t\tconst { createElement } = require("react");

${body}

\t\tconst __entry = createEntry(createElement);
\t\tmodule.exports = { name: "novel-forge-client", apply: __entry.apply, ENTRIES: __entry.ENTRIES };
\t\treturn module.exports;
\t},
});
`;

  return { code: banner, parts };
}

const result = build();
const target = path.join(root, OUT);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    /* 没有就当作不同 */
  }
  if (current !== result.code) {
    console.error(`[bundle-client] ${OUT} 与源码不同步，请重跑：node scripts/bundle-client.mjs`);
    process.exitCode = 1;
  } else {
    console.log(`[bundle-client] ${OUT} 与源码同步（${current.length} 字节）`);
  }
} else {
  writeFileSync(target, result.code, "utf8");
  console.log(`[bundle-client] 已生成 ${OUT}（${result.code.length} 字节，源文件 ${result.parts.length} 个，去掉 ${result.parts.reduce((n, p) => n + p.imports, 0)} 条 import）`);
}
