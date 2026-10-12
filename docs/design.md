# Novel Forge DSH 完整设计文档

版本：0.1  
状态：设计基线  
范围：DeepSeek Harness 小说插件  
当前不包含：对 `novel-forge-studio` 的修改、短剧生产、游戏生产、视频生产

## 0. 参考项目地址与版本

本设计基于以下三个公开仓库的产品文档、技能、源码、测试和架构资料形成：

| 项目 | GitHub | 参考位置 | 本次参考版本 | 许可证 |
|---|---|---|---|---|
| Scriptor | <https://github.com/lingfengQAQ/webnovel-writer> | `packages/bundle`，分支 `v8` | `8.2.2` | GPL-3.0-only |
| oh-story | <https://github.com/zenstory-ai/oh-story-dsh> | `packages/dsh-plugin` | `0.1.15`，`main` | MIT |
| Biz Novel Studio | <https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant> | 仓库根目录 | `origin/main`，提交 `5cd6a132` | 仓库自有双许可模型 |

配套的角色技能仓库：<https://github.com/ExplosiveCoderflome/ani-book-skill>。

版本说明：Scriptor 和 oh-story 的版本对应 npm 发布版本；Biz Novel Studio 使用当次研究时同步的 `origin/main`。上游更新后，来源结论和实现建议需要重新核对。

## 1. 设计目标

Novel Forge 不是一个只负责生成段落的聊天技能，而是一套文件驱动、阶段受控、可恢复的长篇小说生产插件。

第一目标是完成下面这条闭环：

```text
灵感
 -> 作品契约
 -> 故事宏观方向
 -> 卷战略
 -> 节奏段
 -> 章节计划
 -> 正文草稿
 -> 确定性检查
 -> AI 审读
 -> 作者接受
 -> 正式正文
 -> 事实、角色和伏笔沉淀
```

设计必须同时满足：

1. 新手可以按步骤完成一本书，不需要理解复杂的小说术语。
2. 作者始终拥有故事方向、重要人物选择和正文采纳权。
3. 已保存正文不会被规划重跑、重试或修复意外覆盖。
4. 章节生产中断后可以从最近的可靠边界恢复。
5. 事实、角色心理、候选推演和正式正文不会互相污染。
6. 当前章节可以先写，未来尚未规划的部分不阻塞当前工作。

## 2. 三个参考项目的吸收矩阵

### 2.1 Scriptor：生产纪律层

吸收：

- 总控技能只负责状态校准、节点路由和交接，不直接代写正文。
- 各生产节点有独立输入、输出、重入、失败恢复和完成标志。
- 草稿、候选、正式正文、审读报告和记忆分离保存。
- 修改已有正文必须通过专门的修订或作者接受通道。
- 审读发现必须带证据、位置、维度、严重程度和建议动作。
- 定稿后才进行事实、时间线、承诺、伏笔和文风沉淀。
- 记忆默认少写，只保留长期有效且无法从现有工件恢复的信息。
- 作者在编辑器中保存后，系统只处理本次明确保存的版本，不自动扩大任务范围。
- 文件门禁、版本哈希、冲突检测和提交结果必须可解释。

不吸收：

- 不复制 GPL-3.0-only 代码。
- 不照搬其全部技能数量和工具命名。
- 不把主控设计成另一个超大 Prompt。

### 2.2 oh-story：项目结构层

吸收：

- 一个创作项目对应一个可读的工作区目录。
- 每个阶段有明确文件合同和阶段入口。
- 工作台读取项目文件状态，不维护一套与文件相冲突的隐形状态。
- 允许阶段部分完成，当前可执行范围不必等待全书完成。
- 生成、审查、生产和交付分别定义边界。
- 会产生外部成本的生产动作必须经过显式确认。
- 复杂流程通过文件和结构化交接，而不是依赖长聊天历史。

不吸收：

- 第一版不同时实现短剧、游戏和视频工作台。
- 不把所有创作能力都注册到同一个入口。
- 不把客户端演示状态当作生产事实。

### 2.3 Biz Novel Studio：长篇运行时层

吸收：

