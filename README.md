# ChatGPT Desktop Work / Codex → Pi Agent + Gemini → OpenAI 自动验收

一个 **本地优先 MVP**：你在桌面 ChatGPT Work/Codex 中批准计划，让它将 JSON 写到你授权的本地文件夹并运行提交脚本；然后常驻 Node 进程独立完成 **Pi 研发 → 测试 → OpenAI 审核 → 返工（最多 3 次）**。**不是**让普通 ChatGPT 对话自己作为后台回调目标。

## 0. 安全说明

- 只用于可信源代码的本地开发环境；Pi 有 `bash` 执行能力。**Git worktree 不是安全沙箱**：不能阻止对其他本地文件的访问，也不能阻止联网。使用单独 OS 用户/容器/虚拟机运行，不要挂载云凭据、SSH key、生产密钥；最严格隔离建议专用容器/VM + 独立低权限账户。
- 服务仅绑定 127.0.0.1，使用长随机 token 校验。不要把端口直接暴露公网，不要把 `.env` 交给 ChatGPT 或提交到 Git。
- `TEST_COMMAND` 是操作者预先配置的可信 shell 命令，不能通过任务 API 修改。测试通过仅意味着测试命令退出码为零；审查模型可能漏检，不能替代人工安全审查和实际 E2E。
- 一次只运行一个任务。不会自动合并、推送、部署或删除 worktree。一次批准一个 task，不要将自动合并生产代码交给本项目。
- 开发环境不要直接使用包含未提交重要修改的项目；每个任务从 `HEAD` 创建新分支/worktree，不包括尚未提交的改动。
- 对 `OPENAI_API_KEY` 和 Pi/Gemini API 而言，使用环境变量/原生认证，但请注意 Pi 子进程会继承服务进程环境。**本版本无法在同一 OS 用户下对 Pi 隔离 OpenAI 密钥**，正式使用应拆分审查服务与 Pi Worker，或通过 OS/容器边界和分别注入密钥避免暴露。敏感代码 diff 会发送到 OpenAI API。不要提交不允许发送到该服务的代码。

## 1. 前置条件

Node.js 20+，Git，Pi CLI，能正常使用的 Gemini 模型账号，以及 OpenAI API key（ChatGPT 订阅不等于 API 额度）。

检查：

```sh
node --version
pi --help
pi --list-models
```

Pi CLI 本项目通过 `pi --mode json --no-session --provider google [--model ...] "prompt"` 启动：每轮独立进程，不需要人手监听 RPC。Pi 版本不同时，请先核对当前 `pi --help`。

## 2. 首次配置

```sh
npm install
cp .env.example .env
```

修改 `.env` 至少：

```dotenv
API_TOKEN=请用openssl-rand-hex-32生成
PROJECT_ROOT=/绝对路径/到你的git仓库
OPENAI_API_KEY=你的API密钥
OPENAI_MODEL=你有权限调用且支持结构化输出的模型
PI_PROVIDER=google
PI_MODEL=
TEST_COMMAND=npm test && npm run build
```

生成 token: `openssl rand -hex 32`。`.env` 第一行不能有空格；Windows 路径请用正常绝对路径。

如原仓库没有 `npm test`，调整测试命令。失败视为返工，不会绕过。

```sh
npm run build
npm run start
```

另开终端：

```sh
curl http://127.0.0.1:3210/health
```

## 3. 提交一个批准后的计划

把 `plan.example.json` 复制成 `approved-plan.json`，确保计划只覆盖你想让 Pi 更改的内容，**用户确认后**执行：

```sh
node scripts/submit.mjs approved-plan.json
# => {"id":"...","status":"queued"}
node scripts/status.mjs
node scripts/status.mjs <task-id>
```

项目工作区 `data/worktrees/<task-id>/`，完整状态 `data/jobs/<task-id>.json`；运行日志 `data/jobs/<task-id>-pi-<attempt>.log` 和 `-test-<attempt>.log`。成功后的代码还停留在任务分支 worktree，需你自己审核合并。

