# 阶段路线图

> 每个阶段先定目标、完成后跑测试、通过了才开下一个阶段。
> "通过标准"是硬门槛：达不到就不进下一阶段。

## 当前状态

| 阶段 | 目标 | 状态 |
|---|---|---|
| 一 | 插件骨架能在 code profile 加载并被验证 | 已完成 · 33 例 |
| 二 | 书仓协议 + Git 状态机 | 已完成 · 44 例 |
| 三 | 章节流水线 | 已完成 · 58 例 |
| 四 | 门禁分级 + 质量债 | 已完成 · 28 例 |
| 五 | 自动导演 | 已完成 · 68 例 |
| 六 | 开书 fan-out | 已完成 · 44 例 |
| 七 | 拆书管道 | 已完成 · 60 例 |
| 八 | 写法引擎 / 扫榜 / 去 AI 味 | 已完成 · 51 例 |
| 九 | 客户端 UI | 已完成 · 45 例 |
| 四 | 门禁分级 + 质量债 | 未开始 |
| 五 | 自动导演 | 未开始 |
| 六 | 开书 fan-out | 未开始 |
| 七 | 拆书管道 | 未开始 |
| 八 | 写法引擎 / 扫榜 / 去 AI 味 | 未开始 |
| 九 | 客户端 UI | 未开始 |
| 十 | 全链实测与打磨 | 未开始 |

---

## 阶段一 · 骨架（已完成）

**目标**：证明一件事——这个插件能在 DSH 里真的被加载、被调用、被验证。其余一切建立在这一步上。

**交付物**

- `package.json` / `cordis.patch.yml`：插件清单与组合注入点
- `lib/index.js`：宿主入口，导出 `{ name, Config, apply }`
- `lib/client.js`：浏览器入口，注入会话视图角标
- `skills/forge-probe/SKILL.md`：随包技能，自检手册
- `scripts/link-dev-deps.ps1`：开发期依赖链接（junction 装法必需）
- `test/apply.test.mjs`（22 例）、`test/integration.test.mjs`（9 例）

**通过标准**（全部达成）

- 模块可 import，导出面符合 cordis 契约
- 随包技能以 `forge-bundled` 挂载且 `includeDefaultRoots=false`，不污染用户技能根
- `forge_status` 注册成功，返回结构自洽，`output.render` 可渲染
- 宿主缺 `tools` / `skills` / `plugin` 能力时降级不崩
- 卸载后工具正确注销
- 从 `code` profile 视角能解析到插件，bundles 已含它，patch 合法
- peerDependencies 与宿主实际版本逐一吻合

**过程中修正的三个真问题**

1. `output.schema` 根节点禁止 `required`（`dsh-tools` 只对 `properties` 内的属性节点放行）
2. `required` 只能为 `true`，不能写 `false` 表示可选——可选就是省略该字段
3. junction 安装下依赖解析失败——`.dsh\profiles\node_modules` 是旧版本集（`dsh-tools@0.1.1-rc.2`、`cordis@4.0.1`），必须指向宿主 app 树（`0.2.0-rc.2` / `4.0.4`）

**怎么跑测试**

```powershell
pwsh -File scripts/test.ps1                    # 全部 31 例
pwsh -File scripts/test.ps1 -Filter integration # 只跑集成
```

**尚未验证的部分**

真机宿主启动时的加载日志（`[novel-forge] 已加载`）需要切到 `code` profile 才能看到——
切换会重启 DSH 并切断当前会话，留给首次实际使用时确认。这只影响"宿主是否真加载"，
不影响"宿主能否解析到插件"（集成测试已覆盖）。

---

## 本机环境坑（改脚本前必读）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `write` / `edit` 工具 | 无弹窗、静默失败。本会话 approval 被禁用，需要授权的写入一律自动拒绝 | 用 `pwsh` 落盘 |
| DSH NEXT.exe 在 .ps1 里 | GUI 子系统程序，脚本内 `& $exe` 静默失败：0 字节、`$LASTEXITCODE` 未赋值 | `Start-Process -RedirectStandardOutput` |
| FileInfo 传给原生程序 | 参数绑定不走 `ToString()`，静默丢参 | 先取 `$_.FullName` 成字符串 |
| junction 安装 | Node 按真实路径解析，`@deepseek-ai/*` 找不到 | `scripts/link-dev-deps.ps1` 建开发期链接 |
| `.dsh\profiles\node_modules` | 是**旧版本集**（`dsh-tools@0.1.1-rc.2`、`cordis@4.0.1`），照它判 peer 会得假阳性 | 一律以 `resources\app\node_modules` 为准 |

**为什么插件只能 link 安装**：代码必须在工作区（作者要求），而 pnpm `link:` 是 junction，
所以依赖解析要靠开发期链接补。发布或换机器时重跑 `link-dev-deps.ps1` 即可。

---

## 阶段二 · 书仓协议与 Git 状态机

**目标**：一本书能被建起来、能被查询、能被 Git 正确记账，且任意时刻都能从 Git 恢复出完整状态。

**为什么要现在做**：它不是"存储层"，是自动导演的地基。`ralph` 的跨轮记忆只有一份 16KB 报告，
撑不住一本长篇；Git 把那个洞补死。所以这个阶段的质量直接决定阶段五能不能做。

### 书仓结构

```
<工作区>/
  书房/                    ← 作者层资产，不入 Git
    灵感池/  构想/  作者记忆/
  书仓/
    <书名>/
      契约/                ← 作品契约（题材定位、核心看点、创作禁区）
      大纲/                ← 故事骨架、分卷布局、卷规划
      设定/                ← 世界书条目（人物、地点、规则）
      卷账/                ← 近期窗口滚动的真源
      定稿/卷NN/NNNN-*.md   ← 已定稿正文
      构想/构想快照.md       ← 建书时冻结，只读
      .novel-forge.json     ← 机器状态：书 id、当前卷、schema 版本
```

`书房` 与 `书仓` 是两类资产，边界不能模糊：**书房不是真源，不入 Git；书仓全是真源，逐次提交。**

### Git 提交语义

沿用 Scriptor 已验证的前缀约定（理由充分，不自创）：

| 前缀 | 含义 | 触发时机 |
|---|---|---|
| `vol:` | 建书 | 建书工具自动完成 |
| `design:` | 设计侧确认 | 骨架、分卷、卷纲、契约、世界书 |
| `design(chNNNN):` | 章细纲确认 | 带章号 Scope |
| `ch:` | 定稿入档 | 每章一次 |
| `retcon:` | 吃书补偿 | 已定稿内容被更正 |
| `fix:` | 作者手改 | 作者直接改字 |

**状态从 Git 推导，不从目录扫描。** 某工件上次改动在第几章，先读提交 Header 的 `design(chNNNN)`
Scope，没有 Scope 再从该提交改动的 `定稿/卷NN/NNNN-` 路径认，两级都不命中即"无章号"。

**铁律：模型不碰 git 写操作。** 每次作者确认后由写入器服务自动提交；模型只能调工具。

### 工具集

| 工具 | 职责 |
|---|---|
| `forge_init_workspace` | 初始化书仓工作区：git init + 目录骨架 |
| `forge_create_book` | 建书：脚手架 + 构想快照冻结 + 书 id 落契约 + 首次 `vol:` 提交 |
| `forge_book_status` | 查状态：一切从 Git 推导 |
| `forge_write_truth` | 写真源文件并自动提交（受门禁约束，阶段四细化） |

### 通过标准

1. 能建一本书，`git log` 读得出完整谱系（首发 `vol:`，其后按动作递增）
2. 任意工件的"上次改动在第几章"可从 `git log --format=%s -- <路径>` 两级推导
3. 重复建书同��书名被拒，不产生第二次 `vol:` 提交
4. 断开重连后 `forge_book_status` 结果与断连前一致
5. 写入路径全部经工具，不存在模型直接改真源的通路

### 不做（留给后面的阶段）

提案 / 影响分析 / 吃书补偿的完整流程（阶段四）；章节细纲与正文流水线（阶段三）。
本阶段只保证"书仓能被正确建立、记账、查询、恢复"。

### 通过标准核对

| 标准 | 覆盖它的测试 |
|---|---|
| 建书后 `git log` 读得出完整谱系 | `书仓协议 · 首次提交前缀是 vol:` / `工具层 · 提交谱系不对` |
| 工件章号两级推导 | `第一级 —— 从 Commit Scope 认章号` / `第二级 —— 从定稿路径兜底认章号` |
| 重复建书被拒且不产生第二次 `vol:` | `重复建同名书被拒`（并断言提交历史逐字未变） |
| 断连重连后状态查询一致 | `断连恢复：新建实例查询同一书仓结果一致` |
| 写入全经工具，不存在绕过通路 | `工具层 · 拒绝 .. 逃逸路径` / `拒绝绝对路径` / `越界写入没有在书仓外留下任何文件` |

### 本阶段抓到的 bug（都是测试逼出来的，不是事后补的说明）

1. **`isRepo` 会向上遍历仓库** —— 原实现用 `rev-parse --is-inside-work-tree`，
   它从当前目录一路往上找仓库。本机 `C:\Users\<user>` 本身就是一个空的 Git 仓库，
   于是 `%TEMP%` 下的任何工作区都被判成"已经初始化"，提交会直接落进那个仓库的历史。
   改成 `rev-parse --show-toplevel` 并要求 **toplevel 就是该目录本身**，
   再加一道 `nested-in-other-repo` 硬拒绝。
2. **Git 把非 ASCII 路径转义成八进制** —— `core.quotepath` 默认 true，
   `git show --name-only` 返回的是 `"定稿/卷01/0007-雨夜.md"` 这种转义串，
   章号正则永远匹配不上，建仓时关掉该配置、读路径时再显式带一次 `-c`。
3. **返回值根本不校验** —— 读 `defineTool` 源码确认：它只 `validate(args)` 校验入参，
   `return userExecute(...)` 直接透传。`output.schema` 只是类型说明。
   因此输出形状必须靠测试守住，`forge_book_status` 就栽在这里（schema 声明 `status` 嵌套，
   实现却返回扁平对象）。
4. **`defineTool` 不能套两层** —— 它返回的对象里 `parameters` 已是编译后的 JSON Schema，
   再包一次会被当成参数 DSL 重新解析，报 `parameters.type must be a value schema object`。

