# better-auto-compact

pi coding agent 的扩展：在 pi 内置 auto-compact 的"剩余 token 阈值"之外，补充两种阈值方式，并让所有阈值**取最低者生效**（最先到达的触发 compact）。

- pi 自身只支持"剩余多少 token 时 compact"（`compaction.reserveTokens`，默认 16384，即上下文窗口减去保留量）。
- 本扩展补充：
  - **百分比阈值** `percentThreshold`：已用上下文达到模型上下文窗口的百分之多少时 compact。
  - **已用上下文阈值** `usedTokensThreshold`：已用上下文超过固定 token 数时 compact（如 `110000` 表示 110k）。

三种阈值统一换算为"已用 token"口径取最低值。例如 200k 窗口的模型，配置百分比 80%（160k）和已用 110k，加上内置剩余阈值（183.6k），则已用达到 **110k** 时最先触发 compact。若内置阈值最低，则仍由 pi 原生 auto-compact 触发，行为不变。

## 安装

任选其一：

```bash
# 方式一：复制到全局扩展目录（对所选项目之外的所有会话生效）
mkdir -p ~/.pi/agent/extensions && cp -r better-auto-compact ~/.pi/agent/extensions/

# 方式二：settings.json 的 extensions 数组指向本目录（全局 ~/.pi/agent/settings.json 或项目 .pi/settings.json）
{ "extensions": ["/path/to/better-auto-compact/src/index.ts"] }

# 方式三：pi 包安装（git 仓库形式时）
pi install git:github.com/<you>/better-auto-compact
```

仅对某个项目启用时，把路径写进该项目的 `.pi/settings.json` 即可。

## 配置

配置文件为 JSON，项目配置浅合并覆盖全局：

| 位置 | 路径 |
|------|------|
| 全局 | `~/.pi/agent/better-auto-compact.json` |
| 项目 | `<项目>/.pi/better-auto-compact.json` |

```json
{
  "enabled": true,
  "percentThreshold": 80,
  "usedTokensThreshold": 110000
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean（默认 `true`） | 总开关。`false` 时本扩展完全不动作，pi 内置 auto-compact 不受影响 |
| `percentThreshold` | number，(0, 100] | 百分比阈值，可省略 |
| `usedTokensThreshold` | 正整数 | 已用上下文阈值（token 数），可省略 |

两个字段都省略时本扩展不生效。pi 内置的剩余阈值继续用 pi 自己的设置（`settings.json` 的 `compaction.reserveTokens`、`compaction.enabled`），本扩展会读取并与扩展阈值一起比较。

非法字段会被忽略并在 `/compact-thresholds` 中提示；修改配置后执行 `/reload` 生效。

## 命令

- `/compact-thresholds`：查看当前模型的上下文窗口、各阈值换算后的取值、最低者与触发方（pi 内置 / 本扩展）、当前用量，以及配置问题提示。

## 工作原理

- 本扩展不改变 pi 内置 auto-compact：内置阈值仍由 pi 在每次请求前检查并触发。本扩展在每次 turn 结束（`turn_end`）和会话启动（`session_start`，覆盖 resume 到已超限会话的场景）读取 `ctx.getContextUsage()`，只有当**配置的扩展阈值严格低于内置阈值**（或内置已禁用）时才接管，调用 `ctx.compact()` 触发压缩。
- compact 进行中不会重复触发；compact 失败后，需已用量在失败点之上再增长 4096 token 才会重试，避免每轮失败重试刷屏。
- 触发与完成/失败都会通过通知提示（无 UI 模式下静默）。

## 开发

依赖用 pnpm 管理：

```bash
pnpm install      # 安装 devDependencies（typescript、@types/node、pi 类型）
pnpm check        # tsc --noEmit 类型检查
pnpm test         # node --test 运行单元与集成测试
```

扩展无需编译：pi 通过内置的 jiti 加载器直接运行 TypeScript 源码，并把 `@earendil-works/pi-coding-agent` 导入解析到 pi 自身，因此运行时不需要 node_modules（依赖仅用于本地类型检查与测试）。

测试通过临时 `$HOME` 隔离真实用户配置，不依赖网络与 API key。

## 目录结构

```
better-auto-compact/
├── package.json            # "pi": { "extensions": ["./src/index.ts"] } 声明扩展入口
├── pnpm-workspace.yaml     # pnpm 配置（声明忽略 pi 传递依赖的无害构建脚本）
├── tsconfig.json
└── src/
    ├── index.ts            # 扩展入口：事件监听、compact 触发、/compact-thresholds 命令
    ├── config.ts           # 配置文件读取、合并与校验（全局 + 项目）
    ├── thresholds.ts       # 阈值换算与取最低值（纯函数）
    ├── thresholds.test.ts  # 阈值与配置单元测试
    └── integration.test.ts # 扩展入口集成冒烟测试（mock pi API）
```
