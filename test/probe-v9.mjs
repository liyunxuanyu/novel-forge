import fs from "node:fs/promises";
import { measureProse, proseGaps, renderProseMetrics } from "../lib/prose.js";
const base = "D:/workspace/小说/webnovel-writer/测试/草稿/试跑·灯下无归人/ch0001/稿件/";
const rows = [];
for (const v of ["v1", "v7", "v8", "v9"]) {
  const t = await fs.readFile(base + v + ".md", "utf8");
  const m = measureProse(t);
  rows.push({ v, m });
}
console.log("指标             v1      v7      v8      v9      真人基线");
const g = (k, f) => rows.map(r => (f(r.m) ?? "-").toString().padStart(7)).join("");
console.log("字数        " + g("c", m => m.chars));
console.log("整句均长    " + g("s", m => m.sentenceAvg.toFixed(1)) + "      22-24");
console.log("逗号长句率  " + g("l", m => (m.commaLongRatio*100).toFixed(1)+"%") + "   74-80%");
console.log("虚词密度    " + g("f", m => m.funcDensity.toFixed(1)) + "    >=85");
console.log("对话占比    " + g("d", m => (m.dialogueRatio*100).toFixed(1)+"%") + "   40-60%");
console.log("短段占比    " + g("p", m => (m.shortParaRatio*100).toFixed(1)+"%") + "   <=58%");
console.log("段长CV      " + g("v", m => m.paraCv.toFixed(3)) + "   >=0.12");
console.log("\n── v9 还差哪些（改稿结构活清单）──");
const gaps = proseGaps(rows[3].m);
if (gaps.length === 0) console.log("（一项都不差）");
for (const x of gaps) console.log("  " + x.name, x.actualText, "→", x.targetText, "(" + (x.rel*100).toFixed(0) + "%)", x.far ? "〔换架构〕" : "");
console.log("\n── v8 当时的清单 ──");
for (const x of proseGaps(rows[2].m)) console.log("  " + x.name, x.actualText, "→", x.targetText, "(" + (x.rel*100).toFixed(0) + "%)");