> 教训：把 schema 校验提到加载期之后，这条错误第 3 次才暴露出来。
> 值 DSL 的三条硬规则记在这儿，改 schema 前先看：根节点不能有 `required`；
> `required` 出现时必须为 `true`（可选就是省略）；`object` 必须显式给 `additionalProperties`。

---

## 阶段三 · 章节流水线（进行中）

**目标**：一章能被完整走完——写章细纲 → 确认落真源 → 组装材料包 → 起草 → 审读 → 改稿 → 定稿入档，
每一步都留下能从 Git 复盘的痕迹。中断后能从 Git 恢复到该章的确定状态。

**通过标准（6 条）**

1. 章细纲经确认后以 **一次** `design(chNNNN):` 提交落真源
2. 材料包能从真源十段材料组装，并逐段标注来源；来源已变则标过期而不是静默沿用旧摘录
3. 起草子代理能在**零上下文**下独立完成——任务包自包含，不依赖派发者的会话记忆
4. 审读发现项回写进审核记录，"空审通过"被堵死：没有发现项也要留下证据才允许判过
5. 定稿入档为一次 `ch:` 提交，随后 `forge_book_status` 的已定稿章数 +1 且章号可反查
6. 任一步骤中断，重新查询能从 Git 判定该章停在哪一态，不依赖内存里的临时状态

**不做**：提案 / 影响分析 / 吃书补偿的完整流程（阶段四）；自动导演的轮次编排（阶段五）。
本阶段只保证"单章从细纲到定稿这条路走得通、每步有据可查"。

### 通过标准核对

| 标准 | 覆盖它的测试 |
|---|---|
| 1 细纲一次 `design(chNNNN):` | `确认细纲 → 一次 design(ch0001): 提交` |
| 2 材料包十段、标来源、变则标过期 | `组装十段材料，逐段带来源` / `来源变了就标过期，不静默沿用旧摘录` / `材料包指纹稳定` |
| 3 子代理零上下文可写 | `任务包自包含：子代理零上下文可写` / `任务包如实标出缺的段` / `任务包不泄露宿主路径` |
| 4 空审通过被堵死 | `空审通过被拒绝：既无发现项也无覆盖维度`（并断言被拒后状态原地不动）/ `给了覆盖维度的零发现项可以放行` |
| 5 定稿一次 `ch:`、章数 +1 | `定稿入档 → 一次 ch: 提交，书仓章数 +1` / `整章在 Git 上留下可复盘的谱系` |
| 6 中断可恢复 | `中断后重读状态完整（模拟会话重启）` / `中断后重读状态仍完整` |

### 十段材料

本章任务、上一章结尾、前情提要、相关人物、场景与规则、契约与红线、伏笔与线索、
卷规划与节奏位置、风格基准（取自书房作者记忆）、作者本次指令。
每段带来源路径 + 内容指纹；真源变了就标过期；缺的就明写缺，不假装齐全。

### 本阶段抓到的 bug

1. **先落盘后校验迁移（最严重）** —— `forge_confirm_outline` 和 `forge_settle_chapter`
   都是先写文件、先提交，再调状态机。结果迁移被拒时**书仓里已经有了文件、Git 里已经有了提交，
   状态却停在原地**，真源和状态当场打架。测试抓到的是：还在「待改」时定稿，
   文件已经落进 `定稿/卷01/ch0001-雨夜.md`。修法：迁移不过就不许碰书仓。
2. **作者本次指令凭空丢失** —— `forge_assemble_materials` 收了 `authorNote`，
   但没留档；`forge_draft_task` 重新组装时拿不到，起草任务包里少了作者的要求。
   修法：写进草稿区 `作者本次指令.md`，多次组装追加留痕。
3. **入参校验排在前置条件之后** —— 传空正文却收到「还没有细纲」，报错误导作者。
   修法：入参先于前置条件。
4. **两处命名不一致** —— `bookStatus` 的定稿匹配器认 `0007-标题.md`，
   而 `forge_settle_chapter` 落盘用的是 `ch0007-标题.md`，导致定稿章数永远算成 0。
   修法：匹配器两种都认。

---

## 阶段四 · 门禁分级与质量债（进行中）

**目标**：让自动导演能无人值守地跑，同时把"不能替作者决定的东西"牢牢挡在人工闸门上。
门禁不是一刀切——按**可逆性**分级：错在草稿里代价小，可以自动往下走；
错在定稿里代价大，就必须停下来问人。

**通过标准（6 条）**

1. 每个流程节点有明确的门禁等级，**等级本身可查询**，不靠读代码猜
2. 自动档节点能真正无人值守跑通，不触发任何确认
3. 人工档节点会真的停下，并给出**足够作者做决定**的信息（停在哪、影响什么、可选动作）
4. S3/S4 级问题记为**质量债**进入台账，不阻塞流程，但全书定稿前必须清空或由作者明确豁免
5. 作者可以选择"带着质量债继续"，该选择被记入书仓，不是口头放过
6. 门禁策略可配置：哪些节点 stop、哪些 auto、哪些是"停下并给默认选项"，由一份真源配置决定

**不做**：自动导演的轮次编排、跨轮记忆、fan-out（阶段五）。
本阶段只保证"闸门本身是对的、可查的、可配置的"。

### 通过标准核对

| 标准 | 覆盖它的测试 |
|---|---|
| 1 等级可查、每个节点都有 | `策略可查：默认策略带全部节点` / `每个节点的等级都合法` |
| 2 auto 档真能无人值守 | `auto 节点直接放行，不触发任何确认` |
| 3 人工档真停下且信息够 | `stop 节点停下并给出决策选项` / `决策队列只列需要人拍板的节点` |
| 4 S3/S4 记债不阻塞、S1/S2 阻断 | `S1/S2 当场阻断，不进台账` / `S3/S4 记为质量债并提交，不阻塞流程` / `有未清债时整卷定稿被挡` |
| 5 豁免要写理由并入 Git | `豁免不写理由被拒` / `豁免写入理由并提交` |
| 6 策略可配置 | `书仓里的策略文件覆盖默认值` / `策略里写了非法等级就丢掉该项` / `策略文件坏掉时回退默认` |

### 门禁三级

`auto` 自动往下走 · `stop-with-default` 停下但给默认选项 · `stop` 必须作者拍板。
**未登记的节点一律按 stop** —— 漏配比配错更危险。
策略是书仓里的 `门禁策略.json`，作者可改；解析坏掉回退默认而不是崩。

严重度四级：`s1` 阻断性 / `s2` 结构性当场阻断；`s3` 可优化 / `s4` 风格润色记为质量债继续跑。
豁免必须写理由，理由进 Git —— 口头放过不算数。

---

## 阶段五 · 自动导演（已完成 · 68 例）

**目标**：让"下一步该做什么"变成一个**可测试的纯函数**，再把它喂给宿主的 workflow 引擎。

### 分层

- **决策层**（`lib/director.js`）：从 Git + 章节状态 + 门禁策略，推导下一个节点。
  零模型调用，因此可完全测试。
- **施工单**（同文件）：每个步骤该派什么子代理、给它什么自包含任务文本。
- **执行层**（`lib/dispatch.js`）：调 `ctx.workflowEngine.start({script, meta, args, parent})`。
  任务文本走 `args` 传，不拼进脚本文本。

### 通过标准核对

| 标准 | 覆盖它的测试 |
|---|---|
| 1 从 Git 完全推导下一步 | `同一状态推导两次结论完全一致` / `重载模块后推导结论不变（模拟会话重启）` |
| 2 可 fan-out | `细纲阶段可以 fan-out：后续步骤无依赖，能一起排上` / `审读按维度拆成并行任务` |
| 3 撞 stop 门禁真停下 | `标准 3：撞上 stop 门禁时给出的是「问什么」，不是「做什么」` / `stop 门禁上不许派子代理——必须先问作者` |
| 4 中断后能接着跑 | `重载模块后推导结论不变` / `第 1 章定稿入档，导演推进到第 2 章` |
| 5 每轮留 Git 检查点 | `确认细纲 → 一次 design(ch0001): 提交` / `定稿入档 → 一次 ch: 提交` / `结算卷一：落真源 + vol: 提交` |
| 6 单个子代理失败不毁整轮 | `部分子代理失败，成功的结果照常落地并降级` / `全部失败：明确报错而不是假装成功` / `引擎抛异常：降级返回，绝不往上抛` / `工作流被取消：降级，不抛异常` |

### 本阶段抓到的 bug

1. **规则表顺序错了，两条死规则** —— 卷级规则排在章节规则之后，而 `chapter-outline`
   永远先命中。后果：`volume.settle` 和整卷前的质量债闸门在正常运行中**永远不会触发**，
   等于整套卷级门禁是死代码。同理 `layout-gap` 也被抢先。修法：卷级规则提到章节规则之前。
2. **卷结算是个没有完成记录的动作** —— 导演每轮都会重新提请整卷定稿，永远走不到下一卷。
   修法：加 `卷账/卷NN/结算.md` + `vol:` 提交作完成凭据；已结算的卷不再重复提请。
3. **分卷布局不认中文数字** —— 只匹配 `第 1 卷`，不匹配 `第一卷`。真书写的是后者。
   修法：补一到九十九的中文数字解析。
4. **布局没覆盖到的章会被瞎猜卷号** —— 章号超出布局范围时按每卷 20 章硬推，
   等于导演擅自扩大了规划。修法：返回 `null` 并路由到 `design.volume_layout` 让作者补。
5. **`nextAction` 漏了 `ok` 字段** —— 调用方拿到的成功响应没有成功标记。

### 尚未真机验证的部分

执行层用**假引擎**完整测过（含全部失败路径），但真实子代理派发需要 `code` profile
配好模型中转站才能跑通。那属于阶段十的全链实测。

---

## 阶段六 · 开书 fan-out（进行中）

**目标**：从一份已确认的七要素构想，一次派发出整套设计工件 —— 故事骨架、分卷布局、
世界书（人物/地点/规则）、首卷规划 —— 每一件独立评审、独立落真源、独立提交。

**通过标准（6 条）**

1. 开书能从构想派发出多个**互不依赖**的设计工件，并行跑
2. 每个工件独立成候选、独立提交；一件失败不影响其余落地
3. 设计工件的一致性可检查：骨架里出现的人物/worldbook 里都得有条目，缺了就报出来
4. 落真源前一律是候选，作者能看到再确认（`design:` 提交只在确认时产生）
5. 开书全程每一步都有 Git 提交，复盘时能看清"哪一件是什么时候定的"
6. 已经有骨架的书不会重复生成——重跑是幂等的

