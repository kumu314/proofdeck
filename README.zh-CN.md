# ProofDeck

**验证优先的编码 agent 舰队任务板与编排器。**

Agent 说 done，ProofDeck 要证据。

![一次"假完成"（验收要 count≥3，产物只有 1）被真实验证引擎当场拒绝](docs/assets/demo.gif)

> 本仓库 `board/` 目录内含 [octopus-blackboard](https://github.com/octoryn/octopus-blackboard)（Apache-2.0）的修改版发行，见 [NOTICE](./NOTICE)。English: [README.md](./README.md)。

## 为什么

只跑一个编码 agent（Claude Code、Codex CLI、Gemini CLI……）时，你会 review 它的每一步，review 是有效的。但你一旦**并行跑好几个** agent，review 就成了瓶颈，而两种失败模式会叠加：

- **虚假确认（false affirmative）**。agent 加个 fallback 让代码"能跑"，测试也过了，缺陷照样上线。业界给这类问题起了名字——*reward hacking*，它现在是活跃的研究课题（ImpossibleBench 2025；Anthropic 关于 reward hacking 引发的突现失调研究 2026）。
- **静默死亡**。agent 卡住、rc=0 但什么都没干、或把预算烧在死循环里——直到截止日期前都没人发现。

ProofDeck 的答案是：**把验收标准做成每张任务的一等公民**，并拒绝没有证据的"done"：

1. 每张任务携带机器可校验的验收标准；
2. 完成时，fail-closed 验证引擎执行验收（文件存在、次数下限、JSON 路径断言、引用存在——五类检查）；
3. 机器检查不够时，LLM judge 依据验收标准复核轨迹，它的判定连同"谁认领、谁验证、何时"一起写进**追加式 sha256 哈希链**；
4. 验证失败的任务按退避自动重试、转入人工复核、或按能力路由给另一个 agent——**绝不静默标记完成**。

在那道门禁周围，ProofDeck 负责整支舰队：SQLite 共享黑板（带 MCP 面）、带 aging 的优先级车道、自动重试与供应熔断、SLA 到期、摘要邮件、全量事件回放（时间旅行）、以及 OpenTelemetry 风格 span。

## 状态

`v0.1.0-preview`。在真实日常使用中淬炼（个人多 agent 舰队，数百张任务）——**Windows 为一等公民**。POSIX 层标记为 **beta**：CI 在 ubuntu 上跑完整测试矩阵（13/13 绿），但真实世界的 macOS/Linux 使用里程还薄——遇到坑请报 issue。

## 快速开始

```bash
npx proofdeck init        # 脚手架：daemon.config.json + .proofdeck/ + control.token
# 编辑 daemon.config.json —— 把 agents.codex.script 指向你有的 CLI
npx proofdeck daemon      # 起守护（黑板 + 控制面 + 调度器）
npx proofdeck status      # 看板块 head、任务统计、验收覆盖
```

从 git 检出运行：

```bash
git clone https://github.com/kumu314/proofdeck && cd proofdeck && npm install
node bin/proofdeck.js init && node bin/proofdeck.js daemon
```

任何说 MCP 的 agent 都能读写黑板（任务、注记、消息、验证事件）。

## 架构

```
                       ┌───────────────────────────────────────────┐
                       │                ProofDeck                  │
  人 ──定义任务────────▶│  守护：认领 → 跑面 → 验证门禁             │
  agents ◀──MCP────────│          │                                │
  (CLI 面)  ──运行─────▶│          ├─ V1 检查（fail-closed）        │
                       │          ├─ V1.5 LLM judge               │
                       │          ├─ 重试 / 熔断 / 能力路由       │
                       │          ▼                                │
                       │  黑板：SQLite WAL + 追加式 sha256 哈希链  │
                       │  （任务/注记/验证事件/消息——防篡改可取证）│
                       └───────────────────────────────────────────┘
```

- **board/** —— octopus-blackboard 的修改版发行：共享任务板，追加式哈希链、MCP 面、验收/验证 schema。
- **lib/** —— 验证引擎（`verify.js`）、LLM judge（`judge.js`）、带优先级 aging 与重试策略的调度核（`schedule.js`）、能力路由（`caps.js`）、事件回放（`replay.js`）、span、摘要、租约、供应熔断。
- **适配器** —— 每个 agent 面就是一个小模块（`lib/adapters/`）；通用 CLI 适配器（`codex.js`）是参考实现。题面经 stdin 喂入、绝不放 argv——长中文文本过某些 shell 会被搅坏（这是生产线换来的跨平台教训）。

## 设计原则

- **Fail closed。** 没有验收标准的任务不会被静默接受——每次派发都被标注提示，直到补上。
- **证据而非感觉。** 验证结果是哈希链里的事件，不是聊天记录。
- **黑板即真相。** Agent 来来去去；追加式时间线记得一切。
- **无聊的存储。** 每次部署一个 SQLite 文件。原生 `node:sqlite`，`better-sqlite3` 作回退（`OCTOBOARD_BACKEND=better-sqlite3`）。

## 测试

13 套端到端套件（验证、防刷分、judge、调度、韧性、回放、SLA/摘要……），打在真实黑板上：

```bash
node scripts/run-e2e.mjs                 # 全量（node:sqlite 原生后端）
OCTOBOARD_BACKEND=better-sqlite3 node scripts/run-e2e.mjs   # 回退后端
```

CI 在 Windows/ubuntu × 双后端四格矩阵上跑全套；native 格用 `--omit=optional` 安装——在干净机器上实证"零原生依赖"。

## 许可

Apache-2.0。见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)——本项目包含 [octopus-blackboard](https://github.com/octoryn/octopus-blackboard)（Ran Tao / octoryn）的修改版发行。
