# Novel Forge

Novel Forge 是一个多版本小说创作项目。共享设计、数据合同和来源说明放在根目录；各宿主版本放在 `packages/` 下。

## 目录

```text
novel-forge/
├── docs/                    # 全项目设计、协议、来源和许可证
├── packages/
│   └── dsh-plugin/          # DeepSeek Harness 插件版本
│       ├── src/
│       ├── lib/
│       ├── scripts/
│       ├── skills/
│       └── test/
├── shared/                  # 未来的跨版本合同和 schema
├── web-app/                 # 未来 Web 版本
└── desktop/                 # 未来桌面版本
```

当前实现版本是 `packages/dsh-plugin`。未来版本应复用根 `docs/` 与 `shared/` 的稳定合同，具体运行时、客户端和构建产物保留在自己的版本目录中。

设计文档：[docs/design.md](docs/design.md)