### 通过标准核对

| 标准 | 覆盖它的测试 |
|---|---|
| 1 互不依赖的工件并行派 | `依赖分层：骨架 -> (世界书 || 分卷布局) -> 卷规划` / `同一层里的工件互不依赖` / `骨架与布局那一轮能并行派出两件` |
| 2 一件失败不影响其余 | `标准 2：布局失败、世界书成功 —— 成功的那件照常交回` / `全部失败时明确报错，不假装成功` |
| 3 骨架与世界书一致性可查 | `骨架提到世界书没有的实体时报出来` / `同名但类型对不上 → 报类型不符` / `世界书里多出来的条目也报出来` |
| 4 落真源前一律是候选 | `落候选：真源一个字都没动` / `确认时省略正文就取候选` / `没有候选也没给正文时报错，不写空文件` |
| 5 每步都有 Git 提交 | `确认骨架产生一次 design: 提交` / `确认布局后产生 design: 提交` |
| 6 重跑幂等 | `已落真源的工件不会被重复派发（幂等）` / `确认过的不再重复派发` / `全部工件落真源后，plan 报告开书完成` |

### 工件依赖图

```
骨架 ──┬── 分卷布局 ──┐
       │              ├── 首卷规划
       └── 世界书 ────┘
```

骨架靠构想就能开工；分卷布局与世界书互不依赖，同一轮并行；卷规划最后。
开书走**三轮**，最快路径下世界书与分卷布局是并行的。

骨架正文结尾必须带一节 `## 索引`，逐行 `- 类型 / 名称`。
它是实体清单的**唯一来源** —— 没有它，一致性核对无从谈起，直接拒绝而不是瞎猜。

### 本阶段抓到的 bug

1. **空目录被当成已落真源** —— `createBook` 会先建出空的 `设定/` 目录，
   `landedArtifacts` 只判断目录存在，于是世界书一建好书就被判定为"已完成"，
   开书第一步直接跳过它。修法：按条目拆分的工件必须有真实 `.md` 才算落真源。
2. **三处漏返 `ok: true`，成功结果显示成「失败（undefined）」** ——
   `forge_fanout_plan` / `forge_confirm_artifact` / `forge_consistency_check` 返回值里没有 `ok`，
   而 render 是按 `!v.ok` 分支的。症状很隐蔽：操作明明成功了，界面却显示
   "一致性核对失败（undefined）"。这类 bug 只有断言 `r.ok === true` 才抓得到。

---

## 阶段七 · 拆书管道（进行中）

**目标**：从作者自备的参考小说里**渐进**拆出可复用的写作机制，
每条机制带原文证据与适用条件；机制只进书房灵感池，**不进书仓**。

三家在这一块各有所长，融合点在于**拆出三种不同性质的机制**：
Biz 偏**角色向**（这类人物怎么推动情节）· Scriptor 偏**机制向**（这个桥段为什么有效）
· oh-story 偏**结构向**（章节/卷怎么排）。三种都要，且要标明属于哪一类。

**通过标准（6 条）**

1. **渐进**：一次只处理一个有界批次；中断可恢复，不一次性烧掉整本书
2. **可核证**：每条机制都带原文定位（章节 + 行号），能回原文逐字核对
3. **有边界**：每条机制写明适用条件与**不适用**条件，防止照搬到不合适的题材
4. **可版本化**：重拆一次版本 +1，能看出这次改了什么
5. **不进书仓**：机制落在书房（作者层），要采纳进本书必须作者明确决定
6. **进度可查**：作者选的拆解范围与当前进度可查，中断后接着拆

### 通过标准核对

| 标准 | 覆盖它的测试 |
|---|---|
| 1 渐进、中断可恢复 | `批次按每批章数切分，边界是纯函数` / `重新实例化（模拟会话重启）也能算出下一批` / `标准 1：中断后按进度接着拆，不靠记忆` |
| 2 机制带原文定位可核证 | `摘录与原文逐字一致 → 核验通过` / `摘录是编的 → 核验失败，并把原文实际内容摆出来` / `行号越界 → 明确报越界` |
| 3 带适用与**不适用**条件 | `缺「不适用条件」的机制被拒`（且明确说出为什么不能只写适用条件） |
| 4 版本化、旧版留痕 | `重拆必须写理由` / `重拆版本 +1，进度清零，旧版本留痕` |
| 5 不进书仓 | `机制落在书房，不进书仓` / `拆书全程没有逼人建书仓` |
| 6 进度可查 | `进度可查：做完几批、下一批、机制数` / `不带 sourceId 时列出全部参考库` |

### 三种机制类别

融合点不在"谁更强"，而在三家拆的是**不同性质的东西**，三种都要且必须标明属于哪一类：

| 类别 | 来源倾向 | 拆的是什么 |
|---|---|---|
| 角色向 | Biz | 这类人物怎么推动情节 |
| 机制向 | Scriptor | 这个桥段为什么有效 |
| 结构向 | oh-story | 章节与卷怎么排 |

### 两道别人没做的闸门

**证据核验**：机制卡里的 `lineStart/lineEnd/quote` 会被拿回原文逐字比对。
对不上就是编的。摘录编造时，报错会把原文那几行的**实际内容**一起摆出来，
让作者自己判断是模型读错了还是引错了行。一批里有一条不过，**整批不落盘**——
半批落盘会让进度账和实际内容对不上，恢复时再也对不齐。

**处理许可**：拆书要把原文发给模型服务，这一步必须作者先明确允许，
且要说清发往哪个 provider／model／service。同服务同范围续拆沿用；
**范围一改，许可自动作废**。这不是走过场——没有它 `forge_ref_batch` 直接拒绝执行。

来源交代也是硬要求：作品、作者/译者、版本、取得来源、允许用途、依据，六项缺一不可。
声明为「可核对许可」却拿不出可核对的东西会被拒——**选「用户声明」是诚实的**。

### 本阶段抓到的 bug

1. **`setPlan` 把来源交代整个冲掉了**（最严重）—— `计划.json` 被覆写时
   只写了 `{sourceId, ranges, ...}`，`source` 字段（作品名、作者、依据）直接消失。
   症状是后续派给子代理的任务文本里作品名变成库 id，模型根本不知道在拆什么。
   这类静默数据丢失不会报错，只会让产出质量悄悄变差。
2. **`ranges` 参数声明 `{start,end}` 而模块读 `{from,to}`，中间那层映射从来没写** ——
   不报错，只是把每段范围静默变成 `null`，然后一路报 `bad-range`。一个根因拖垮十个测试。
3. **`forge_ref_*` 七个工具的成功返回全部漏 `ok: true`** —— 同类 bug 第三次出现，
   这次直接写了静态检查（见下）。

### 新增：约定检查

`test/convention.test.mjs` 扫描所有 `lib/tools-*.js`，
断言 `execute` 函数体**顶层**的每一个 `return {` 都显式带 `ok`（或展开含 `ok` 的对象）。
只扫 execute 顶层，辅助函数与 map 回调不算；函数体收尾会退出作用域，避免误算。

这条检查当场抓出 31 个返回点里的全部遗漏。三次同类 bug 之后不再靠人记。

---

## 阶段八 · 写法引擎 / 扫榜 / 去 AI 味（进行中）

**目标**：把「怎么写」从一次性提示词变成可复用、可核盘的**写法库**，
并在定稿前扫掉 AI 味。三块：

1. **写法库** —— 从拆书机制与本书已定稿章节里沉淀「这本该怎么写」的条目
   （视角、句长、对话节奏、留白习惯），起草时作为真源注入任务包
2. **扫榜** —— 拿拆书机制对本作题材做适用性判断，
   把机制卡里的**不适用条件真正用上**，指出哪些机制照搬会跑偏
3. **去 AI 味** —— 一组机械可查的判据（排比堆砌、总结句收尾、情绪直述、对称句式、
   万能形容词），产出**可定位到行**的清单，不是笼统评语

**通过标准（6 条）**

1. 写法库是一等真源，起草任务包自动注入，不靠人记得去翻
2. 写法条目可核证：每条带本书已完成章节的出处，能回原文核对
3. 扫榜用上不适用条件：对每条机制给出对本作「能用／别用／要改着用」的判断与理由
4. 去 AI 味产出可定位到章/行的清单
5. 检测是纯函数：同一段文本两次检测结果完全一致
6. **AI 味不擅自改写**：只出清单，改不改由作者或改稿子代理决定，引擎绝不动正文

**不做**：客户端界面（阶段九）。

### 通过标准核对

| 标准 | 覆盖它的测试 |
|---|---|
| 1 写法库是一等真源，自动注入 | `标准 1：写法库确实进了起草材料包的风络段` / `标准 1：写法库渲染成起草任务包里的一段` |
| 2 写法条目可核证 | `出处核不上 → 整批不落盘` / `核验器逐种情形都给清楚理由` |
| 3 扫榜用上不适用条件 | `判定顺序：先看不适用条件，再看适用条件` / `标准 3：撞上「明确不要什么」→ 别用` |
| 4 可定位到行 | `标准 4：每条命中都带行号，能点开定位` / `按行聚合，便于直接跳过去改` |
| 5 检测是纯函数 | `标准 5：同一段文本两次检测结果完全一致` / `检测不改动输入文本` / `检测结果顺序确定` |
| 6 AI 味不擅自改写 | `检测不改动输入文本` / `严重度：这类都是 s4 风格级，不阻断定稿` |

### 三块的分工

- **写法库**（本书层真源，`设定/写法/`）：每条带已定稿章节的出处。
  **没定稿就攒不出写法**——写法是从写出来的东西里长出来的，不是先定规矩再照着写。
  `why` 必填：只有偏好没有理由的写法，换个人接手就废了。
- **扫榜**：把机制卡的「不适用条件」真正用上。判定顺序是刻意的——
  适用条件描述"一般情况"，不适用条件描述"什么时候会翻车"，**翻车比适用更需要先知道**。
  测试专门锁了这条：一个两条条件都撞上的机制，必须判成「别用」。
- **去 AI 味**：五类机械判据，**只报不改**，绝不碰正文一个字。
  覆盖不了 AI 味的全部，检测不出来不等于写得对——这点在工具描述和渲染里都写明了。

