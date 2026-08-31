# pi-better-auto-compact

[![pi extension](https://img.shields.io/badge/pi-extension-9333EA)](https://www.npmjs.com/package/pi-better-auto-compact)
[![npm](https://img.shields.io/npm/v/pi-better-auto-compact?logo=npm)](https://www.npmjs.com/package/pi-better-auto-compact)
[![tests](https://img.shields.io/github/actions/workflow/status/fishcat37/pi-better-auto-compact/ci.yml?branch=main&label=tests)](https://github.com/fishcat37/pi-better-auto-compact/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/fishcat37/pi-better-auto-compact)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TS-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![tested with](https://img.shields.io/badge/tested_with-Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

pi coding agent 的 auto-compact 扩展：在 pi 内置的"剩余 token 阈值"之外，补充按**上下文百分比**或**已用 token 数**触发自动压缩的阈值，所有阈值（含内置）取最低者生效。

- GitHub：https://github.com/fishcat37/pi-better-auto-compact
- npm：https://www.npmjs.com/package/pi-better-auto-compact

## 这是什么

pi 内置的 auto-compact 只支持一种口径：上下文剩余 token 不足时压缩（由 `settings.json` 的 `compaction.reserveTokens` 控制，默认 16384，即窗口减去保留量）。它无法表达"用到 90% 就压缩""用到 240k 就压缩"这类更直观的需求。

本扩展补充两种阈值，并与内置阈值一起取**最低者**生效（最先到达的触发 compact）：

| 阈值 | 含义 |
|------|------|
| pi 内置 `compaction.reserveTokens` | 剩余 token 不足（窗口 − 保留量）时 |
| `percentThreshold` | 已用上下文达到模型上下文窗口的百分之多少时 |
| `usedTokensThreshold` | 已用上下文超过固定 token 数时（如 `240000` 表示 240k） |

例：1M 窗口的模型，配置 `percentThreshold: 90`（900k）和 `usedTokensThreshold: 240000`（240k），加上内置剩余阈值（983.6k），则已用达到 **240k** 时最先触发 compact。若内置阈值最低，则仍由 pi 原生 auto-compact 触发，行为不变。

扩展不改变 pi 原生 auto-compact 的行为，只在扩展阈值更低时接管触发，详见[行为说明](#行为说明)。

## 安装

用 pi 自带的包管理命令安装：

```bash
# 全局安装，所有项目的会话生效
pi install npm:pi-better-auto-compact

# 仅当前项目生效
pi install -l npm:pi-better-auto-compact
```

或从 GitHub 源码安装：

```bash
pi install git:github.com/fishcat37/pi-better-auto-compact
```

安装后重启 pi 生效；修改配置后在运行中的会话执行 `/reload` 重新加载。

## 配置

扩展需要显式配置阈值，**两个字段都省略时扩展不动作**（pi 内置 auto-compact 不受影响）。

配置文件为 JSON，项目配置浅合并覆盖全局：

| 位置 | 路径 |
|------|------|
| 全局 | `~/.pi/agent/better-auto-compact.json` |
| 项目 | `<项目>/.pi/better-auto-compact.json` |

```json
{
  "enabled": true,
  "percentThreshold": 90,
  "usedTokensThreshold": 240000
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean（默认 `true`） | 总开关。`false` 时扩展完全不动作，pi 内置 auto-compact 不受影响 |
| `percentThreshold` | number，(0, 100] | 百分比阈值，可省略 |
| `percentEnabled` | boolean（默认 `true`） | 百分比阈值开关。`false` 时该阈值不参与比较，数值保留在配置中 |
| `usedTokensThreshold` | 正整数 | 已用上下文阈值（token 数），可省略 |
| `usedTokensEnabled` | boolean（默认 `true`） | 已用阈值开关。`false` 时该阈值不参与比较，数值保留在配置中 |

另外：

- 非法字段会被忽略，并在 `/compact-thresholds` 中提示。
- pi 内置的剩余阈值继续由 pi 自己的设置控制（`settings.json` 的 `compaction.reserveTokens`、`compaction.enabled`），本扩展会读取并与扩展阈值一起比较。

## 命令

- `/compact-thresholds`：查看当前模型的上下文窗口、各阈值换算后的取值、最低者与触发方（pi 内置 / 本扩展）、当前用量，以及被开关禁用的阈值和配置问题提示。
- `/compact-toggle`：开关或直接设置两种补充阈值。无参数时打开交互菜单，逐项切换并立即生效，可连续切换（Esc 退出）；也支持参数形式 `/compact-toggle percent|used on|off|<数值>`：
  - `/compact-toggle percent 90` 设置百分比阈值为 90%；`/compact-toggle used 240000` 设置已用 token 阈值为 240000。
  - 写入配置文件并重载内存配置，**本次会话立即生效**，无需 `/reload`，重启后仍保持。
  - 数值与开关字段写在提供该阈值数值的配置文件里（项目配置优先）；两处都未配置数值时，设置数值会写入项目配置（目录不存在自动创建），并清除对应开关字段（恢复默认开启）。
  - 非法参数（如 `percent 150`、`used 110.5`）、JSON 损坏，或开关时阈值尚未配置数值，会提示且不改动文件。

## 行为说明

- **检查时机与 pi 原生完全一致**：agent run 完整结束后、发送新消息前各检查一次，循环中途（工具调用轮次之间）不检查、不打断；用户主动中断的 run 跳过检查，由发送新消息前的检查点兜底；compact 失败后重发消息会立即重试。
- **只在需要时接管**：仅当配置的扩展阈值严格低于内置阈值、且已用量尚未越过内置阈值时，扩展才调用 `ctx.compact()`；一旦越过内置阈值，交给 pi 原生（threshold/overflow 全套机制）处理。
- **压缩本身走 pi 原生路径**：与原生 auto-compact 使用同一个切点计算和默认摘要生成器，不注入自定义指令，会话中的 compaction 记录内容相同。唯一差异：pi 的 API 会把 `ctx.compact()` 标记为手动触发，因此压缩进行中状态条显示 "Compacting context..."（原生自动压缩显示 "Auto-compacting..."），压缩结果不受影响。
- **resume 行为与原生一致**：加载会话时只读取配置、不压缩；resume 到已超限的会话时，等发送新消息前的检查点才处理。
- **触发提示**：触发时提示一条"哪个阈值生效"（取最低值语义下原生没有的信息）；无 UI 模式下静默。

## 开发

依赖用 pnpm 管理：

```bash
pnpm install      # 安装 devDependencies（typescript、@types/node、pi 类型）
pnpm check        # tsc --noEmit 类型检查
pnpm test         # node --test 运行单元与集成测试
```

扩展无需编译：pi 通过内置的 jiti 加载器直接运行 TypeScript 源码，并把 `@earendil-works/pi-coding-agent` 导入解析到 pi 自身，因此运行时不需要 node_modules（依赖仅用于本地类型检查与测试）。测试通过临时 `$HOME` 隔离真实用户配置，不依赖网络与 API key。

## License

MIT