- 自动导演是一条持久化、可恢复、可取消、可重试的任务流水线。
- 章节生产拆成准备、上下文组装、生成、检查、修复、保存、沉淀和收尾。
- 任务需要心跳、执行租约、运行状态、恢复点和幂等保护。
- 局部质量问题默认形成质量债务，不直接阻断整本书。
- 只有显式重规划、不可恢复生成失败或数据完整性错误才停止全局执行。
- 角色硬事实、角色主观状态和未确认推演必须分层。
- 角色状态必须提供来源、证据和置信度。
- 章节资产抽取应作为统一后置处理，避免多个独立模型链互相覆盖。
- 卷战略、卷骨架、节奏段和章节计划是不同层级的资产。
- 已有正文范围锁定；规划变化默认只影响未写范围。
- 长卷按当前节奏段渐进生成，后续空缺不阻塞当前写作。

不吸收：

- 不复制其数据库、服务或前端实现。
- 第一版不引入完整的商业化用量、图片和漫画生产体系。
- 不使用复杂数据库状态替代项目文件作为作者可见真源。

## 3. Novel Forge 自有设计

三个参考项目的能力不会直接拼接。Novel Forge 自己增加以下组合规则：

### 3.1 文件是真源，运行状态是投影

- 作者可读、可编辑的作品文件是真源。
- `runs/` 只记录执行事实、恢复游标和调用结果。
- 客户端只展示文件和运行状态的投影。
- 客户端不能偷偷创造一份与文件不同的作品资料。

### 3.2 每次 AI 调用必须有输入边界

每个 Prompt 都声明：

- 任务目的。
- 必须读取的文件。
- 可选读取的文件。
- 禁止读取的文件。
- 输出 schema。
- 失败后的处理方式。

### 3.3 规划、写作、审读和沉淀互相独立

一个阶段完成，不代表下一个阶段自动获得作者授权。机械步骤可以连续执行，但方向改变、重要角色选择、审读处置和正式采纳必须停稳等待作者决定。

### 3.4 “可继续”优先于“看起来全部成功”

一次运行可以得到：

- 成功。
- 成功但带质量债务。
- 等待作者确认。
- 可恢复失败。
- 不可恢复失败。

不能把“生成了部分内容”伪装成成功，也不能因为一条局部建议失败而丢弃已经保存的章节。

## 4. DeepSeek Harness 插件边界

### 4.1 插件负责

- 注册小说技能、工具和可选客户端。
- 解析当前工作区和当前作品。
- 读取、校验和保存作品文件。
- 执行确定性检查。
- 调用结构化 Prompt。
- 持久化运行状态和恢复点。
- 展示生成、审读、修订和沉淀结果。

### 4.2 插件不负责

- 替宿主保存模型凭据。
- 绕过宿主权限和审批。
- 在用户未确认时调用付费媒体服务。
- 把任意工作区文件当作小说事实。
- 修改其他作品目录。
- 把聊天历史当作唯一的作品状态。

### 4.3 建议包结构

```text
novel-forge/
├── docs/                       # 跨版本设计与协议
└── packages/
    └── dsh-plugin/
        ├── package.json
        │   ├── src/
        │   │   ├── index.ts
        │   │   ├── runtime/
        │   │   ├── contracts/
        │   │   ├── tools/
        │   │   ├── prompting/
        │   │   ├── validation/
        │   │   └── client/
        ├── skills/
        │   ├── novel/
        │   ├── novel-setup/
        │   ├── novel-planning/
        │   ├── novel-chapter/
        │   ├── novel-review/
        │   ├── novel-revise/
        │   └── novel-settle/
        └── scripts/
            ├── validate-book.mjs
            ├── validate-chapter.mjs
            └── inspect-run.mjs
```

`packages/dsh-plugin/src/index.ts` 只做插件接线、依赖声明和生命周期注册，不能承载完整业务流程。未来版本放在 `packages/` 下并复用根 `docs/` 和 `shared/` 的稳定合同。

## 5. 作品工作区合同

```text
books/
└── <book-id>/
    ├── book.yaml
    ├── contract.md
    ├── story/
    │   ├── premise.md
    │   ├── macro-plan.md
    │   ├── world.md
    │   └── style.md
    ├── characters/
    │   ├── index.yaml
    │   └── <character-id>.yaml
    ├── planning/
    │   ├── volume-strategy.yaml
    │   ├── volumes/
    │   └── chapters/
    ├── chapters/
    │   └── <chapter-id>/
    │       ├── plan.yaml
    │       ├── materials.yaml
    │       ├── draft.md
    │       ├── review.yaml
    │       └── final.md
    ├── memory/
    │   ├── facts.yaml
    │   ├── timeline.yaml
    │   ├── promises.yaml
    │   ├── foreshadowing.yaml
    │   └── candidates/
    └── runs/
        ├── current.json
        └── history/
```

### 5.1 文件角色

