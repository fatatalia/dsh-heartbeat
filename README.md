# dsh-heartbeat — 心跳插件（独立）

dsh 的**心跳插件**：定期触发法塔依工作区 `HEARTBEAT.md` 检查，由法塔**自行决定**是否主动发送 iMessage 给代码东。独立于 iMessage 网关插件。

## dsh 版本兼容性

**要求 dsh ≥ 0.1.7-rc.1**（已在 0.1.7-rc.1 实测通过）。

- **`ctx.settings.register()` 已移除**（2026-09-24）：原 `heartbeat` settings namespace 并入插件 `Config`，可热改字段标 `.volatile()`，`.default()` 承担原 `base` 的运行时兜底；`inject` 去掉 `settings`。
- **Typert strict codec 必须带 `create()` 工厂**（0.1.7 客户端校验）。

## 职责边界
- **只做心跳节奏**：定时触发 → 创建独立会话 → 投心跳 prompt → 法塔决策 → 归档。
- **不实现发送**：发消息由 iMessage 插件注册的全局 `message` 工具承担。心跳会话里的法塔要发时自然能调到它。
- **不管理会话上下文**：每次心跳独立会话（减少上下文），完成后归档（不堆积）。

## 工作方式
```
timer 循环（每 N 秒，可配）
  → 到点（非静默时段）触发一次心跳
  → 创建独立会话 heartbeat-<ts>（cwd=心跳工作区）
  → 投心跳 prompt：法塔读该工作区 HEARTBEAT.md 依清单检查
  → 要发则调 message 工具发 iMessage；否则静默（HEARTBEAT_OK）
  → 完成 → 自动归档该会话
```

## 配置项（Settings → 心跳）
| 配置 | 说明 | 默认 |
|---|---|---|
| 启用心跳 | 总开关 | true |
| 心跳间隔（秒） | 每 N 秒检查一次该不该心跳 | 1800 |
| 心跳工作区路径 | 心跳会话 cwd（读哪的 HEARTBEAT.md） | `~/dsh/default` |
| 静默时段开始/结束（时） | 该时段不自动心跳 | 22 / 7 |
| **立即心跳一次** | 手动触发（忽略静默） | 按钮 |

## 结构
```
dsh-heartbeat/
├── index.js              # host 插件：配置 remote(get/set/trigger) + 启动 await runner
├── client.js             # 配置页（Settings→心跳，含立即心跳按钮）
├── lib/heartbeat-core.mjs# HeartbeatRunner：静默检查/建会话/投 prompt/归档
├── cordis.patch.yml      # 插入 host 插件行
└── package.json          # dsh.bundle + dsh.client
```

## 依赖 dsh 服务（host）
`typert`/`settings`/`agents`/`agentDefaultModel`/`agentPresets`/`sessions`/`workspaceRegistry`/`timer`

## message 工具（由 iMessage 插件提供）
- iMessage 插件（dsh-imessage）注册**全局** `message` 工具，任何 agent（含心跳会话）可调：
  `message(action=send, channel=imessage, target=+8613800000000, message="...")`
- 心跳/法塔要发消息就调它。

## 心跳工作区资源
心跳工作区（如 ~/dsh/default）需有 `HEARTBEAT.md`（检查清单）+ 相关监控脚本（`scripts/`）+ 技能（`skills/`）。

## 说明
- 自动心跳 `every` 间隔最小建议 ≥30s；默认 1800s。
- 手动触发忽略静默时段（用于验证/主动心跳）。
- 心跳会话归档后在工作区列表隐藏，session 文件保留可查。
