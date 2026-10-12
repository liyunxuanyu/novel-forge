/**
 * 细纲的字段校验。
 *
 * ## 出处
 *
 * 字段清单搬自 oh-story `references/workflow-outline.md` 第 29-37 行的细纲模板
 * 「九个必填字段」与第 39-70 行的四个小节。
 *
 * ## 为什么要分硬软两级
 *
 * `workflow-outline.md` 第 21 行记了一个消融实验的结论，逐字是：
 *
 *   「`目标情绪` 与 `主角目标/关键选择` 要写实际内容，不能留 `[待补充]`：
 *   隔离实验里只补这两个字段就能复现补齐全部字段的正文收益，
 *   补满其余字段与只补这两个不可区分。」
 *
 * 这条直接决定了本模块的取舍，而且与仓里既有的两条纪律一致
 * （「阈值只用来选样，不用来判分」「误报代价高于漏报」）：
 *
 * - **硬拦两个**：`目标情绪`、`主角目标/关键选择`。它们是被实验证明有效的那两个，
 *   缺了正文就真的写虚。而且要求它们**不能是占位符**——写了 `[待补充]`
 *   等于没写，占位符比空着更坏，因为它看起来像填过了。
 * - **软提醒其余七个**：有实验证据说它们与「全填」不可区分，
 *   那就不该拿它们挡住流程。报出来给作者看，不拦。
 *
 * 这与参考项目自己的做法一致：它把这两条写成「不能留 `[待补充]`」，
 * 其余写「未知时仍按上文写 `[待补充]`」。
 */

/** 九个必填字段。`hard: true` 的两个是消融实验证明有效的那两个。 */
export const OUTLINE_FIELDS = [
  { key: "核心事件", hard: false, hint: "一句话，供日更与导入统一消费" },
  { key: "字数目标", hard: false, hint: "如 3000 字" },
  { key: "字数口径", hard: false, hint: "visible_chars_v1" },
  { key: "单元ID/位置", hard: false, hint: "卷纲剧情单元 ID；单元内第几拍" },
  {
    key: "目标情绪", hard: true,
    hint: "具体情绪的前状态→后状态，如「戒备→被迫承认自己在听」。不得只写「紧张」「压抑」这种标签",
  },
  {
    key: "主角目标/关键选择", hard: true,
    hint: "主角本章要什么；必须做出的判断或选择",
  },
  { key: "章首钩子", hard: false, hint: "一句话钩住读者的具体内容" },
  { key: "爽点", hard: false, hint: "低压/过场章可写「无显性爽点，功能是…」" },
  { key: "本章禁止提前释放", hard: false, hint: "只写本章特有的三五条，不逐章复读卷级禁忌" },
];

/** 四个小节。缺了不拦，但要报——它们是正文的骨架来源。 */
export const OUTLINE_SECTIONS = [
  "内容概括",
  "情节安排",
  "人物关系和出场顺序",
  "情节细化",
  "结尾设定和钩子",
];

/** 占位符。写了它等于没写，而且比空着更坏——它看起来像填过了。 */
// 注意括号要含 `〔〕`：那是约束分级的标记括号，子代理写占位符时会顺手用它。
// 漏了它，真机上 「- 目标情绪：〔待补充〕」会被当成填过了。
const PLACEHOLDER_RE = /^\s*[[【(（〔]?\s*(待补充|待办|待定|暂无|TODO|TBD|N\/A|无)\s*[\]】)）〕]?\s*$/i;

/**
 * 取某个字段的值。
 *
 * 认三种写法，都是真源里实际会出现的：
 *   - `- 目标情绪：戒备 → 承认`
 *   - `**目标情绪**：戒备 → 承认`
 *   - `### 目标情绪` 换行后是内容
 */
export function outlineFieldValue(body, field) {
  const text = String(body ?? "");
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inline = new RegExp(
    `^[ \\t]*[-*+]?[ \\t]*\\*{0,2}${esc}\\*{0,2}[ \\t]*[：:][ \\t]*(.*)$`, "m",
  ).exec(text);
  if (inline) return inline[1].trim();
  const block = new RegExp(
    `^#{1,6}[ \\t]*\\*{0,2}${esc}\\*{0,2}[ \\t]*\\n+([\\s\\S]{0,400}?)(?=\\n\\s*#{1,6}\\s|\\n\\s*[-*+]\\s*\\S+[：:]|$)`, "m",
  ).exec(text);
  if (block) return block[1].trim();
  return null;
}

/**
 * 校验一份细纲。
 *
 * 返回 `{ ok, hardMissing, softMissing, missingSections }`：
 * - `ok` 只看硬字段——软字段缺了不影响放行，这是消融实验支持的取舍。
 * - `hardMissing` 的元素带 `why`：`"absent"` 没写，`"placeholder"` 写了占位符。
 */
export function checkOutline(body) {
  const hardMissing = [];
  const softMissing = [];

  for (const field of OUTLINE_FIELDS) {
    const value = outlineFieldValue(body, field.key);
    const absent = value === null || value === "";
    const placeholder = !absent && PLACEHOLDER_RE.test(value);
    if (!absent && !placeholder) continue;
    const entry = { key: field.key, hint: field.hint, why: absent ? "absent" : "placeholder", value: value ?? "" };
    if (field.hard) hardMissing.push(entry);
    else softMissing.push(entry);
  }

  const missingSections = OUTLINE_SECTIONS.filter((s) => !String(body ?? "").includes(s));

  return { ok: hardMissing.length === 0, hardMissing, softMissing, missingSections };
}

/** 给作者/子代理看的整改说明。硬字段的措辞要能直接照着补。 */
export function renderOutlineCheck(result) {
  if (!result) return "";
  const lines = [];
  if (result.hardMissing.length > 0) {
    lines.push("细纲缺了必须写实的字段：");
    for (const m of result.hardMissing) {
      lines.push(
        m.why === "placeholder"
          ? `- \`${m.key}\` 只写了占位符「${m.value}」。这一条不许留占位符——${m.hint}`
          : `- \`${m.key}\` 没写。${m.hint}`,
      );
    }
    lines.push("");
    lines.push("为什么只硬卡这两条：这两个字段是拿隔离实验验过的——只补它们两个，");
    lines.push("正文收益与补满全部字段不可区分。其余字段缺了照样能写，这两条缺了写出来就是虚的。");
  }
  if (result.softMissing.length > 0) {
    lines.push("");
    lines.push(`另有 ${result.softMissing.length} 个字段没填（不拦，但建议补）：` +
      result.softMissing.map((m) => m.key).join("、"));
  }
  if (result.missingSections.length > 0) {
    lines.push("");
    lines.push(`缺小节：${result.missingSections.join("、")}`);
  }
  return lines.join("\n");
}