| 文件 | 作用 | 是否可被 AI 自动覆盖 |
|---|---|---|
| `book.yaml` | 作品身份和版本 | 仅通过作品工具 |
| `contract.md` | 读者承诺、篇幅、视角、文风和禁区 | 否，需作者确认 |
| `macro-plan.md` | 全书方向和长期约束 | 否，需作者确认 |
| `volume-strategy.yaml` | 卷数、卷职责和 hard/soft 范围 | 否，需作者确认 |
| `plan.yaml` | 单章执行计划 | 只能生成候选 |
| `draft.md` | 正文工作稿 | 可由写作流程生成 |
| `final.md` | 作者接受的正式正文 | 不得自动覆盖 |
| `review.yaml` | 审读报告和问题处置 | 由审读工具写入 |
| `memory/*` | 正式连续性资料 | 先候选，后提交 |
| `runs/*` | 执行状态和恢复记录 | 由运行时管理 |

### 5.2 作品契约字段

```yaml
id: book-001
title: 示例作品
genre: 玄幻
target_platform: 起点
target_length: 1000000
chapter_word_count:
  target: 3000
  min: 2400
  max: 3800
viewpoint: limited-third
reader_promise:
  - 主角持续成长
  - 冲突必须产生后果
  - 每卷完成一个阶段回报
style:
  tone: tense
  forbidden:
    - 空泛总结
    - 连续解释设定
    - 无后果冲突
```

## 6. 技能与路由

### 6.1 `/novel` 总控

总控每次先读取作品状态，再判断路由。它只负责：

- 确认当前作品。
- 判断当前节点。
- 读取节点所需工件。
- 加载对应技能。
- 组装交接包。
- 汇报结果和下一步。

总控禁止：

- 直接代写正文。
- 擅自确认故事方向。
- 擅自提交候选规划。
- 用聊天记忆代替文件读取。
- 越过失败边界继续假装成功。

### 6.2 第一版技能

| 技能 | 职责 |
|---|---|
| `/novel-setup` | 建书、作品契约、宏观方向和世界基础 |
| `/novel-planning` | 卷战略、卷骨架、节奏段和章节计划 |
| `/novel-chapter` | 当前章节材料、正文草稿、检查和保存 |
| `/novel-review` | 结构化审读和问题报告 |
| `/novel-revise` | 根据已确认问题生成修订候选 |
| `/novel-settle` | 正文接受后提取事实、角色变化和伏笔 |

第一版不拆出过多细粒度技能。只有当同一技能出现明确的上下文边界或独立重入需求时才拆分。

## 7. 规划模型

规划分四层：

```text
全书宏观方向
  -> 卷战略
  -> 卷骨架 / 节奏段
  -> 章节计划
```

### 7.1 卷战略

卷战略至少包含：

- 卷职责。
- 阶段回报。
- 冲突升级。
- 主角变化。
- 卷末牵引。
- 不确定项。
- hard / soft 范围。

卷数由故事结构和作品长度共同决定，不使用简单的“总章节数除以固定值”。用户明确指定卷数时，用户选择优先于模型建议。

### 7.2 节奏段

节奏段使用稳定职能槽位和动态短标题：

```text
open_hook
first_escalation
midpoint_turn
pressure_lock
climax
end_hook
```

职能名稳定，短标题动态生成。这样既保留结构校验能力，又不会让所有题材套同一组僵硬标题。

### 7.3 渐进拆章

默认只生成当前节奏段的章节列表：

- 已完成节奏段可以执行。
- 未生成节奏段保持 `pending`。
- 当前段完成后再推进下一段。
- 已有正文的章节不能因重新规划而被删除或重写。
- 整卷全量生成只作为高级操作。

## 8. 角色模型

角色分为三层：

### 8.1 硬事实层

```yaml
id: char-001
name: 林砚
role: protagonist
identity: 黑石城外门弟子
relationships:
  char-002: distrust
location: 黑石城
resources:
  - 残缺地图
known_facts:
  - 师父失踪
```

硬事实可以约束正文，必须带来源章节或作者来源。

### 8.2 主观状态层

```yaml
mind:
  understands:
    - 拍卖会可能存在师父遗物
  wants:
    - 找到地图下半部分
  fears:
    - 同伴背叛
  likely_misjudgment:
    - 误以为对手尚未发现自己的身份
  evidence:
    - chapter-002: "他把地图藏进袖中"
  confidence: medium
```

主观状态只是写作引导，不能自动成为旁白事实。

### 8.3 推演草稿层