### 本阶段抓到的 bug

1. **中文没法按标点切词**——`不要系统流、升级流的作品不要照搬` 切出来是
   `不要系统流`，拿去和本书的「明确不要什么」比永远撞不上，扫榜会一片"可用"。
   改用 3–6 字 n-gram 重叠，取更长的优先（`系统流升级` 比 `不要系统` 更有信息量）。
2. **`bookContext` 把占位词「留白」当成作者填过的内容**——建书时没填的七要素字段
   落盘是「留白」两个字。当成内容用，等于**照着一个作者从没填过的空栏去判别用**，
   而且 `no-concept` 那道闸门永远触发不了。
3. **`Map.set` 只传了一个参数**——写法库收集定稿章节的集合根本没建起来，
   所有出处核验静默失效。
4. **`commitPaths` 的路径是相对工作区根的**，我给了相对书仓的，报 pathspec 不匹配。
5. **排比判据过宽**——长度差放宽到 ≤3 字后，6/8/6 字这种正常句子也被算成排比，太吵，收紧到 ≤1。
6. **标题行只被一个检测器跳过**——其余四类照样把标题里的套话当正文命中，
   改成在入口统一排除。
7. **「段末总结」判据过窄**——"这意味着X"里标志词本来就在句首，按句尾判会整类漏掉。

---

## 阶段九 · 客户端 UI（进行中）

**目标**：把已经能用的能力在界面上显出来，而不是每次都得在会话里读工具输出。

四块：
1. **徽标槽** —— 书名、当前章、当前节点、stop 门禁告警
2. **写作面板** —— 十段材料就绪度、待办动作、门禁决策点
3. **定稿前清单面板** —— AI 味命中（可定位到行）、扫榜判定
4. **拆书进度** —— 批次进度与下一批

**通过标准（6 条）**

1. 每个面板的数据都来自既有工具的同一批真源，不另起一套读取逻辑
2. **UI 层零业务判断**：面板不做书仓/状态机/门禁决定，只呈现工具已经算好的结论
3. **UI 挂掉不影响工具可用**：插件的可用性不依赖任何面板渲染成功
4. 每个 stop 级门禁的决策点在面板上可见、可点
5. 组件有渲染测试覆盖（含工具无数据、坏数据、多书三种边界）
6. 与宿主既有 slot 和主题一致，不新造视觉语言

### 宿主 slot 契约（读自 DSH NEXT 2.0.17-next 实际产物）

`ctx.slots.register(options, component)` 的真规则：

- `options.name` **必须已被父入口的 children 表声明**，否则直接抛错
- 四种 kind：`single`（不可重复占）/ `keyed`（必须给 `key`）/ `list`（必须给 `id`）/ `chain`（必须给 `select`）
- `priority` 最低的先渲染，可用来遮蔽
- 注入的依赖以 `use<Name>` prop 交给组件

**为什么徽标不挂 `conversation.session.header.corner`**：那是 `single` 型，
占过去会跟别的插件撞上并抛错，把别人的顶掉。改挂两个 `list` 型：

| slot | 放什么 | kind |
|---|---|---|
| `conversation.session.header.utilities` | 徽标 | list |
| `conversation.input.dock` | 工作台面板 | list |

### 三层分工

- `ui-model.js`（纯函数，可完整测）—— 所有判断都在既有工具里算完了，这里只搬运与排版
- `ui-components.js`（薄组件）—— 从 props 拿 view 渲染，不读盘、不推状态机、不判门禁
- `client.js` —— 只管注册与卸载

**坏数据不许显示成好消息**：检测失败的面板显示「数据不足」而不是「未命中」。
一个把坏数据显示成好消息的面板比没有面板更坏。

### 本阶段抓到的 bug

1. **`isUsable` 拿结果信封的 `.ok` 去判嵌套载荷** —— `bookStatus.status` 本身不带 `ok`，
   于是徽标永远取不到数据，一直显示「未连接书仓」。
2. **`inject` 返回的是 disposer 不是描述符** —— 我拿 fiber 数当「挂上了几个」在数，
   slot 没声明、什么都没注册时也会报 `2/2`。改成在 factory 里计数。
3. **组件测试没渲染嵌套组件** —— `WorkspacePanel` 里嵌的徽标不在元素树里，
   断言会误以为它没渲染。测试的 `flatten` 现在会真的调用函数组件。

### 本阶段没能验证的（诚实记下）

**活数据没接上。** 视图模型与组件都测透了，注册描述符也对着一个复刻宿主校验规则的
假 slots 服务验过了，但**真实客户端里组件拿不到书仓数据**——
没有跑起 DSH 客户端，就没法确定宿主往 `useXxx` prop 里推的是什么、
以及从工具输出到组件的推送通道长什么样。没接通之前，面板会一直显示「未连接书仓」。

这是阶段十的第一件事。

---

## 阶段十 · 全链实测与打磨（进行中）

**目标**：从建书到整卷写完，跑一条真实的链，中途不救火。

分两层，第二层要模型中转站：

**A16. 真机打通 —— 已完成：抓到第七、第八个洞，都只有真机能发现**

作者重启 harness 之后，`forge_status` 第一次真的执行了。这同时证明了两件事：
A15 的 effect 修复生效（此前 40 个工具刚注册就被注销），
A16 新加的 `inject` 声明也生效。真机随即报出下面两个问题。

### 洞七：插件没声明 `inject`，cordis 不会等 `tools` 就绪

cordis `lib/index.js:1317-1328` 的 `_refresh()`：

```js
for (const name of Object.keys(this.inject)) {
  const impl = this._store[name];
  if (!impl) { epoch = INACTIVE; break; }
}
```

epoch 为 `INACTIVE` 时，`:1336` 的分支不会走 `_reload()`——**`apply` 根本不会被调用**。

三个一方插件全都导出 `inject`：

```js
// dsh-tool-todo
const inject = ["tools", "sessionProjections"];
// dsh-tool-workflow
const inject = ["tools", "workflowEngine", "systemPrompt"];
```

本插件没有。不声明的后果：`apply` 立刻执行，此时 `tools` 若还没注册，
`tryGet(ctx,"tools")` 拿到 null，插件记一条 warn 就 `return`——**而且永远不会重试**。
这是又一个「插件加载了但一个工具都没有」的独立成因，
即使 A15 那个 effect bug 修好了，这一条照样能让工具数为 0。

修法：

```js
export const inject = ["tools"];
```

**只声明 `tools`。** `Inject.resolve`（`:1491-1499`）把 map 里每个名字都当硬依赖，
cordis 没有 `{required, optional}` 这种形态。所以 `workspaceRegistry`
与 `workflowEngine` 只能继续走 `tryGet` 软降级——写进 `inject` 会让缺这些服务的
profile 连插件都起不来，比降级更糟。

### 洞八：动态映射被声明成 `additionalProperties:false`

`forge_status` 的 `services.detail` 是按服务名铺开的映射，却写成了：

```js
detail: { type: "object", additionalProperties: false, required: true },
```

真机直接报（原话）：

```
"value.services.detail.tools" is not a declared property (additionalProperties: false);
"value.services.detail.skills" is not a declared property (additionalProperties: false);
… 共 12 条
```

改成 `additionalProperties: true` 即可。顺带扫了全部工具模块，
「`type:"object"` + `additionalProperties:false` 且不声明 `properties`」只此一处。

### 离线测试为什么漏了它

`forge_status` 内联在 `lib/index.js` 里，不在那 7 个工具模块中，
所以 `output-contract.test.mjs` 的场景清单**一直是 39/40**，漏掉的那个恰好就是它。
真机上它偏偏是第一个暴露问题的工具。

现在补上：用真实的 `apply()` 把 `forge_status` 取出来，跑一次真返回值过校验。
反证——把 `detail` 改回 `additionalProperties:false`，
离线测试立刻报出与真机一字不差的 `is not a declared property`。

### 真机现状（2026-10-09）

- `forge_status`、`forge_book_status` 已在真机上跑通
- 日志最近一次 boot（`2026-10-09T15:51:34.820Z Host ready: code`）无 import 失败，
  宿主插件与客户端插件都正常加载（10-08 那两条 `dsh-novel-forge: import failed`
  是修复前的旧记录，属客户端 web boot，与宿主工具无关）
- `D:\workspace\Agent WorkSpace\.dsh\profiles\code\package.json` 里
  `dsh-novel-forge` 是指向源码目录的 **Junction**，所以重启即生效
- 模型中转站已配好：provider `pix-deepseek` → `deepseek-v4.1-flash`

### 教训

A11–A15 的桩都不忠实，A16 这两条不是桩的问题——**是离线测试覆盖不到的地方**。
真机是唯一能给出「`additionalProperties:false` 撞上动态映射」这种判据的地方，
而且它的报错比任何离线推断都精确。
真机打通之后，每一轮都应该拿真机当 oracle 跑一遍，而不是只在离线套件里自我验证。

---

**A15. ctx.effect 接缝对照 —— 已完成：抓到第六个洞，而且是「插件看着加载了、其实一个工具都没有」的那个**

这个洞解释了本会话一直挂着的一个疑问：**为什么工具表里一个 `forge_*` 都没有，
插件却明显是加载了的**（面板渲染出来了，工作区上下文「目前还没有书」也是插件给的）。

### 真契约

`@deepseek-ai/cordis` 的 `lib/index.js:1169` 定义：

```js
effect(execute, label = "anonymous") { … }
```

`_execute` 里（`:1142-1143`）：

```js
const effect = runner.execute.call(this);
if (typeof effect === "function") return runner.collect(effect);
```

**`execute` 是立刻执行的「建立」，它返回的函数才是「清理」。**

### 我写成了什么

```js
const disposers = registered.map((def) => tools.register(def));
ctx.logger.info(`[novel-forge] 工具已注册 ${disposers.length} 个：…`);

ctx.effect(() => {
  for (const dispose of disposers) {
    if (typeof dispose === "function") dispose();
  }
}, "novel-forge:tools");
```

把**清理**写进了 callback，而且没有返回任何东西。真机上的实际时序是：

1. 40 个工具注册成功
2. 日志打印「工具已注册 40 个」← **就是这句话让人以为一切正常**
3. `ctx.effect(...)` 立刻执行 callback → 40 个反注册器全部被调用 → **40 个工具当场注销**
4. callback 返回 `undefined` → 连卸载钩子都没登记

