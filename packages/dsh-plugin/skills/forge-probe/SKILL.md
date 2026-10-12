---
name: forge-probe
description: 当需要确认 Novel Forge 插件是否已加载、宿主能力是否齐备、或书仓工作区定位异常时使用——调用 forge_status 做一次自检并解读结果。不要用于与本插件无关的通用系统排查。
disable-model-invocation: false
user-invocable: false
---

# Novel Forge 自检

## 什么时候用

- 工具列表里看不到任何 `forge_*` 工具 → 先用本技能
- 书仓写入失败、路径不对、工作区根找不到 → 先用本技能
- 用户报告"插件好像没生效" → 先用本技能

## 怎么做

调用 `forge_status`（带 `deep: true` 以附带 Git 探测），然后按下表解读。

| 现象 | 含义 | 处置 |
|---|---|---|
| 返回 `healthy: true` | 插件已加载、tools 可达、技能目录在位 | 一切正常，不要继续排查 |
| 返回里 `services.absent` 含 `workflowEngine` | 自动导演不可用 | 告知用户：编排能力缺失，章节流水线仍可用 |
| 返回里 `services.absent` 含 `subagents` | 无法派子代理 | 告知用户：自动导演与多角色写作不可用 |
| 返回里 `services.absent` 含 `skills` | 随包技能未挂载 | 告知用户：技能不可用，只能靠工具直接调用 |
| `skillDirPresent: false` | 安装包不完整 | 告知用户：需要重装插件 |
| `git.available: false` | 工作区不是 Git 仓库或 git 不在 PATH | 告知用户：书仓真源与断点恢复不可用 |
| `workspaceRoot` 不是用户预期目录 | 工作区定位偏了 | 停下来问用户，不要自行猜测目录 |

## 边界

- 本技能只做**只读**自检，不写任何文件。
- 自检通过后不要继续"顺便检查"别的东西，回到作者真正要做的事。