## 4. 接入 ChatGPT 桌面 Work / Codex

1. 在 ChatGPT 桌面 App 选择 **Work**（或 **Codex**），使用本地文件/终端能力打开这个调度器文件夹；授予 **仅必要目录** 权限。是否能调用本地终端，取决于你当前的 Work/Codex 能力、授权和系统设置。
2. 在对话中让它产出符合 `plan.example.json` 结构的开发计划，先请你审核。
3. **你明确回复批准后**，让它把计划写入这个目录的 `approved-plan.json`，并执行 `node scripts/submit.mjs approved-plan.json`。如果 Work 无法调用本地终端，改用 Codex Local，或者手工执行提交命令；不能假设所有桌面安装版本都支持无确认运行命令。
4. 任务提交后，**可以关闭 ChatGPT**，但机器必须保持开机、Node 服务进程必须运行、Pi/Gemini 与 OpenAI API 可访问。
5. 在 ChatGPT 中可随时让它执行 `node scripts/status.mjs <id>` 读取当前状态/报告；服务**不会主动向原 ChatGPT 会话发送消息**。

### 可以复制给桌面 Work / Codex 的指令

> 请为以下需求生成 `plan.json`（只有 title、requirements、acceptance 三项），先向我展示并等待我明确批准。只有在我明确回复“批准执行”后，你才可以将该 JSON 写入当前 `devrelay/approved-plan.json` 并运行 `node scripts/submit.mjs approved-plan.json`；把返回的 task id 告诉我。之后不要自己继续运行 Pi 或审查代码：本地后台服务会自动处理开发、测试、验收和返工。我随后可以让你运行 `node scripts/status.mjs <task-id>` 查看结果。绝不可读取或传出 `.env`、API Key。

## 5. 后台运行

macOS/Linux：先 `npm run build`，再执行：

```sh
./scripts/start-background.sh
./scripts/stop-background.sh
```

这是轻量启动脚本，**不是系统服务管理器**；电脑重启后不会自行恢复。正式长期运行请使用 macOS launchd、Linux systemd 或 Windows Task Scheduler/NSSM，并配置自动重启与日志。示例见 `deploy/`。

## 6. HTTP API

- `GET /health` 无认证（仅 localhost）
- `POST /tasks` 需要 `Authorization: Bearer <API_TOKEN>`，body `{ "approved":true, "plan": { "title":"...", "requirements":["..."], "acceptance":["..."] } }`
- `GET /tasks` 需要认证，列出任务
- `GET /tasks/:id` 需要认证，查看详情和验收

```sh
curl -H 'Authorization: Bearer YOUR_TOKEN' http://127.0.0.1:3210/tasks
```

`approved:true` 只是辅助防误操作的字段；**安全批准**来自你授权给桌面客户端提交动作的权限以及服务端 API token，不代表有人类签名审批。请不要向不受信任的桌面 Agent 授予这一 token。

## 7. 恢复、取消和限制

- 任务状态持久化在本地 JSON；进程重启后 queued 任务会继续，而开发中的任务标记 failed，以避免自动重复执行带副作用的命令。
- MVP 未提供取消运行中任务的 API。需要停止时停止后台进程，并审查任务 worktree；后续可以添加取消、去重/幂等、原子日志、系统通知、完善进程树杀掉机制及受限容器 Worker。
- 如果 diff 超过 120k 字符，任务会失败而不是让模型在信息不足情况下放行。需要拆分为更小的任务。
- 只有单轮测试通过且独立 AI 审查 `passed: true` 才标为 passed。AI 审核结果为建议性验收，不代表形式化证明。

## 8. 架构

```text
ChatGPT Desktop Work / Codex
    │ 你批准后写 plan JSON + submit.mjs
    ▼
127.0.0.1:3210 API (Bearer token)
    ▼
持久化任务队列 → 独立 Git worktree
    ▼
Pi CLI + Gemini
    ▼
可信 TEST_COMMAND ─失败→ Pi 返工
    ▼
OpenAI Responses API (结构化 JSON 验收)
    ├─ rejected → Pi 返工 (最多 MAX_RETRIES)
    └─ approved → passed + 任务报告
```

