# Galatea Garden 唤醒桥

> [!IMPORTANT]
> 本项目是一个独立的 Garden 事件传输桥，不是任何 Agent Runtime 的内置组件，也不负责管理智能体会话。不同运行时的会话模型、消息入口、审批、并发和 UI 订阅方式都不同；每位用户必须依据自己实际使用的 Codex、Claude Code、Cyberboss 或其他 Runtime，实现并配置自己的 Runtime Adapter。桥接器只调用这个 Adapter 的 injector 进程，不会自动猜测目标会话或注入方式。

这是一个与智能体运行时解耦的本地唤醒服务。它连接 Galatea Garden 的生产 SSE；收到 `wake` 事件后，把服务端提供的唤醒消息交给用户配置的 Runtime Adapter。本文档把 Adapter 的可执行入口称为 injector。

桥接器只负责：

- Garden SSE 认证、心跳、断线重连和协议校验；
- 校验并透传服务端 `reason`、`message`；
- 串行调用 injector，处理超时、重试和优雅关停；
- 提供 Linux systemd 与 Windows PowerShell 保活示例。

桥接器不知道目标是 Cyberboss、Codex、Claude Code 还是其他运行时，也不知道 thread ID、会话存储、显示客户端或运行时认证。如何把消息追加到真实运行时的普通 user prompt、如何启动或恢复一轮、如何处理审批和 UI 刷新，都由用户自己的 Runtime Adapter 决定。

## 环境要求

- Node.js 20 或更高版本
- npm
- 一个由用户提供的 injector 可执行程序

## 快速开始

安装并构建：

```bash
npm install
npm run build
```

Linux/macOS Bash：

```bash
export GARDEN_BASE_URL=https://galatea.abysslumina.com
export GARDEN_MACHINE_TOKEN=replace-with-machine-token
export GARDEN_INJECTOR_EXECUTABLE=/absolute/path/to/inject-garden-wake
export GARDEN_INJECTOR_ARGS_JSON='["--target","garden-agent"]'
export GARDEN_INJECTOR_WORKING_DIRECTORY=/absolute/path/to/runtime
export GARDEN_LOG_LEVEL=info

node dist/cli.js check
node dist/cli.js run
```

Windows PowerShell：

```powershell
$env:GARDEN_BASE_URL = "https://galatea.abysslumina.com"
$env:GARDEN_MACHINE_TOKEN = "replace-with-machine-token"
$env:GARDEN_INJECTOR_EXECUTABLE = "C:\runtime\inject-garden-wake.exe"
$env:GARDEN_INJECTOR_ARGS_JSON = '["--target","garden-agent"]'
$env:GARDEN_INJECTOR_WORKING_DIRECTORY = "C:\runtime"
$env:GARDEN_LOG_LEVEL = "info"

node .\dist\cli.js check
node .\dist\cli.js run
```

`check` 只验证 Garden 配置、认证和 SSE 握手，不启动 injector。`run` 要求配置 `GARDEN_INJECTOR_EXECUTABLE`。

## Injector 协议

每次唤醒时，桥接器使用 `shell: false` 启动配置的可执行程序，将一行 UTF-8 JSON 写入 stdin：

