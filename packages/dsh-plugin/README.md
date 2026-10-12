# Novel Forge DSH

Novel Forge DSH 是一个面向长篇小说生产的 DeepSeek Harness 插件。

当前阶段只包含设计，不依赖 `novel-forge-studio`，也不修改其代码。

核心目标：让作者从一句灵感开始，经过作品契约、全书规划、卷与章节规划、正文生产、审读和沉淀，稳定完成一章可保存、可恢复、可继续的小说正文。

设计文档见 [`../../docs/design.md`](../../docs/design.md)。

参考项目：

- Scriptor：<https://github.com/lingfengQAQ/webnovel-writer>，生产纪律、审读与沉淀机制。GPL-3.0-only，只吸收设计，不复制代码。
- oh-story：<https://github.com/zenstory-ai/oh-story-dsh>，文件协议、阶段结构和工作台组织。MIT，可参考其公开实现，但本项目保持独立实现。
- Biz Novel Studio：<https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant>，角色主体性、自动导演运行时、质量债务和连续性账本。遵守其仓库许可证，不复制实现。