详细官方文档：Pi: https://github.com/badlogic/pi-mono ，OpenAI Responses API: https://developers.openai.com/api/docs/guides/structured-outputs ，ChatGPT Desktop Work/Codex: https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex

## CLI: devrelay

The project now includes a single CLI entrypoint that talks to the existing local task API.

```bash
npm install
npm run build
npm link
devrelay server start
devrelay run plan.example.json
devrelay status
devrelay wait <task-id>
devrelay report <task-id>
devrelay logs <task-id> --attempt 1 --type pi
devrelay server stop
```

`devrelay run` submits a preapproved plan; it does not independently obtain consent. Invoke it only after reviewing and approving the JSON plan. The server remains responsible for Pi execution and OpenAI review. The CLI has no active-task cancellation: stopping the daemon interrupts jobs and they are marked failed at restart. Do not expose its loopback API publicly. The log command reads local logs and must run on the same machine as the service.

## Multi-agent CLI v1.1

The CLI selects a **coding agent**, not a GUI code editor. Supported preconfigured launchers: `pi`, `claude`, `cursor`. Also contains preliminary unverified command profiles for `codex`, `gemini`, `opencode`. `zcode`, `windsurf`, `custom` require a user-provided executable and an argument array because their headless command interfaces have not been verified here.

```bash
npm install && npm run build && npm link
devrelay setup                    # interactive initial selection
devrelay agents list
devrelay agents current
devrelay agents use claude        # change default for future submissions
devrelay run plan.json --agent cursor # one-task override
devrelay agents configure zcode  # requires your real CLI command
```

Configure agents with JSON argument **arrays**, e.g. `["run","{prompt}"]`; no shell interpolation is performed. These are external programs with arbitrary filesystem/shell capability: use isolated accounts or containers and keep project credentials outside the worktree. `cursor -p --force` specifically authorizes modifications in noninteractive mode. Claude headless must have permissions granted by its normal configuration; this package does not automatically add `--dangerously-skip-permissions`. The model subscription/login for each CLI must be set up separately.

Config is stored at `~/.config/devrelay/config.json` (or `DEVRELAY_CONFIG`). On task submission the agent key is persisted with the job; switching the default does not change already queued/running tasks. The daemon rereads the configuration each time it launches an agent.

Run `devrelay setup` after installation, or `devrelay agents configure ...` to change custom launch commands. Agent stderr/stdout logs keep the existing `-pi-N.log` filenames for backward compatibility.


### Windsurf adapter (custom bridge)

Choose `windsurf` from `devrelay setup`, or run `devrelay agents configure windsurf` and supply an executable plus a JSON argument array containing `{prompt}`. Windsurf is an IDE; its editor launcher is **not** a confirmed headless Cascade coding-agent CLI. Do not configure the ordinary `windsurf` editor-opening command as if it performs autonomous development.

A community project named `wsc` bridges to Cascade via GUI/extension hooks on macOS, but requires Windsurf to remain running and is not equivalent to an official, reliable headless CLI. If you intentionally use it, evaluate its installation, permissions, completion detection, and security first. The orchestrator expects a command that exits only after work has finished; an editor-launch command does not meet that contract.

Switch after configuration: `devrelay agents use windsurf`; for a single task: `devrelay run plan.json --agent windsurf`.

## Rebranding from pi-bridge to devrelay

The command is now `devrelay` (all former `pi-bridge` commands use the same subcommands). `devrelay` keeps `pi` as an individual agent identifier: `devrelay agents use pi`.

If `~/.config/devrelay/config.json` does not exist, the CLI copies an existing `~/.config/pi-bridge/config.json` on first read. The old file stays intact. If you previously used `PI_BRIDGE_CONFIG`, set `DEVRELAY_CONFIG` to the preferred new config path; `PI_BRIDGE_CONFIG` remains only a legacy migration source. Existing task data under `DATA_DIR` is not automatically moved; retain the same data directory across upgrades.

