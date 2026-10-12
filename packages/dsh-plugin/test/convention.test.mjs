/**
 * 约定检查：工具 execute 顶层的每一个返回，都必须显式带 ok。
 *
 * 这条被漏过三次——forge_book_status、fanout 三个工具、deconstruct 七个工具。
 * 症状都是同一个：操作成功了，render 却因为 `!v.ok` 走了错误分支，
 * 界面显示「失败（undefined）」。靠人记不住，所以写成检查。
 *
 * 只扫 execute 函数体的顶层返回：辅助函数与 map 回调的返回不算。
 */
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libDir = path.join(projectRoot, "lib");
const files = (await fs.readdir(libDir)).filter((f) => /^tools.*\.js$/.test(f)).sort();

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message ?? error}`);
  }
}

console.log(`约定检查 · 工具 execute 的返回必须自带 ok\n扫描 ${files.length} 个文件\n`);

const offenders = [];
let scanned = 0;
for (const file of files) {
  const text = await fs.readFile(path.join(libDir, file), "utf8");
  const lines = text.split(/\r?\n/);
  let depth = 0;
  let execDepth = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const before = depth;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;

    if (execDepth === null && /\bexecute\s*\(/.test(line) && line.includes("{")) {
      execDepth = before + 1;
      continue;
    }
    // 函数体收尾就退出 execute 作用域，否则后面声明的辅助函数会被误算进来
    if (execDepth !== null && depth < execDepth) execDepth = null;
    if (execDepth === null || before !== execDepth) continue;

    if (!/^\s*return\s*\{/.test(line)) continue;
    let obj = line;
    let j = i;
    let d = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    while (d > 0 && j < lines.length - 1) {
      j += 1;
      obj += `\n${lines[j]}`;
      d += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
    }
    scanned += 1;
    const body = obj.slice(obj.indexOf("{"));
    if (/\bok\s*:/.test(body) || /\.\.\.[A-Za-z_$]/.test(body)) continue;
    offenders.push({ file, line: i + 1, snippet: obj.trim().replace(/\s+/g, " ").slice(0, 100) });
  }
}

check("execute 顶层的每个返回都显式带 ok", () => {
  assert.deepEqual(offenders, [], `\n${offenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`).join("\n")}`);
});
check("确实扫到了足够多的返回点（防止检查本身空转）", () => {
  assert.ok(scanned >= 30, `只扫到 ${scanned} 个返回点，检查可能没生效`);
});

console.log(`\n返回点扫描数：${scanned}，违规：${offenders.length}`);
console.log(`通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;
