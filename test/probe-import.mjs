// 加载探针：不依赖 DSH 宿主，只验证「模块能否被解析 + 导出面是否正确」。
const url = new URL("../lib/index.js", import.meta.url);
try {
  const mod = await import(url.href);
  console.log("IMPORT_OK");
  console.log("exports:", Object.keys(mod).sort().join(", "));
  for (const key of ["name", "apply", "Config"]) {
    console.log(`  ${key}: ${typeof mod[key]}`);
  }
} catch (error) {
  console.log("IMPORT_FAILED");
  console.log("code:", error?.code ?? "(none)");
  console.log("message:", error?.message ?? String(error));
  process.exitCode = 1;
}