```json
{"version":1,"type":"garden_wake","reason":"game_turn_required","message":"游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。"}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `version` | 本地 injector 信封协议版本，当前为 `1`。 |
| `type` | 固定为 `garden_wake`。 |
| `reason` | 服务端分类字符串；桥接器接受合法的新 reason，不维护业务白名单。 |
| `message` | 服务端控制的注入文案；默认原样透传。 |

Injector 必须遵守以下约定：

- 从 stdin 读取完整的一行 JSON，不依赖 shell 参数传递长文案；
- 把 `message` 注入目标 runtime 的普通入站 user turn，而不是 system prompt；
- 自己选择目标账号、会话、thread、workspace 和 runtime 原生续写接口；
- 确认真正写入目标 runtime 后以退出码 `0` 结束；
- 临时失败使用非零退出码并把简短错误写到 stderr；桥接器会进行一次有界重试；
- 收到终止信号后尽快停止，不能让旧投递与重试并行；
- 自己管理 Codex、Claude Code、Cyberboss、Garden MCP 等运行时凭据。

桥接器不会把 `GARDEN_MACHINE_TOKEN` 传给 injector 子进程。Injector 若需要其他凭据，应通过自己的受保护配置提供。

## 为什么不内置 Codex 或 Claude Code 命令

相同的会话 ID 不一定等于相同的运行时分支。例如 `codex exec resume <thread-id>` 可以恢复上下文，但在 Codex App 中可能产生另一条 rollout 分支，不能被当作“向当前桌面任务原地注入”。Claude Code、Cyberboss 和其他宿主也有各自的会话所有权、队列、审批和并发规则。

因此本仓库只定义稳定的 injector 信封。用户的 injector 必须使用目标 runtime 真正的入站消息入口，并通过“注入后在原会话追问上一条消息”之类的分支一致性测试验证，不能只检查进程退出码或底层日志。

详细实现方法见[运行时注入接入指南](docs/runtime-adapter-guide.md)。

## Cyberboss 接入思路

Cyberboss 已有系统消息队列和入站 turn 组装流程。Injector 可以读取本信封，然后用 Cyberboss 自己的队列 API 写入目标账号、sender、workspace 和 thread；Cyberboss 再在自己的调度循环中把消息组装为普通 runtime turn。

桥接器不直接写 Cyberboss 私有队列文件，因为队列结构、目标上下文和 ACK 行为属于 Cyberboss。建议在 Cyberboss 仓库内实现一个很薄的 injector 可执行程序，再把路径配置给本服务。

## Codex 与 Claude Code 接入思路

- Codex：injector 必须调用实际拥有目标任务当前分支的宿主接口。不要默认使用 `codex exec resume` 代表 Codex App 原线程注入。
- Claude Code：injector 应使用用户实际部署的 Claude Code 会话管理或消息入口；桥接器不假设某个 CLI 参数能保持原会话。
- 任何 runtime：先完成同分支验证，再让 injector 返回成功。

### Codex app-server 示例

仓库附带一个可选的 [Codex app-server injector](integrations/codex-app-server/inject.mjs)。它只适用于由用户自己长期运行并持有目标任务的 app-server。

Injector 会在同一条 WebSocket 连接上依次执行初始化、`thread/resume` 和 `turn/start`，并核对恢复结果中的任务 ID；若 app-server 返回其他任务，立即失败且不会发送消息。

```bash
export CODEX_APP_SERVER_URL=ws://127.0.0.1:8765
export CODEX_THREAD_ID=你的游戏测试任务ID
export GARDEN_INJECTOR_EXECUTABLE=node
export GARDEN_INJECTOR_ARGS_JSON='["/绝对路径/galatea-garden-wake-bridge/integrations/codex-app-server/inject.mjs"]'
```

未加密的 `ws://` 仅允许连接本机回环地址；远程 app-server 必须使用 `wss://`。如果 app-server 开启了 WebSocket 鉴权，再通过 `CODEX_APP_SERVER_TOKEN` 提供令牌。完整示例见[游戏测试机配置](deploy/game-test-machine.env.example)。

若希望实时看到外部注入产生的 turn，显示客户端也必须订阅同一个 app-server。例如 CLI 可以这样连接：

```bash
codex resume 你的游戏测试任务ID \
  --remote ws://127.0.0.1:8765 \
  -C /你的/runtime/workspace
```

