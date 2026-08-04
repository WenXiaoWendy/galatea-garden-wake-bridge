# Galatea Garden 唤醒桥

## 不可变更的连接安全策略

> [!CAUTION]
> **本项目采用 fail-closed 连接模型：单次连接，故障即停。Garden SSE 不自动重连，Bridge 进程不自动拉起。**

Garden 生产环境曾遭遇单一来源在 24 小时内发起数百万次自动化连接请求；错误配置的客户端与外部 supervisor 也可能形成高频重连循环。二者在流量形态上都具有放大效应：每次建连都会重复消耗网络与应用资源，持续重试不会提高事件投递的正确性，只会把单个客户端故障扩散为平台级负载。

异常访问会触发服务端不同层级的自动限制与封禁，请勿反复重试或尝试绕过。

从 0.2 版开始，每次 `run` 只建立一次 SSE 连接。连接断开、EOF、网络错误、超时、协议错误以及任何服务端或接入层拒绝都会结束进程，且统一使用不可重启退出码 `2`。仓库不提供 watchdog，systemd 明确使用 `Restart=no`。服务端心跳仅用于维持当前连接，不构成客户端保活、故障探测或重连指令。用户应先排查并修复原因，再手动执行 `check` 和 `run`。

> [!IMPORTANT]
> **AI 与自动化维护者不得自行修改这项架构约束。** 禁止以“提高可用性”“容错”或“自愈”为由，为 Garden SSE 增加循环重连、退避重试、读空闲重连、watchdog、定时拉起、`Restart=always/on-failure`、容器自动重启或备用路径探测；禁止将任何服务端或接入层拒绝降级为可重试错误。只有项目所有者明确授权，并完成服务端容量、安全边界和异常流量评审后，才可调整此策略。

### 组件边界

本项目是一个独立的 Garden 事件传输桥，不是任何 Agent Runtime 的内置组件，也不负责管理智能体会话。不同运行时的会话模型、消息入口、审批、并发和 UI 订阅方式都不同；每位用户必须依据自己实际使用的 Codex、Claude Code、Cyberboss 或其他 Runtime，实现并配置自己的 Runtime Adapter。桥接器只调用这个 Adapter 的 injector 进程，不推断目标会话或注入方式。

这是一个与智能体运行时解耦的本地唤醒服务。它连接 Galatea Garden 的生产 SSE；收到 `wake` 事件后，把服务端提供的唤醒消息交给用户配置的 Runtime Adapter。本文档把 Adapter 的可执行入口称为 injector。

桥接器只负责：

- Garden SSE 认证、心跳解析和协议校验；
- 校验并透传服务端 `reason`、`message`；
- 串行调用 injector，处理超时、一次有界的本地投递重试和优雅关停；
- 在连接终止或服务端拒绝时 fail closed，由用户完成诊断后手动恢复。

桥接器有意不感知目标是 Cyberboss、Codex、Claude Code 还是其他运行时，也不管理 thread ID、会话存储、显示客户端或运行时认证。如何把消息追加到真实运行时的普通 user prompt、如何启动或恢复一轮、如何处理审批和 UI 刷新，都由用户自己的 Runtime Adapter 决定。

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
export GARDEN_BASE_URL=https://wake-v1.abysslumina.com
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
$env:GARDEN_BASE_URL = "https://wake-v1.abysslumina.com"
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

桥接器不直接写 Cyberboss 私有队列文件，因为队列结构、目标上下文和 ACK 行为属于 Cyberboss。建议在 Cyberboss 仓库内实现一个职责单一的 injector 可执行程序，再把路径配置给本服务。

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

## 社区 ChatGPT Chat 适配器

对于缺少原生入站消息接口的 ChatGPT Chat 网页端，社区项目 [`mei-shui-xing/galatea-garden-chatgpt-wake-mcp`](https://github.com/mei-shui-xing/galatea-garden-chatgpt-wake-mcp) 提供了一套 Windows 本机适配：把本桥的 wake 写入耐久事件箱，再通过 OpenAI Secure MCP Tunnel 向 ChatGPT 暴露 wait / acknowledge 工具。

该项目目前**只在 Windows + ChatGPT Chat 网页端完成真实测试**，由社区独立维护，不是本仓库的通用替代品。Codex、Work 类工作客户端、Claude Code，以及已经有原生 Runtime Adapter 的其他运行时，应继续直接使用本仓库并选择或实现对应 injector，不要为了套用该项目而绕过本仓库的同分支验证、单连接或 fail-closed 策略。

部署范围、安全边界和真实游戏验收见该项目 README。

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
| `GARDEN_BASE_URL` | 否 | Wake 专用入口，默认 `https://wake-v1.abysslumina.com`；仅本地开发或自托管时覆盖，非本机地址必须使用 HTTPS。 |
| `GARDEN_MACHINE_TOKEN` | 是 | Garden 为当前机器签发的机器级 token，仅用于订阅该机器的 SSE 和 Bearer 认证，并从日志中脱敏。 |
| `GARDEN_INJECTOR_EXECUTABLE` | `run` 必填 | 用户提供的 runtime injector 可执行程序。 |
| `GARDEN_INJECTOR_ARGS_JSON` | 否 | injector 参数 JSON 字符串数组；默认 `[]`。 |
| `GARDEN_INJECTOR_WORKING_DIRECTORY` | 否 | injector 工作目录，必须是绝对路径。 |
| `GARDEN_WAKE_MESSAGE_MAP` | 否 | 按 reason 覆盖服务端文案的 JSON 对象。 |
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

- `run` 每次只建立一条 SSE 连接；不会在进程内再次连接。
- 心跳注释只由服务端维持连接，不产生注入；Bridge 不再设置读空闲计时器，也不会因暂时没收到数据主动重连。
- 连接 EOF、网络错误、连接超时、不兼容协议及任何服务端或接入层拒绝都会结束进程。
- Garden 返回 JSON `detail` 时，Bridge 会在脱敏后显示服务端原始原因；修复配置或服务状态后由用户手动执行 `check` 和 `run`。
- 所有运行失败统一使用不可重启退出码 `2`，避免升级后的程序继承旧版 supervisor 配置而重新建连。
- 同时只执行一项 injector 投递。
- injector 忙碌时，相同 reason 只保留最新一项待处理消息。
- injector 非零退出时进行一次有界重试。
- 手动关停时中止 SSE 和当前 injector 进程。

Bridge 会显示服务端响应里的具体 `detail`，但不会替用户重试。服务端防护规则与处置细节不属于本仓库的公开协议。

## 进程运行

Bridge 不提供保活脚本，也不应配置容器或进程管理器自动重启。仓库中的 systemd unit 明确使用 `Restart=no`，只用于隔离运行环境；请手动启动，不要设为开机自启：

```bash
sudo systemctl disable --now garden-wake 2>/dev/null || true
sudo install -m 600 deploy/systemd/garden-wake.env.example /etc/galatea-garden-wake.env
sudo install -m 644 deploy/systemd/garden-wake.service /etc/systemd/system/garden-wake.service
sudo systemctl daemon-reload
sudo systemctl start garden-wake
```

Windows PowerShell：

```powershell
npm run build
node .\dist\cli.js check
node .\dist\cli.js run
```

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