净效果：**暴露给模型的工具数是 0**，而日志说得像成功了。
这也解释了为什么本会话的工具表里看不到 `forge_*`——
不是宿主没刷新，是真的一个都没剩下。

### 修法

callback 改成「建立」，把清理 `return` 出去：

```js
ctx.effect(() => {
  const disposers = registered.map((def) => tools.register(def));
  ctx.logger.info(`[novel-forge] 工具已注册 ${disposers.length} 个：…`);
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  };
}, "novel-forge:tools");
```

### 为什么测试没抓到：桩比真宿主宽容，而且注释把错误认知写死了

`test/apply.test.mjs` 开头原本写着：

> `ctx.effect(fn)` 只「登记」清理函数，等插件卸载时才由 cordis 调用；
> 桩若立即调用，会把刚注册的插件组件反向注销。

**这句话正好说反了。** 桩按这个认知写成「只登记、不执行」，
于是插件的错误写法在桩上永远表现为「一切正常」。
这不只是漏测——注释把错误认知固化了下来，让后来的人（包括我）继续相信它。

同一个病根在 `preflight.test.mjs` 里也有一份（`effect(fn) { effects.push(fn); }`），
`failure-shape.test.mjs` 里也有一份（`effect() { return () => {}; }`，连 fn 都不跑）。

### 修法：把桩改成忠实的，并加往返验证

三个测试文件里的桩统一改成真语义：

```js
effect(fn, label) {
  const undo = fn();        // 真 cordis：立刻执行
  const record = { fn, label, undo };
  effectFns.push(record);
  return () => { … };
}
```

`preflight.test.mjs` 里顺手把弱断言换成真正的往返验证——
原来的 `assert.ok(effects.length > 0)` 即使 effect 返回 `undefined` 也照样通过：

```js
assert.ok(effects.every((fn) => typeof fn === "function"), …);
for (const fn of effects) await fn();
assert.equal(registered.length, 0, `卸载后应当一个工具都不剩，实际还剩 ${registered.length}`);
```

（为此把桩里 `register` 的反注册器从 `() => {}` 改成真的从数组里摘掉，
否则「卸载」在桩上本来就是空操作，往返验证等于没验。）

### 反证

- 把 `lib/index.js` 退回错误写法 → `apply.test.mjs` 报 3 条失败
  （「注册全部 40 个工具」直接挂）
- 把 `return` 清理函数去掉 → `preflight.test.mjs` 报「宿主入口：导入、注册、卸载全通」失败

两处都能抓住，才算这个桩真的忠实了。

### 教训

A11/A12/A13/A14 是「桩替宿主做了宽容假设」，这一轮是同一个病根的**第五种形态**，
而且是最隐蔽的一种：**桩的宽容被注释合法化了**。
一句「桩若立即调用会反向注销」把错误认知包装成了防御性设计，
于是没有人再去核对 cordis 的真实语义。

**写桩的时候，注释里每一句关于宿主行为的话，都应该能指到宿主源码的某一行。**
指不到的，就是猜测；猜测要当场去验。

---

**A14. 输出契约对照 —— 已完成（49 + 5 例）：抓到第五个洞，也是最大的一个：130 个必填字段会让每条失败路径都抛异常**

这一轮从一句我一直当成「没关系」的假设开始：**返回值不会被校验吧？**

错了。`dsh-tools/lib/index.js:3541-3544`：

```js
createSuccessResult(exec, tool, candidate) {
  const detached = snapshotToolValue(candidate);
  const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
  if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
  …
}
```

而 `:3582-3584` 决定了它什么时候跑：

```js
if (result.isError) { …原样返回… }
const normalized = this.createSuccessResult(exec, tool, result.value);
```

**只要 `isError` 是 false，返回值就过 `output.schema`。** 本插件的工具把
`{ ok: false, stage, detail }` 当**正常返回**（不抛异常），所以失败路径同样过校验。

于是问题来了：`forge_ref_plan` 的 schema 里 `batches` 和 `consentCleared` 是
`required: true`，可失败时这两个字段根本不存在——宿主判定违规，抛
`ToolOutputError`。作者看到的不是「参考库 id 只能用字母数字下划线横线」，
而是一句工具内部错误。

**这不是一个工具的毛病。** 探针扫了一遍：36 个工具、**130 个顶层必填字段**，
条条失败路径都会踩。也就是说，真机上只要有一次输入不合法，
本该是结构化失败的地方全变成异常。

### 修法：顶层只留 ok 必填

失败是一等分支，领域字段在失败时本来就不存在，那就**声明但不强制**。
`defineTool` 之后 `output.schema` 已是编译好的 JSON Schema，所以在
`lib/index.js` 的注册点统一改 `required`，一处覆盖全部工具：

```js
const relaxTopLevelRequired = (def) => {
  const schema = def?.output?.schema;
  if (!schema || schema.type !== "object" || !Array.isArray(schema.required)) return def;
  const kept = schema.required.filter((k) => k === "ok");
  const next = { ...schema };
  if (kept.length > 0) next.required = kept; else delete next.required;
  return { ...def, output: { ...def.output, schema: next } };
};
```

顺带发现 `forge_status` 是唯一的异类：它**连 `ok` 字段都没有**，还有 8 个顶层必填。
已补齐，与其余 39 个统一。

### 广撒网跑真返回值，又抓到四类漂移

`relax` 只解决「失败形状」。把能在离线环境造出合法输入的工具**真跑一遍**、
每次都用宿主自己的 `validateJsonSchemaValue` 校返回值，又抓到：

| 工具 | 代码返回 | schema 声明 | 后果 |
|---|---|---|---|
| `forge_book_status` | `lastChapter: null`、`recentCommits[].chapter: null` | `type: "string"` | 抛异常 |
| `forge_book_status` | `hash`、`schema`、`createdAt` | 未声明 | `additionalProperties: false` 判违规 |
| `forge_director_next` | `step: null`、`defaultOption: null`、`question: null` | `type: "string"` | 抛异常 |
| `forge_gate_status` | `nodes[].question: null`（auto 档没问题要问） | `type: "string"` | 抛异常 |
| `forge_gate_check` | `defaultOption: null`、`stopReason: null` | `type: "string"` | 抛异常 |
| `forge_list_debts` | `entries[].chapter: null`、`bySeverity` | 前者声明 string，后者未声明 | 抛异常 |
| `forge_debt_gate` | `proceed`/`requiresDecision`/`hasDefault`/`defaultOption`/`decisions`/`stopReason` | 未声明（execute 直接透传闸门对象） | 判违规 |
| `forge_record_finding` | `debtId: null`、`commit: null` | `type: "string"` | 抛异常 |
| `forge_outline_draft` | `chars` | 未声明 | 判违规 |
| `forge_draft_task` | `packageHash` | 未声明 | 判违规 |

「会返回 null 的字段被声明成不可空 string」这个坑**一连出现五次**，
所以又写了一遍静态扫描（代码里 `x ?? null` / `x: null` 对照 schema 声明），
把启发式能扫出来的都过了一遍；`forge_record_finding` 就是这么找到的——
它不在我手工挑的场景里。

### 顺带逮到一个「永远不会失败」的测试

给 `test/output-contract.test.mjs` 补收尾时发现：我早前用行切片重写文件时，
把最后两行——`console.log(通过/失败)` 和 `if (failures.length > 0) process.exitCode = 1`——
**切掉了**。于是这个测试即使有 FAIL 也不会让套件变红。

全量断言数对不上就是线索：529 → 578，差的 49 正好是它的条数。
补回收尾后，又用一个故意失败的副本验证了「失败真的会让退出码变 1」。

**一个不会失败的测试比没有测试更糟**——它会让人以为这块验过了。

### 这一轮的教训

A11/A12/A13 的病根是「测试替身替真实调用方式做了宽容假设」。
这一轮是同一个病根的第三种形态：**测试只验了「声明合法」，没验「真实返回值合法」**。
`apply.test.mjs` 一直在加载期校验 schema 能不能过 `defineTool`——
那是**声明**的合法性，跟**返回值**合不合规是两件事。
中间那道缝，130 个字段全掉进去了。

以后每加一个工具，`output-contract.test.mjs` 里补一条真实场景；
`failure-shape.test.mjs` 会自动覆盖它的失败形状。

---

**A13. agent() 空返回对照 —— 已完成（6 例）：抓到第三个洞，而且是静默失血那种**

宿主给模型看的那份权威脚本文档（`dsh-tool-workflow` 的 DESCRIPTION）里明写：

> `agent(prompt, opts?): Promise<any>` — run one subagent to completion.
> Without `opts.schema` it resolves to the child's final text …
> **Resolves `null` when the child fails** (filter with `.filter(Boolean)`).

**子代理跑砸，引擎给的是 `null`，不是 reject。**

而我的并行脚本和 fan-out 脚本都在用 `try/catch` 接 `await agent(...)` 的失败——
**那个 catch 永远接不到**。于是脚本构造出 `{ ok: true, index: i, text: null }`：
失败的子代理被**标成成功**。

后果分两种：

- 全部失败：`done` 被空输出闸门过滤成空 → 整轮报 `empty-run`。还算好。
- **部分失败（最坏）**：三个审读维度挂了一个，`done` 里少了那条，
  `failed` 却是**空的** —— 调用方看到 `degraded: false`，以为一切正常。
  有一个审读维度根本没跑，**而且书里不留任何痕迹**。
- fan-out 更糟：工件带着 `text: null` 被当成「已产出」交回。

**修法**：`agent()` 返回值显式判 `null`/`undefined`，记为失败并写明理由；
`try/catch` 只留给真正的用法错误（传了非法 opts 之类，那才会抛）。

**写这个测试时我自己也踩了一个坑，值得记下来**：假引擎一开始写成
`async start()`，于是 `runRound` 拿到的是 Promise 而不是 run 句柄，
`run.result` 变 undefined。**真引擎的 `start()` 是同步的**
（做完校验就 publish，返回 run，result 是它内部的 promise）。
把假件写成 async，等于又一次让假件替真实调用方式做假设——
和 A11/A12 同一个病根，现在我知道怎么避开它了。
**A12. parent 接缝对照 —— 已完成（5 例）：抓到第二个洞，并牵出 34 条不忠实的旧测试**

