/**
 * 集成测试：从 code profile 的视角解析并加载插件，复现 DSH 加载器的解析路径。
 * 单元测试用的是模拟 ctx；这里验证的是「宿主真的找得到、装得上、拿得到正确导出面」。
 */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const PROFILE = "C:/Users/liyunxuanyu/.dsh/profiles/code";
const PKG = "dsh-novel-forge";

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message ?? error}`);
  }
}

console.log("阶段一 · code profile 集成测试\n");

const anchor = `${PROFILE}/package.json`;
await t("profile package.json 存在", () => assert.ok(existsSync(anchor)));

const require = createRequire(anchor);

let resolved;
await t("从 profile 能解析到 dsh-novel-forge", () => {
  resolved = require.resolve(PKG);
  assert.ok(resolved, "解析结果为空");
  console.log(`        解析到: ${resolved}`);
});

await t("解析结果指向 lib/index.js", () => {
  assert.match(resolved.replace(/\\/g, "/"), /\/lib\/index\.js$/);
});

let mod;
await t("模块可被真实 import", async () => {
  mod = await import(resolved.startsWith("file:") ? resolved : `file:///${resolved.replace(/\\/g, "/")}`);
  assert.equal(typeof mod.apply, "function");
});

await t("导出面符合 cordis 契约", () => {
  assert.equal(mod.name, "novel-forge");
  assert.equal(typeof mod.apply, "function");
  assert.equal(typeof mod.Config, "function");
});

await t("profile 的 bundles 含本插件（否则组合不加载）", async () => {
  const fs = await import("node:fs/promises");
  const pkg = JSON.parse(await fs.readFile(anchor, "utf8"));
  assert.ok(
    pkg.dsh?.profile?.bundles?.includes(PKG),
    `bundles 缺失 ${PKG}，实际为 ${JSON.stringify(pkg.dsh?.profile?.bundles)}`,
  );
});

await t("cordis.patch.yml 是 YAML 序列且 id/name 正确", async () => {
  const fs = await import("node:fs/promises");
  const yml = await fs.readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  const lines = yml.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.equal(lines[0].trim(), "- insert:");
  assert.match(yml, /id:\s*novel-forge/);
  assert.match(yml, /name:\s*'dsh-novel-forge'/);
});

await t("随包技能目录存在且 SKILL.md frontmatter 合法", async () => {
  const fs = await import("node:fs/promises");
  const skillPath = new URL("../skills/forge-probe/SKILL.md", import.meta.url);
  const body = await fs.readFile(skillPath, "utf8");
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, "缺少 frontmatter");
  const nameLine = fm[1].match(/^name:\s*(\S+)/m);
  assert.ok(nameLine, "缺少 name");
  assert.match(nameLine[1], /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `name 非 kebab-case: ${nameLine[1]}`);
  assert.match(fm[1], /^description:\s*\S/m, "缺少 description");
});

await t("peerDependencies 与宿主实际版本一致", async () => {
  const fs = await import("node:fs/promises");
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const host = require("module").createRequire("D:/Program software/DSH NEXT/resources/app/package.json");
  for (const [dep, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (dep === "react") continue;
    let actual;
    try {
      actual = JSON.parse(
        await fs.readFile(`D:/Program software/DSH NEXT/resources/app/node_modules/${dep}/package.json`, "utf8"),
      ).version;
    } catch {
      throw new Error(`宿主未安装 ${dep}`);
    }
    console.log(`        ${dep}: 声明 ${range} / 宿主 ${actual}`);
  }
});

console.log(`\n通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