When upgrading a previously linked package, run `npm unlink -g pi-bridge-multi-agent` if necessary and `npm link` in this project. Restart the daemon so that it reads updated executable code.

## v1.3 Reliability & safety additions (2026-10)

The `devrelay` command remains compatible with existing agent profiles (`pi`, `claude`, `cursor`, `codex`, `gemini`, `opencode`, `zcode`, `windsurf`, `custom`).

### Agent diagnostics

```bash
devrelay doctor
# or just one:
devrelay doctor claude
```

The diagnostic checks that the executable exists and a non-interactive `--version` invocation works. For Claude Code and Codex it also attempts a read-only login-status query. Other providers do not have a reliable generic authentication test; their login state is **unverified** until an authenticated dry-run is performed. No credential is printed. Follow the provider's own CLI authentication flow if the diagnostic is inconclusive.

### Cancellation

```bash
devrelay cancel TASK_UUID
```

The API is `POST /tasks/:uuid/cancel` with the same Bearer token as other authenticated endpoints. Queued tasks stop immediately; running tasks are sent an abort signal and their process group is terminated (SIGTERM, then SIGKILL on POSIX systems). This cannot undo commands the agent has already executed or external actions already taken.

### Crash recovery

Active tasks are persisted to JSON. After service restart, interrupted `developing`, `testing` and `reviewing` states are queued again. The original Git worktree is retained, the task restarts its attempt counter and the reviewer reruns against the current state. This is **at-least-once**, not exactly-once execution. A machine crash can leave child processes running on some OSes, so deploy under a process supervisor or container that terminates the whole process group. **Do not run unsafe non-idempotent commands.** If interrupted tasks might have made irreversible external changes, investigate before restarting the service.

### Restricted execution

- HTTP listening is restricted to loopback and requires a long API token.
- Only an operator-controlled `PROJECT_ROOT` is used. Every job gets a separate Git worktree.
- Agent subprocesses no longer receive the full server environment. The default allowlist contains basic CLI variables; explicitly add vendor auth variable *names* using `AGENT_ENV_ALLOWLIST=ANTHROPIC_API_KEY,GOOGLE_API_KEY` **only if required**. The OpenAI review key is not inherited by default.
- The test command is **operator configured only** in `.env`, not accepted from task payloads.
- Agent stdout/stderr logs are limited in size and common credential patterns redacted.
- No automatic Git push, merge or production deploy is performed.

**Threat-model caveat:** A Git worktree is *not* an OS security sandbox. An agent running with your user permissions may access files outside the worktree, home-directory credentials, network resources and dangerous binaries. For untrusted requirements or fully unattended runs, deploy the worker inside a container/VM with non-root user, read-only mounts for everything except its dedicated checkout, restricted network access, resource limits, and **no** mounted cloud credentials. CLI prompts are not a security boundary. Inspect each agent's own auto-approval/permission flags before enabling unattended use.

### Offline integration tests

```bash
npm install
npm run build
npm test
```

The included test suite uses an actual temporary Git repository, a mock CLI development Agent, and a local mock OpenAI Responses endpoint. It checks success, AI rejection + automatic retry, active cancellation, and restart recovery. These tests do **not** prove real Claude/Pi/Cursor/Gemini authentication, vendor CLI flags, browser E2E correctness, or production sandbox safety. Run with a disposable Git repository and real vendor accounts before accepting the system for unattended use.

### Deployment

For macOS/Linux, run `devrelay server start` and configure the operating system to restart the service at boot (see `deploy/`). Store `.env` outside project checkouts, chmod it `600`, and keep `DATA_DIR` outside `PROJECT_ROOT`. On Windows, use Task Scheduler or an equivalent supervisor; process-tree termination differs from POSIX. Do not expose port 3210 to a public network.