接着查 `start()` 里第二行的 `request.parent.session`。那也是硬解引用，
而 `exec.agent` **在宿主里确实可能缺席**——`dsh-tools` 自己的派发代码就写着
`...exec.agent ? { agent: exec.agent } : {}`。计划任务、后台自动跑、非交互调用，
都可能没有活的 agent。导演链恰恰最爱后台自动跑。

**修法**：`checkParent(parent)` 在派发前把这件事挡下来，
给出可读理由（`no-parent`），而不是甩一个 `TypeError: Cannot read properties of undefined`。

**但真正值钱的是后半截。** 这个 guard 一上线，**34 条老测试集体变红**。
原因很扎心：`dispatch` / `chain` / `blank-output` / `missing-input` /
`tools-deconstruct` / `tools-fanout` 这六个文件，**从来没给 runRound 喂过 parent**——
它们测的是一条真机上根本走不到的路径。

也就是说：这些测试一直在测一个**不存在的世界**，而且测得很绿。
和 A11 是同一个病根的另一副面孔——假引擎替真实调用方式做了宽容假设。

**处置**：不削弱 guard（真引擎确实会解引用 `parent.session`），
而是把测试改诚实——新增 `test/helpers/fake-parent.mjs`，
统一用 `fakeExec()` 喂一个带 `session` 的假 agent。

> 这两次合起来是一条方法论：**当你在真实现里读出一个契约，
> 就去问「我的测试假件对这个契约诚实吗」。**
> 诚实与否，是这些测试到底有没有价值的分水岭。
**A11. 真引擎契约对照 —— 已完成（6 例）：抓到一个会让线上全灭的洞**

切到真机之后，作者看到面板是「数据不足」。查面板时顺手往下追了一层，
撞上一个比 UI 大得多的问题：

**派发层的三个脚本与 `engine.start()` 的调用形状，从来没有被真引擎跑过。**

离线测试用的假引擎直接回写死的 `done`，**连 `meta` 都不看**。
于是 `dispatch.js` 里两处 `engine.start({ ..., meta: { name: ... } })`
长期少发一个字段也没人发现。而真引擎（`dsh-workflow-ptc`）的
`start()` 第一件事就是 `validateMeta`：

```js
// dsh-workflow-ptc/lib/index.js:482-483
if (typeof record.name !== "string" || record.name.length === 0) violations.push("meta.name must be a non-empty string");
if (typeof record.description !== "string" || record.description.length === 0) violations.push("meta.description must be a non-empty string");
```

**`meta.description` 必填，我从来没发过。** 缺了就在发布 run 之前同步抛
`META_INVALID`——**线上每一次派发都是全灭，一章都写不出来**，
而 516 项离线断言照样全绿。

这类洞最难缠的地方在于：离线测试能测的只有「我传给引擎的东西」，
**测不到「引擎会怎么处置它」**。假引擎替引擎做了宽容的假设。

**修法**：`runMeta(label)` 同时给 `name` 与 `description`，两个 `start` 调用点都走它。

**防复发**：`workflow-contract.test.mjs` 里照抄了 `validateMetaShape` 的规则，
造一个会挑毛病的假引擎——缺 `description` 照样同步抛 `META_INVALID`。
再加一条：三个脚本脚本体都过一遍 `new vm.Script(...)` 编译
（真引擎 `assertBodyParses` 也是这么干的，语法错同样死在 start 之前）。

> 这也解释了为什么「只跑离线」和「真机跑一遍」是两件事：
> 契约错位只能靠对着真实现读代码发现，或者等第一次真跑。
**A10. 面板数据通路 —— 调查结论：被宿主约束挡住（0 例新增）**
### 复查：现有 host API 也接不上（作者追问后的二次确认）

作者追问「有没有现成的 host API 能用」。逐条查过：

- `ctx.remote` 上共 24 个命名空间（goals / session / settings / credentials / skills /
  workspaceFiles / pluginManager …），**全部是宿主自有域**，各自绑死自己的 controller，
  没有一个能捎带书仓状态。
- 唯一看着像通用通道的 `ctx.remote.$host` 其实只有 `{ home, isLoopback }`——连接信息，不是数据面。
- `dsh-client-connection` 是纯传输层，没有「任意事件广播给客户端」的通用出口；
  事件只能经 typert 命名空间下发。

**结论：数据通路没有第三条路。** 要么宿主补上生成器 / 通用取数面，
要么面板退回「点一下查一次」的按需拉取（牺牲实时性换掉生成器）。


阶段九遗留：两个面板永远显示「数据不足」，因为 `client.js` 的 `inject: () => ({})`
永远返回空 props。切到真机后作者看到的就是这个。

**要接数据，必须走 Typert Remote 链路**，宿主里真实存在的做法（对照
`dsh-client-ui-goal`）：宿主侧建 `TypertRemoteService` 子类，方法打 `@Remote`
装饰器；生成器产出 `typert.host.js`（`./typert` 导出，喂给运行时注册表）与
`typert.remote-client.js`（`./remote` 导出，客户端 `ctx.remote.<ns>.*`）；面板在
`inject(sessionId)` 里 `ctx.remote.$on("域/事件")` 收推送。

**卡点：`@Remote` 是编译期装饰器。** 它只往 `Symbol.metadata` 上挂标记，真正把它
变成运行时命名空间的是 `dsh-typert-generator`。该生成器**不在宿主安装里**
（`dsh-typert-generator` 全盘搜索无果，`.bin` 里也没有 typert 可执行文件），
无法在本机运行；手写的 `typert.host.js` 不带元数据，注册表不会认。

所以「接通数据通路」这条被宿主工具链挡死，不是设计取舍。要走通需要以下之一：
宿主暴露 typert 生成器；或宿主提供一条不经 typert 的运行时取数通道；
或接受面板改为「按需拉取」——即作者点一下才实时查一次书仓（牺牲实时性，换掉生成器）。

阶段九的硬性不变量「坏数据显示『数据不足』，绝不伪装成正常态」在
`inject: () => ({})` 这条路上是**被正确满足**的：它没数据就说没数据。
这块 UI 本身不是坏的，缺的是宿主侧的数据管道。
**A9. 输入侧闸门 + 导演漏阶段 —— 已完成（13 例）**

上一轮堵的是输出侧（子代理交白卷）。**输入侧当时是敞的**，
而它比输出侧危险得多，因为三个洞都不报错：

| 步骤 | 缺什么 | 实际发生的事 |
|---|---|---|
| 审读 | 正文 | 子代理回一句「没问题」→ 空审通过 → 章节出厂 |
| 改稿 | 正文 | 拿不到原文，只能重写一遍 |
| 起草 | 任务包 | 凭空捏一章，没有细纲也没有契约 |

`buildTaskSpec` 之前只在 prompt 里写「（调用方未提供正文）」，然后照发。
现在每个步骤声明 `requires`，**失败优先于构造 prompt**——缺输入直接返回
`missing-input`，连 prompt 都不拼。

细纲是唯一的例外：它只要求卷纲与契约，不要求本章目标。
细纲起草者是「提方案」的人，逼调用方先把本章目标定好，等于替它把活干了。

### 顺带逮到一个更旧的洞：导演规则表漏了「审读中」

写端到端用例时发现导演停在 `chapter.outline_confirm` 而不是审读。
查下来是状态机九个章阶段，导演只覆盖了八个——**`审读中` 一次都没出现在规则表里**。

会话若死在 `forge_dispatch_review` 与 `forge_record_findings` 之间，
章节卡在这个阶段，没有一条章节规则命中，导演会一路落到非章节规则上去
（多半是整卷结算）。**这正好毁掉「中断后按真源接着走」这条保证。**

子代理的结果活不过一次崩溃，所以 `审读中` 并入重派审读，不是浪费。

### 三个测试文件因此失败——但那不是闸门太严

`chain.test.mjs` 里有一行是这么写的：

```js
const fixed = await call("forge_director_run", { title: BOOK, context: { findings: parsed } });
assert.equal(fixed.ok, true);
```

**改稿步骤只传了发现项，没传正文。** 测试管这叫「改稿成功」——
一个从没读过原稿的改稿子代理，在假引擎里回了个字符串，测试就绿了。

夹具本来就在演示我刚发现的那个洞。补齐 context 不是放宽测试，
是让它们诚实。`blank-output.test.mjs`、`tools-director.test.mjs` 同理。
**A8. 源码入版本控制 —— 已完成（1 例守卫）**

上一轮把 `lib/tools-chapter.js` 写成 0 字节之后，第一件事是堵住这个洞本身：
**插件源码此前不在任何版本控制下。** `.gitignore` 从一开始就写好了
（`node_modules/`、`.test-logs/`、`.test-sandbox/`），只是仓库一直没建。

现在：`git init` + 基线提交（62 个文件，无沙盒/日志/依赖混入）。
本地私用，不发布——和三家源码的复用原则一致。

### 建仓库立刻踩出一个真回归：17 个测试文件全挂