多个未来选择、关系路线和影响预览全部放在独立草稿中。作者确认后才能进入正式计划，不能直接注入章节上下文。

## 9. 章节生产流水线

```text
准备章节
 -> 读取契约、卷约束、章节计划
 -> 读取本章参与角色和必要记忆
 -> 生成写作材料包
 -> 生成正文草稿
 -> 确定性检查
 -> AI 审读
 -> 生成修订候选
 -> 作者接受或退回
 -> 保存 final.md
 -> 统一抽取章节资产
 -> 更新候选账本
 -> 更新运行状态
```

### 9.1 写作上下文分层

章节 Prompt 按以下顺序组装：

1. 作品契约：硬约束。
2. 全书和当前卷约束：结构目标。
3. 当前节奏段和章节计划：本章任务。
4. 已保存正文的相邻章节：连续性上下文。
5. 本章实际参与角色：角色硬事实和主观倾向。
6. 相关事实、承诺、伏笔：必要的长期记忆。
7. 作者本次明确要求：当前任务指令。

未参与角色、未确认推演和无证据心理判断不得注入。

### 9.2 确定性检查

确定性检查不替代 AI 审读，只负责可机械证明的内容：

- 输出不为空。
- 章节标题和章节编号正确。
- 字数处于契约范围或明确标记越界。
- 必须角色出现。
- 必须事件出现。
- 禁止提前兑现的节点未提前完成。
- 文件结构和 frontmatter 合法。
- 正式正文版本未被并发修改。

### 9.3 审读维度

第一版采用八个维度：

1. 章节结构。
2. 人物与关系。
3. 情节与因果。
4. 信息披露。
5. 线索与伏笔。
6. 节奏与张力。
7. 读者承诺。
8. 文风与表达。

每个问题必须包含：

```yaml
id: review-001
dimension: causality
severity: medium
location: chapter-003 paragraph-5
evidence: "..."
problem: 主角的行动缺少前置动机
suggested_action: local_patch
blocks_global_run: false
```

## 10. 质量问题策略

```text
local_patch
  局部修订后继续

continue_with_warning
  记录质量债务，继续后续章节

pause_for_manual
  保存恢复点，等待作者确认

replan_required
  当前结构不再可靠，需要重新规划

runtime_failure
  环境、数据完整性或持久化失败，停止运行
```

默认规则：章节质量问题不自动阻断全书。只有明确要求重规划、没有可用正文、数据完整性失败或运行时安全错误才停止全局任务。

## 11. 事实、伏笔和沉淀

正式正文保存后只进行一次统一的章节资产抽取：

```yaml
facts:
  - statement: 林砚拿到残缺地图
    source:
      chapter: 3
      quote: "..."
    confidence: high

character_changes:
  - character_id: char-001
    change: 开始怀疑同伴
    source:
      chapter: 3
      quote: "..."

promises:
  - item: 师父印记的来源
    introduced_in: 3
    payoff_window: 8-12

foreshadowing:
  - item: 拍卖品上的旧印记
    status: planted
```

写入顺序：

```text
抽取候选
 -> schema 校验
 -> 证据校验
 -> 与现有账本冲突检测
 -> 作者可见候选
 -> 提交正式账本
```

不能把模型猜测直接写进正式事实。

## 12. 运行时和恢复

每次运行都写入 `runs/current.json`：

```yaml
run_id: run-20261012-001
book_id: book-001
kind: chapter-production
status: generating
current_stage: chapter_draft
current_item: chapter-003
completed_stages:
  - preparation
retry_count: 0
heartbeat_at: 2026-10-12T12:00:00Z
resume_cursor:
  chapter: chapter-003
  stage: chapter_draft
source_versions:
  contract: sha256:...
  plan: sha256:...
```

恢复规则：

- 有 `final.md` 且版本哈希一致：跳过正文生成，继续审读或沉淀。
- 有 `draft.md` 但没有 `final.md`：保留草稿，等待作者接受或重新生成。
- 来源文件版本变化：停止自动恢复，重新组装材料。
- 运行租约失效：旧执行者不得继续写入。
- 取消任务：保存当前状态，不删除已有工件。
- 重试必须幂等，不重复提交已完成的阶段。

## 13. 工具边界

第一版工具分为五组：

### 13.1 作品工具

- `novel_list_books`
- `novel_create_book`
- `novel_get_status`
- `novel_read_contract`
- `novel_update_contract_candidate`
- `novel_confirm_contract`

### 13.2 规划工具