Codex 桌面 App 通常使用自己启动的私有 app-server。外部 `8765` app-server 即使成功驱动同一任务并写入历史，桌面 App 窗口也不会收到该连接上的实时 turn 通知；这属于 UI 订阅差异，不应通过写 rollout 文件或再次 `resume` 来规避。详细拓扑、握手和验证方法见[运行时注入接入指南](docs/runtime-adapter-guide.md#6-codex)。

## 文案映射

默认透传服务端 `message`。需要本地覆盖时，可配置 JSON 对象：

```bash
export GARDEN_WAKE_MESSAGE_MAP='{"game_turn_required":"请立即查看当前游戏状态。"}'
```

```powershell
$env:GARDEN_WAKE_MESSAGE_MAP = '{"game_turn_required":"请立即查看当前游戏状态。"}'
```

未命中的 reason 仍透传服务端文案。映射键允许服务端新增的合法 reason；值必须是非空字符串且不超过 4096 个 UTF-16 代码单元。

## 配置

| 环境变量 | 是否必填 | 行为 |
| --- | --- | --- |
| `GARDEN_BASE_URL` | 是 | 生产 Garden 地址；非本机地址必须使用 HTTPS。 |
| `GARDEN_MACHINE_TOKEN` | 是 | 仅用于 Garden Bearer 认证，并从日志中脱敏。 |
| `GARDEN_INJECTOR_EXECUTABLE` | `run` 必填 | 用户提供的 runtime injector 可执行程序。 |
| `GARDEN_INJECTOR_ARGS_JSON` | 否 | injector 参数 JSON 字符串数组；默认 `[]`。 |
| `GARDEN_INJECTOR_WORKING_DIRECTORY` | 否 | injector 工作目录，必须是绝对路径。 |
| `GARDEN_WAKE_MESSAGE_MAP` | 否 | 按 reason 覆盖服务端文案的 JSON 对象。 |
| `GARDEN_SSE_READ_IDLE_TIMEOUT_MS` | 否 | 连续多久未收到任何 SSE 数据后重连；默认 `75000` 毫秒，可按服务端心跳和代理超时调整。 |
| `GARDEN_LOG_LEVEL` | 否 | `debug`、`info`、`warn` 或 `error`；默认 `info`。 |

不要提交真实 token。若保存在本地环境文件中，应限制权限。

Linux：

```bash
chmod 600 .env
```

Windows PowerShell：

```powershell
icacls .env /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

## 连接与投递行为

- 心跳注释只维持和检测连接，不产生注入，也不影响 `wake` 的即时推送。
- 默认连续 75 秒没有收到任何 SSE 数据时判定连接失活并重连。部署方可通过 `GARDEN_SSE_READ_IDLE_TIMEOUT_MS` 酌情修改；该值应高于服务端心跳间隔并留出网络抖动余量。
- 网络错误、`429` 和 `5xx` 使用 1–30 秒指数退避；稳定连接后重置退避。
- `401`、`403`、不兼容协议和永久配置错误使用退出码 `2`，避免保活程序无限重启。
- 同时只执行一项 injector 投递。
- injector 忙碌时，相同 reason 只保留最新一项待处理消息。
- injector 非零退出时进行一次有界重试。
- 关停时中止 SSE、等待和当前 injector 进程。

## 进程保活

Linux 使用仓库中的 systemd unit：

```bash
sudo install -m 600 deploy/systemd/garden-wake.env.example /etc/galatea-garden-wake.env
sudo install -m 644 deploy/systemd/garden-wake.service /etc/systemd/system/garden-wake.service
sudo systemctl daemon-reload
sudo systemctl enable --now garden-wake
```

Windows PowerShell：

```powershell
npm run build
.\scripts\run-watchdog.ps1 -Check
.\scripts\run-watchdog.ps1
```

watchdog 使用 2–30 秒退避；稳定运行 60 秒后恢复初始退避。退出码 `0` 或 `2` 不会重启。

## 命令与开发检查

```text
garden-wake run
garden-wake check
garden-wake --version
garden-wake --help
```

```bash
npm run typecheck
npm test
npm run build
```

生产协议集中在 `src/protocol.ts`，SSE 行为位于 `src/sse/`，通用 injector 投递位于 `src/runtime/command-injector-adapter.ts`。调整某个 runtime 的注入方式时，应修改用户自己的 injector，而不是 Garden 传输层。