书仓协议有一条铁律：**工作区不许嵌在别的仓库里**，否则这本书的提交会混进别人的历史。
测试沙盒原本住在 `novel-forge\.test-sandbox\`，插件自己成了仓库之后，
这条检查把 17 个测试文件的 `initWorkspace` 全部拒掉（`nested-in-other-repo`）。

**那条检查是对的，不该为测试放宽它。** 所以搬的是沙盒，不是规则：
`novel-forge\..\.forge-test-sandbox\`，20 个文件、48 处引用，一次替换。

> 这类回归最阴：改动本身（建仓库）看起来与测试毫无关系，
> 而失败信息是「书仓里没有《雨夜剑客》」——指向完全无关的地方。
> 是靠全量跑一遍才发现的，不是靠推理。

补了一条守卫钉住这件事：**测试沙盒必须住在插件仓库之外**。
**A7. 篇幅闸门 —— 已完成（9 例）**

目标字数以前只是任务包里的一句提示（`目标篇幅：约 3000 字`），
代码里**没有一处下限校验**。真模型交回 300 字的截断稿，没人拦，照样定稿出厂——
整卷字斟句酌的空壳，日志上一片正常。

分寸比前几道更细：**导入只提醒，定稿才拦**。导入拦会把链条卡死等作者，
那本身就是需要人工救火；真正不可逆的是定稿那一刻——空壳进了书仓才收不回来。
`MIN_LENGTH_RATIO = 0.5`，留 `allowShort` 出口：短章、番外是合法体裁，不做陷阱。

### 插曲：`lib/tools-chapter.js` 归零与重建

做这道闸时，一条 `| Out-Null` 把字符串变量变成了数组，
末尾那次 `[System.IO.File]::WriteAllText` 把**整个文件写成了 0 字节**。
插件源码目录不是 Git 仓库（Git 只用于书仓），磁盘上也没有任何副本。

重建的办法是拿测试当规格：`test/tools-chapter.test.mjs` 逐条写死了九个工具的
参数、返回字段、提交前缀和落盘路径。照着它重建，21 条流水线断言一次过。

顺带说一句：**测试是这类代码最好的规格书**。它比任何备份都可靠，因为它一直在跑。

重建过程中还查出一个真 bug——作者指令存进了材料包却没存进章节状态，
于是 `forge_draft_task`（另一次调用）读不到它，任务包里「作者本次指令」段永远是空的。
已在重建版里修掉：组装材料时把 note 一起写进 `state.authorNote`。
**A6. 空白输出当失败 —— 已完成（7 例）**

同一个问题的最后一种形态：**模型交了白卷，而系统当它成功。**

`runRound` 已经拦 `done.length === 0`，可单任务脚本返回的是 `{done:[out]}`，
而 `out` 是空串时长度仍是 1 —— 过滤器只挡 `null` / `undefined`，空串照过。

串起来的后果：审读子代理交白卷 → 这一轮报成功 → 调用方拿**自报的** `covered`
去凑一次「零发现项空审通过」→ 章节定稿 → 整卷出厂 → **日志上一片正常**。
这种失败不报警，比报错危险得多。

现在空串、全空白、`null`、`undefined` 一律判 `empty-run`。并行档同理：
一份空白一份有料时，有料的留下；全空白时整轮判没跑成。
有内容的原文一字不改——只认「有没有」，不替模型改稿。

顺带查过：拆书那条路的 `extractJsonArray` 早就容忍 ```json 围栏和前后废话，
阶段七有专门一条断言守着，**不用再修**。

> 四轮下来，同一个病抓出四处：改稿无上限、派审读工具不存在、细纲不校验分级、空白算成功。
> 共同点是——**全绿的测试不会告诉你规矩没落地，只有真模型会。**
**A5. 细纲约束分级闸门 —— 已完成（8 例）**

接着问同一件事：**还有哪些"只靠提示词自觉"的规矩？**
`〔硬〕〔软〕〔自由〕` 三级约束，全代码里只出现在两处——
给模型的提示词，和 `body` 参数的描述。**没有任何地方校验。**

后果是：真模型漏标 → 细纲照样落真源 → 备料、起草照着一份零约束的骨架走 →
整章写完才发现没东西可对照。**整卷白写。**

现在 `forge_confirm_outline` 在落真源之前读一遍正文，认出行首的分级标记
（列表符号、序号都算行首；正文里顺口说"这是硬要求"不算）。认不到就退回
`outline-unmarked`，并说明为什么必须标。候选可以糙，确认不能糙——
所以只挡确认，不挡草稿；改正文后同章立刻能过，不是死路。

> 和 A4 是同一类病：提示词不是机制。
> 这三轮（改稿上限 / 派审读 / 约束分级）都是把约定从文档挪进代码。
**A4. 改稿轮次上限 —— 已完成（8 例）**

「最多三轮」原本只写在技能手册里当约定，代码里**一处都没有**。
假引擎永远一次就改对，所以这个洞一直藏着；真模型每轮都能挑出新毛病，
无人值守的链条就会变成死循环——**死循环本身就是需要人工救火**。

现在上限做进了导演：`MAX_REVISION_ROUNDS = 3`，到顶后节点变成
`chapter.revise_exhausted`（stop 级），给出作者能答的话：
「这一章已改满三轮仍没审过，继续改还是先定稿？」

这条又牵出**两个真 bug**：

1. **`forge_dispatch_review` 把审读记录写进了 `draft`，等于什么都没存。**
   `advance` 只持久化 `state`，`draft` 仅用于带 `to` / `note` / `commit`。
   阶段上「派过审读」是对的，**记录却一直是空的**。
2. **`recordFindings` 整个替换 `state.review`，把 `revisions` 一起抹掉。**
   于是轮次永远是 1 —— 上限就算写好了也数不到。

两个都是"看着能跑、实际没记"的那类问题，只有真的把上限跑起来才会暴露。
**A3. 加载体检 —— 已完成（8 例）**

真机加载要切 profile、会断会话；那就先把「宿主加载时会走的那几步」变成一条离线断言。
体检只覆盖加载面：包表面 → 客户端注册面 → 客户端入口真跑 → 宿主入口真跑 → 卸载。

查出来的都是「以前没人验过」的硬约束：

- **`files` 里漏列 = 宿主装完就没有。** 逐条 stat，`skills/**/*` 这类 glob 要真展开。
- **`dsh.client.inject` 里的宿主包必须真实存在**，否则组合加载不上。
- **我用的 slot 名必须在注入包的 children 表里声明过。**
  `conversation.session.header.utilities` 与 `conversation.input.dock` 均在
  `dsh-client-ui-conversation` 里声明过 —— 没声明的话是静默不挂，不报错。
- **`exports["./client"]` 必须指向 bundle 而不是裸 ESM 源文件**，
  并且 bundle 要在假 `__ModuleLoader__` + 真 react 下真跑一遍、挂上两个面板。
- **宿主入口**：`apply()` 不抛、40 个工具全注册、卸载钩子已登记。

写体检时自己踩了一个坑：拿 `defineTool` 的**产物**再包一层，九个工具当场报
`parameters.type must be a value schema object` —— 看着像 schema 坏了，其实是
`lib/index.js` 已经包过一次，再包就是错的（源码里那句「别再包第二层」就是写给未来的我的）。
`apply()` 没抛，本身就等于 40 个 schema 全过了加载期校验。

> 所以这条体检的真正用途：**下次切 code profile 之前先跑它**，
> 就不用再拿恢复模式当调试器了。
**A. 离线全链 —— 已完成（21 例）**

用一个按步骤作答的假引擎，整条导演链跑通：建书 → 骨架 → 四件设计工件 fan-out →
逐章（细纲 auto → 备料 auto → 起草 auto → 审读 auto → 改稿 auto → 复审 auto → 定稿 **stop**）
→ 整卷结算 **stop** → 下一卷布局 **stop**。导演实际走过的 21 步节点序列逐步断言。

A-1/A-2/A-3/A-4/A-5 五条通过标准全部达成，其中两条是这条测试特有的：

- **A-2 中断可恢复**：全新一批工具实例（模拟会话重启）只靠磁盘与 Git，
  仍认得已定稿三章，导演直接指向第 4 章。
- **A-5 引擎中途炸过**：第 2 章起草时故意让引擎 reject 一次，链降级不崩，
  引擎恢复后重试接着走，三章照样定稿。

**全链测出来的两个真 bug**（都不靠单测能发现）：

1. **链条是断的。** `dispatch_review`（待审 → 审读中）只存在于状态机，
   **没有任何工具能触发它**，于是 `record_findings` 永远被挡在门外 ——
   一章都走不到定稿。补了 `forge_dispatch_review`（工具 39 → 40）。
2. **九个章节工具在章号非法时直接抛异常。** 工具契约是「永远返回结构化结果」，
   甩异常等于链条跑到一半要人来救火 —— 而这条链条的目标恰恰是无人值守。
   加 `resolveChapter` 统一返回 `{ok:false, stage:"validate-chapter"}`。

> 顺带记一笔：全链第一次跑时我连着猜错了三处 API —— 工具名、参数名、
> 工件 id。假引擎把控制流跑通之后，这些错误才一个一个浮出来。
> 这正是「先跑通控制流、再谈产出质量」的次序。

用一个按剧本作答的假引擎，把整条导演链从头跑到尾：
建书 → 骨架 → 世界书 + 分卷布局 → 卷规划 → 逐章细纲/备料/起草/审读/定稿 → 整卷结算。
验的是**控制流本身**能不能撑住一整本书，而不是单个工具对不对。

**B. 真机实测（需要模型中转站）**

> **2026-10-08 真机已加载过一次，并当场炸出一处真 bug。**
>
> 切到 `code` profile 会被弹进恢复模式，日志实锤：
> ```
> web boot: 1 entry did not activate
> dsh-novel-forge: import failed (see console for the import error)
> ```
> `Host ready: code` 是成功的——挂掉的只有浏览器端那个入口。
>
> **根因**：客户端插件走 `window.__ModuleLoader__`，包体是 CJS 工厂
> （`factory: (require) => {...}`），里面**没有 ESM 解析器**。
> 而我阶段九写的 `lib/client.js` 是裸 ESM（`import ... from "react"`），
> 浏览器直接 import 就解析失败。
>
> 对照组是 Scriptor：它的 `lib/client.js` 是 esbuild 预打包产物，2.3 MB，
> 里面 `require("react")` 出现 26 次——react 走宿主模块表，不打进包。
>
> **修法**（本阶段已落地）：没有 esbuild 也不需要 esbuild。
> 1. `ui-components.js` 改成 `makeComponents(createElement)` 工厂，
>    **对 react 零静态依赖**，测试还更好写（不再依赖 react 已装）。
> 2. `lib/client.js` 保持 ESM 源码（好测），由 `scripts/bundle-client.mjs`
>    拼成 `__ModuleLoader__` 形态的 `lib/client.bundle.js`。
>    三个源文件之间只有 import/export 关键字，去掉即可同作用域。
> 3. `exports["./client"]` 指向 bundle。
>
> **验证方式不是看文本，是真跑**：`test/bundle.test.mjs` 造一个
> `window.__ModuleLoader__`、喂真的 react，执行整个 bundle，
> 断言它确实能 `register` 上面板、缺 slots 时不炸、不会谎报挂了几个。
>
派真子代理跑同样的链，验产出质量。

**通过标准（8 条）**

1. A 层：离线全链能从建书跑到整卷结算，全程不抛异常、不需要人工干预
2. A 层：链中断（引擎中途失败、进程重启）后能从 Git 与状态机接着走，不重跑已完成步骤
3. A 层：每一章的落盘都留下可复盘的提交谱系，章号连续不跳号
4. A 层：整卷结算后导演自动指向下一卷，不用外部提示
5. A 层：过程中出现的 stop 级闸门**全部被正确挡住**，没有一次绕过
6. B 层：真机宿主加载日志出现 `[novel-forge] 已加载`，且 39 个工具全部注册
7. B 层：真跑至少一卷，产出经作者验收
8. 阶段九遗留的活数据接通，界面上能看到真实书仓状态