- `novel_generate_macro_plan`
- `novel_generate_volume_strategy`
- `novel_generate_beat_sheet`
- `novel_generate_chapter_plan`
- `novel_confirm_plan`

### 13.3 章节工具

- `novel_prepare_chapter`
- `novel_generate_draft`
- `novel_validate_chapter`
- `novel_accept_draft`
- `novel_save_final`
- `novel_resume_run`

### 13.4 审读工具

- `novel_review_chapter`
- `novel_review_issue`
- `novel_create_revision_candidate`
- `novel_accept_revision`

### 13.5 沉淀工具

- `novel_extract_chapter_assets`
- `novel_list_memory_candidates`
- `novel_commit_memory_candidate`
- `novel_get_continuity_status`

工具只做结构化动作，不把大段业务决策隐藏在工具内部。

## 14. 客户端工作台

第一版客户端只做以下视图：

```text
作品选择
 ├── 当前阶段和恢复位置
 ├── 故事与卷目录
 ├── 当前章节计划
 ├── 正文草稿 / 正式正文
 ├── 审读问题
 ├── 角色状态
 └── 待提交记忆候选
```

工作台原则：

- 展示事实和状态，不替 Agent 决定创作方向。
- 所有保存、接受、提交和恢复操作都调用正式工具。
- 运行记录只读，工作流操作回到源页面。
- 未保存草稿和正式正文视觉上明确区分。
- 质量债务是提醒，不默认显示为整本书失败。

## 15. 第一阶段实现计划

### Phase 0：可运行插件

- 初始化 DSH 插件包。
- 注册插件入口和一个 `/novel` 总控技能。
- 识别工作区。
- 实现作品目录和基础文件读写。
- 实现 schema 校验和最小测试。

### Phase 1：建书和规划

- 创建作品。
- 生成和确认作品契约。
- 生成宏观方向。
- 生成一卷战略。
- 生成当前节奏段和章节计划。

### Phase 2：单章闭环

- 章节材料组装。
- 正文草稿生成。
- 确定性检查。
- 审读报告。
- 修订候选。
- 作者接受后保存正式正文。

### Phase 3：恢复和沉淀

- 运行状态。
- 取消、重试和恢复。
- 章节资产抽取。
- 事实、角色、时间线和伏笔候选。
- 正式账本提交。

### Phase 4：客户端工作台

- 作品和章节目录。
- 草稿与正文阅读。
- 审读问题处理。
- 角色和连续性视图。
- 运行状态和恢复入口。

### Phase 5：高级能力

- 书籍参考拆解。
- 增量检索。
- 角色对话。
- 章节批量自动导演。
- 更细的用量和上下文缓存。

## 16. 明确不做的事情

当前设计不包含：

- 复制 Scriptor 的 GPL 代码。
- 直接移植 Biz 的数据库和服务代码。
- 一开始就做短剧、游戏和视频生产。
- 一开始就做向量数据库和复杂 RAG。
- 让模型自动修改正式正文。
- 用关键词匹配代替结构化 AI 判断。
- 用一个巨大 Prompt 同时完成规划、写作、审读和沉淀。
- 用客户端状态代替作品文件。
- 用一次性全书生成代替渐进规划。

## 17. 许可证和来源记录

```text
Scriptor / webnovel-writer
License: GPL-3.0-only
Use: 只吸收公开设计思想，不复制代码

oh-story-dsh
License: MIT
Use: 参考文件协议、技能分层和工作台组织，代码独立实现

Biz Novel Studio / AI-Novel-Writing-Assistant
License: 仓库自有双许可模型
Use: 参考角色、自动导演、恢复和账本设计，代码独立实现
```

Novel Forge 自己的代码、文件合同、Prompt schema、运行状态和组合流程由本项目独立实现，并在后续代码中继续保留来源注释和设计归属说明。

## 18. 设计验收标准

在进入大规模开发前，必须满足：

1. 新建一本空书后可以只通过插件完成作品契约和第一章计划。
2. 第一章生成失败时，已有文件不被破坏。
3. 正文草稿不会自动变成正式正文。
4. 正式正文修改必须可追踪、可恢复。
5. 章节质量问题可以继续、暂停或重规划，且决策有记录。
6. 角色心理不会被写入硬事实。
7. 章节保存后可以生成带证据的事实和伏笔候选。
8. 关闭客户端后可以根据 `runs/current.json` 恢复任务。
9. 当前节奏段未完成时不会阻塞已经准备好的章节。
10. 参考项目来源和许可证边界在代码、文档和发布说明中保持可追踪。