**不做**：加新功能。这阶段只许修，不许扩。

---

## 累计

534 项断言（一 33 + 二 44 + 三 58 + 四 28 + 五 68 + 六 44 + 七 60 + 八 51 + 九 45 + 十 101 + 约定 2）。40 个工具。
39 个工具。测试入口 `pwsh -File scripts/test.ps1`。

---

## 阶段三 · 章节流水线

细纲 → 备料 → 起草 → 审读 → 改稿 → 定稿，每步一次提交。

**待定**

---

## 阶段四 · 门禁分级与质量债

按可逆性决定哪些决策必须问作者、哪些自动放行。参考 Biz 的 risk_policy 维度，不自创。

**待定**

---

## 阶段五 · 自动导演

`goal` 跨轮持久 + `workflow` 每轮扇出 + Git 提交做检查点。**不用 `ralph`**：它仅前台、无进程恢复、Round 内不能扇出、子代理失败即终止。

**待定**

---

## 阶段六至十

见上方状态表，逐阶段细化。


---

## 订正 · 阶段九「数据通路被宿主工具链挡死」——这条结论是错的

上面第 1003–1016 行当时判断：接通面板数据必须走 Typert Remote 链路，而
`@Remote` 是编译期装饰器、`dsh-typert-generator` 不在宿主安装里，所以「被挡死」。

**有一条纯运行时的路，当时没找到：会话投影。**

证据链（全部读自宿主已安装代码）：

1. `dsh-cordis-client-runner/lib/client.js` 的 slot 契约表里，我注册的两个 slot
   ——`conversation.input.dock`、`conversation.session.header.utilities`——
   的 `standardProps` **都包含** `"useProjection: UseProjection"`。
   也就是说宿主本来就会把这个钩子发给面板组件。
2. 宿主自带的 `todos` 就是这条路的完整范例，全程没有 typert：
   - 服务端 `dsh-tool-todo/lib/index.js:80`
     `ctx.sessionProjections.register({ key: "todos", stateSchema, init, apply, wire })`
   - 写入 `:173` `exec.agent.session.append("todo/write", { todos })`
   - 客户端 `dsh-client-ui-conversation/lib/client.js:17745`
     `function TodoDock({ useProjection }) { … useProjection("todos") … }`
3. `stateSchema` 只需要有 `.parse()` 方法，**不要求是 zod**
   （`dsh-session-projection/lib/index.js:255,297` 只调 `.parse`）。
   而 zod 在本插件的解析路径里拿不到——所以用自写的 `{ parse }` 就够了。

**已落地**：

- 新增 `lib/publish.js`：`PROJECTION_KEY` / `PUBLISH_EVENT` / `publish()` /
  `mergeGates()` / `projectionStateSchema` / `projectionView`。
  铁律：推送失败绝不让工具失败（`publish` 全程 try/catch，只返回真假）。
- `lib/index.js`：动态 `ctx.inject(["sessionProjections"], …)` 注册 `novelForge` 投影；
  并用 `withPublish()` 集中包一层工具，跑完把 `ok:true` 的结果推上去。
  集中包而不是往七个工具各写一遍——漏一个就是一个永远「数据不足」的面板，
  而那种漏法在真机上根本看不出来。
- `lib/ui-components.js`：`useProjectionData(props)` 读 `useProjection("novelForge")`，
  喂给既有的 `buildWorkspaceView()`。拿不到就退回 `props.view`，
  再拿不到就显示「数据不足」——没数据就说没数据。
- `lib/client.bundle.js` 已重新生成。

**只推 `ok:true` 的结果**：失败态推上去，面板会把「查不到」渲染成「就是没有」，
那正是「坏数据显示成好消息」，比不显示更坏。

**待真机验证**：面板是否真的显示书名与待决闸门。这一条只有真机能作数。

---

## 书架：位置与 slot 选型（待做）

真机确认数据通路已通：右上角徽标显示《试跑·灯下无归人 · 还没定稿章节》，
输入框上方面板显示书名 + 十段材料/当前动作/闸门。
（十段材料与当前动作显示「数据不足」是**诚实的**——那两个工具本次会话还没跑过。）

作者对位置的判断：「不要放这里，后面放书架里面」。
`conversation.input.dock` 那一整块压在输入区上方，太吵。**已先摘掉**，只留右上角徽标。

书架该落哪个 slot，读 slot 契约表（`dsh-cordis-client-runner/lib/client.js`）的结果：

| 候选 | 契约 | 能不能读会话投影 |
|---|---|---|
| `sidebar.panellist`（图标）+ `main`（面板体，key 相同） | panellist `replaceRisk: none`，occupants 是插件管理器的 PluginsPanelIcon 与日程的 TaskManagerIcon | **不能**。`main` 的 standardProps 是 useResource / useWorkspaces / usePanelInfo / useSessions / useSessionStatus / useSessionRetainInfo，**没有 useProjection** |
| `sidebar.right.pane.tab` | scope: session，`kind: keyed`，按 tab.kind 的 id 派发 | **能**。standardProps 里有 `useProjection: UseProjection` |

**结论：书架落 `sidebar.right.pane.tab`**（scriptor 也是走这条）。
`sidebar.panellist` + `main` 那条虽然更像「左侧边栏里的一栏」，
但面板体读不到会话投影，得另开一条取数通道，不值当。

组件不用重写：`WorkspacePanel` 已经从 `useProjection("novelForge")` 取数，
换个 slot 挂上去就行。书架要多的是「列出所有书」——
`forge_book_status` 不带 title 时返回的就是全部书，投影里已经有 `books` 字段。
---

## 订正 · 「输出最大上限」：上一轮会话为什么死在一处不动

**症状**：上一轮会话最后 5 轮（turn 73–77）`turn/end` 的 reason 全是 `{kind:"max-tokens"}`，
每轮只产出一个 reasoning 块，**正文零字、工具调用零次**，然后原地重来。整轮会话
`turn/end` 统计：completed 45、aborted 18、error 9、max-tokens 5。

**根因（实测，不是推测）**：把归档会话解压后逐条量了 1162 个 `assistant/message` 事件：

| turn | 推理字符数 | 其中汉字 | 正文 | 工具调用 |
|---|---|---|---|---|
| 75 | 111881 | 55 | 0 | 0 |
| 77 | 109290 | 81 | 0 | 0 |
| 76 | 107095 | 36 | 0 | 0 |
| 74 | 105683 | 92 | 0 | 0 |
| 73 | 102179 | 11 | 0 | 0 |

这 5 条推理**几乎全是非中文**（汉字 11~92 个），按 汉字/1.6 + 非汉字/3.8 估算约
**27K~29.5K token**。而模型默认输出上限是 **32768**。

`@earendil-works/pi-ai/dist/api/openai-completions.js:722-725` 自己写着这条规则：

> Reasoning and the answer share max_tokens here, so an uncapped reasoning phase can
> consume the whole response and leave no answer and no tool call.

**推理和正文共用同一份 `max_tokens`。** 推理吃满 32768，正文就没有位置了。
所以那 5 轮不是「模型不干活」，是**预算被推理一个人用光了**。

**上限是怎么解析出来的**（读代码链，逐段确认）：

1. `dsh-llm-pi-ai/lib/index.js:677` — `maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens`
   （`request.defaultMaxTokens` 是**路由级**的，来自插件 Config schema `:1026`）
2. 解析结果落在 `model.maxTokens`（`:690`）
3. `@earendil-works/pi-ai/dist/api/simple-options.js:17` —
   `options?.maxTokens ?? model.maxTokens`，再 `clampMaxTokensToContext`
4. `openai-completions.js:588-592` — 真正写成 `max_tokens` / `max_completion_tokens`

注意 `modelInfo()`（`:1816-1829`）回给界面描述用的 `defaultMaxTokens` **只认每条模型显式写的
`maxTokens`**（`:679`），路由级 `defaultMaxTokens` 不进去。也就是说：
**路由级 `defaultMaxTokens` 管的是「实际请求发多大」，不是「界面显示多大」。**

**修了两处，缺一不可**：

1. **插件侧（写作链）**：`lib/dispatch.js` 新增 `DEFAULT_SUBAGENT_MAX_TOKENS = 65536`，
   经 `agentOptions.maxTokens` 传给每个子代理。宿主 `SubagentStartRequest` 支持
   `agentOptions.maxTokens`，子代理默认继承父代理的值——父代理没设就落到模型默认。
   三个派发口（导演 `runRound`、开书 `runFanout`、拆书）全部带上，`Config.subagentMaxTokens` 可调。
   只在拿到正整数时才塞 `agentOptions`：`undefined` 会**覆盖**宿主的继承，反而更糟。
2. **宿主侧（主会话）**：`~/.dsh/profiles/code/cordis.patch.yml` 两个 provider 各加
   `defaultMaxTokens: 65536`，`deepseek-v4.1-flash` 另加显式 `maxTokens: 65536`
   （显式写死，免得将来目录里有了这个 id 的元数据把上限盖回默认值）。
   改前备份为 `cordis.patch.yml.bak-<时间戳>`；改后用 YAML 解析器验过，6 个顶层条目齐全。

**为什么是 65536**：实测该中转站接受 `max_tokens` 直到 262144（65536 / 131072 / 262144 都回 200）。
观测到的最坏推理量约 29.5K token，65536 留出约 2.2 倍余量，够推理 + 一整章正文；
再往上只是给「跑飞了」的推理更多烧钱空间，不换来稳定性。**宿主配置改动要重启才生效。**

**还没解决的那一条**：turn 70 的
`413 moderation_input_limit_exceeded: Request input exceeds the content moderation size limit`。
用 node fetch 直接打中转站，输入灌到 **100 万 ASCII 字符**都没复现 413，所以真实阈值仍未定位。
它和上面的 max-tokens 是**两回事**：一个是「输出预算被推理吃光」，一个是「输入太大被审核挡下」。
目前只知道它发生在 `pix-gpt` / `gpt-5.6-sol` 上，且是本轮会话从「还能干活」滑向「原地打转」的起点。