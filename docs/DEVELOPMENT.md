# dsh-better-goal 开发文档

面向维护者、从源码安装的人，以及需要排查兼容问题的使用者。日常安装和用法见 [README](../README.md)。

## 状态与兼容性

- 当前包版本：`0.1.0`。
- DSH 基准：`0.2.1-rc.2`；`package.json` 的 engines 声明为 `>=0.2.1-rc.2 <0.3.0`。
- Node.js：`^22.19.0 || >=24.0.0`。
- 纯 ESM，无构建步骤，没有需要生成的资源文件。
- 版本范围会纳入预发布版；`0.2.1-rc.2` 之后的 RC 可能被接受，但版本范围不等于逐版验证保证。

本仓库的测试和冒烟不包含“当前正在使用的浏览器 GUI 已完成验收”，也没有对 PTC 工具呈现模式或其他自定义提问工具做专项验证。不要把这些未覆盖场景写成已验证。

## 装配入口

`package.json` 声明：

- `main` / `exports["."]`：宿主入口 [src/index.js](../src/index.js)。
- `exports["./client"]`：浏览器入口 [src/client.js](../src/client.js)。
- `dsh.bundle.patch`：顶层装配 [cordis.patch.yml](../cordis.patch.yml)。
- `dsh.client`：Web 客户端及注入的宿主服务。

[cordis.patch.yml](../cordis.patch.yml) 做两件事：

1. 禁用原生 `goal`、`goal-round-driver`、`command-goal`、`tool-goal`、`ui-goal` 行。
2. 插入顶层行 `id: dsh-better-goal`、`name: dsh-better-goal`。

插件不会修改 DSH 安装目录，也不依赖实验性的 plugin records。对旧 Agent 上仍可见的 `get_goal` / `create_goal` / `update_goal`，[src/index.js](../src/index.js) 在 Agent 的 tools 作用域内做 deny 过滤，并在每个 pre-step 重新检查，避免预设换代后残留旧工具。

## 架构

| 文件 | 职责 |
| --- | --- |
| [src/index.js](../src/index.js) | 挂载 goal 服务、设置页、单工具、`/goal` 命令、系统提示和续跑驱动；按 Agent 管理生命周期。 |
| [src/service.js](../src/service.js) | 原生兼容的 goal 域：持久 schema、replay fold、projection、CAS 写操作、process-local activation。 |
| [src/driver.js](../src/driver.js) | 同会话自动续跑：在静默边界排队下一轮，处理暂停、中断、计划模式、子代理和竞态。 |
| [src/tool.js](../src/tool.js) | 模型侧唯一的 `goal` 工具；统一动作执行与参数校验，内部引用由服务/命令层管理。 |
| [src/commands.js](../src/commands.js) | 人类侧 `/goal` 命令解析与输出。 |
| [src/ask-user.js](../src/ask-user.js) | 只在 active + armed goal 下启用的限时提问影子工具。 |
| [src/config.js](../src/config.js) / [src/settings.js](../src/settings.js) | 正式 Config schema、默认值、volatile 热设置和设置页挂载。 |
| [src/client.js](../src/client.js) | 零构建 browser closure：GoalBar 和 Plugins 行配置页。 |
| [scripts/runtime-smoke.mjs](../scripts/runtime-smoke.mjs) | 真实 DSH profile、真实 AgentLoop、脚本化模型适配器的宿主冒烟。 |
| [tests/](../tests) | 单元与组件测试；无浏览器构建依赖。 |

## 数据、兼容与恢复

- 持久格式沿用 DSH 原生 `goal/change` v1 事件；projection 保持 `stateVersion: 6`。没有独立 sidecar 状态，也不使用日志截断式 rewind。
- 写入通过 revision-based CAS 校验；旧 revision 的编辑、暂停、恢复等操作会被拒绝，不会覆盖新状态。
- 会话重开、宿主重启或 fork 时，从会话日志前缀恢复 goal 和 `roundsStarted`；activation 是 process-local 状态，恢复后为 `disarmed`，必须显式 `resume` 才会重新排队自动轮次。`disarm` 不写持久 revision。
- fork 只影响新会话；父会话的 activation 不会被 fork 关闭。
- 每个会话最多一个当前 goal。模型侧 `set` 用于整体替换并开始新目标（轮数归零）；已完成目标也可以开始新目标。
- `clear` 写入 tombstone 并保留历史；旧 goal 事件仍可 replay。
- 原生 goal 行被替换后，已有原生目标仍可读取。新写入保持同一协议，可被相同协议版本的原生实现回放。
- 原生 v1 要求 `maxGoalRounds` 是正安全整数。插件的“无上限”使用 `Number.MAX_SAFE_INTEGER` 兼容哨兵；驱动对该值不额外施加策略上限，UI 显示为“无上限”。它不是数学无限；回退到原生实现后会显示一个极大的有限数。
- 下调有效上限时，服务层的 `edit` 会拒绝低于已执行轮数的上限；如果运行中的 `fixed` 配置低于已用轮数，驱动会以 `round-limit` 阻塞目标，而不是把 `roundsStarted` 写回更小的值。
- 切换装配或回退时，不要让两个 goal 状态服务或两个续跑驱动同时工作。

## 原生 Goal 对比的核验边界

用户 README 的对比以本项目验证基线 DSH `0.2.1-rc.2` 的默认装配为准，核对了该版本的 `dsh-tool-goal`、`dsh-goal-round-driver`、`dsh-goal`、`dsh-tool-ask-user` 发布代码及 standard 预设。公开规则见[原生 Goal 工具说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/tool-goal/README.md)；该链接跟随上游演进，不代替已验证版本。

- 原生并非没有停止路径：模型可 `complete` 或在满足门槛后 `blocked`，用户还可暂停、清除；不能把它描述成绝对无法终止或必然无限运行。
- 原生自主目标轮次不具备 direct-human authority，不能主动 `pause`；`blocked` 默认在 `roundsStarted < 3` 时被拒绝。文档要求同一阻塞持续多个轮次，代码门槛实际比较累计目标轮数，不证明每轮都是同一阻塞。README 因此只说“默认至少经过 3 个目标轮次”。
- 原生模型的 `resume` 需要直接人类请求，且拒绝恢复 durable paused 状态；该状态由用户 Web 或 `/goal resume` 路径恢复。本插件不保留这些人类授权门槛，但保留目标状态与预算校验。
- 原生默认轮数上限是 256，达到有效上限后 driver 会记录 `round-limit` 并停续；可配置的轮数上限不是固定值，也不是提问等待的时间上限。
- 原生 `ask_user_question` 默认是阻塞式 legacy 模式；timed 是同一工具已有的可选模式，默认 120 秒且支持 `-1`。本插件并不独占 pending / late-answer 能力，而是在 active + armed 目标中统一应用用户配置的等待策略。
- 目标持久化、自动续跑、用户暂停、重开或 fork 后 disarm 都是原生已有能力，不应写成本插件相对原生的独有优势。

## 单工具与动作契约

模型侧只注册一个名为 `goal` 的工具，最终动作集合为 `get` / `set` / `fail` / `complete` / `resume`。工具参数不接受 `goal_id` / `revision`；工具内部读取当前目标并生成引用，服务层仍执行 revision-based CAS。返回值保留只读的原生目标视图，模型不需要管理其中的 ID 和 revision。

| 动作 | 语义 |
| --- | --- |
| `get` | 读取当前 goal。 |
| `set` | 全量替换为新目标：新的 objective、`roundsStarted` 归零、立即 arm 并启动。 |
| `resume` | 恢复现有目标，保留 objective 和已用轮数，不重置计数。 |
| `complete` | 标记完成并 disarm。 |
| `fail` | 记录具体阻塞原因并 block、disarm。 |

`set` 是整体替换，不是“改几个字”；只在确实要替换总目标时使用。暂停（`pause`）和清除（`clear`）不在模型侧五个动作中，但仍由 GoalBar、Remote 服务和人类 `/goal` 命令提供。人类 `/goal create` 映射到 `set`；`/goal edit` 仍在原目标上就地编辑（已完成目标会新建）；`/goal pause` 和 `/goal clear` 直接走服务层。

原生协议没有替换事务：覆盖未完成目标通过内部 CAS `clear` 后 `create` 实现，恢复时调整上限可能通过 `edit` 后 `resume` 实现。参数、策略和状态校验在首次写入前完成；底层追加失败或同步重入不具有跨事件回滚保证，不应把这两步描述成原子事务。

README 只写五个动作的用户语义，不复制 JSON、schema 或内部引用；精确契约以本文档和测试为准。动作集合变化时同步 README、本文档和测试，不要提前宣称未实现内容。

人类命令由 [src/commands.js](../src/commands.js) 注册：

| 输入 | 行为 |
| --- | --- |
| `/goal` | 读取当前 goal |
| `/goal <objective>` | 创建或整体替换 goal（映射到 `set`） |
| `/goal set <objective>` | 整体替换为新目标，轮数归零并启动 |
| `/goal create <objective>` | 创建别名，映射到 `set` |
| `/goal edit <objective>` | 在原目标上就地编辑；若当前 goal 已完成，则创建新 goal |
| `/goal pause` / `/goal off` | 暂停并 disarm（服务层） |
| `/goal resume` / `/goal on` | 恢复并 arm |
| `/goal complete` | 标记完成 |
| `/goal fail <reason>` | 记录具体原因并阻塞 |
| `/goal clear` | 清除当前 goal（服务层） |

GoalBar 不新建 goal，只通过正式 `remote.goals` RPC 做编辑、暂停、恢复和清除。它使用 click 时从 live projection 读取的 CAS ref，不在聊天中写入 slash-command 生命周期；完成态不渲染。

## 轮数策略

三个字段都由正式 Config 管理，全部是 volatile：保存后热更新到当前 fiber，不重挂插件。默认值在 [src/config.js](../src/config.js)：

| 字段 | 默认 | 约束 | 用途 |
| --- | --- | --- | --- |
| `roundLimitMode` | `agent` | `agent` / `unlimited` / `fixed` | 选择解释轮数上限的策略。 |
| `roundLimit` | `256` | 正安全整数 | 只在 `fixed` 模式使用。 |
| `questionTimeoutSeconds` | `120` | `-1` 或 `1..2147483` 的整数 | 新 goal 提问的等待秒数。 |

`resolveRoundLimit` 的解析顺序：

- `fixed`：配置的 `roundLimit` 胜出，调用方传入值被忽略。
- `unlimited`：哨兵胜出，调用方传入值被忽略。
- `agent`：显式传入值优先；编辑/恢复时没有传入则沿用当前 goal 的上限；创建时没有传入则使用哨兵。

工具 schema 会在下一个 step 刷新：`agent` 模式暴露可选的 `max_goal_rounds`，`fixed` / `unlimited` 模式不暴露。驱动在每次准入时重新读取 live config，所以热设置只影响之后的新轮次和操作，不重置计数，也不自动恢复已停止的 goal。

## 提问超时

[src/ask-user.js](../src/ask-user.js) 不是新增一个提问工具，而是对宿主已有 `ask_user_question` 做 Agent 作用域的影子定义：

- 仅当 goal 为 `active` 且 activation 为 `armed` 时接管；其他情况完全委托给原工具。
- 复用宿主当前工具的 `questions` schema，不导入 `@deepseek-ai/dsh-tool-ask-user`，也不给“无提问”预设新增工具。
- 每次新等待读取一次 `questionTimeoutSeconds`；正在等待的提问保留原期限。
- 宿主设置覆盖模型传入的等待时间；`-1` 走不带超时的 `userQuestions.ask`。
- 超时返回原生 pending 结果，问题仍可回答；模型侧提示明确说明“pending, not a skipped answer”，不得把超时当授权或默认答案。
- 超时后用户仍可提交答案，迟到答案由原生 `userQuestions` 服务结算。

## 完成与失败

- 自动轮次的 prompt 要求从 objective 和引用规格逐项推导要求，并检查当前文件、命令结果、测试和运行状态；局部进度、记忆或“应该可以”不能作为完成证据。它是行为约束，不是硬编码测试门。
- 遇到明确阻塞时，模型应立即 `fail` 并给出具体原因；没有“必须阻塞三个回合”的门槛。
- `complete` 接受 `active` / `paused` / `blocked`；完成后 disarm，GoalBar 隐藏。
- 用户中断会 disarm，并在安全 idle 边界把 active goal 持久化为 paused；不会把暂停通知当作新提示自动启动。
- Plan mode 或待提交选择存在时，驱动不排下一轮；计划模式退出后可以恢复。
- 普通工具返回失败不等于整个 goal 失败；目标轮次的运行时终止错误会阻塞对应 goal，普通对话轮次的错误仅停续，不把目标误标失败。每次只保留一个候选续跑，在进入 step 前再次校验 revision、竞争输入、取消和落盘状态。

## 双入口与设置只读

这是 README 只保留一句提示、本文档保留完整原理的部分。

Apollo 在 `package.json` 中把 `dsh-better-goal` 声明为运行时依赖，并以 commit 固定版本；它的顶层 patch 自己插入了 `id/name` 都是 `dsh-better-goal` 的行。独立包也插入同一行。

- 两个 bundle 同时被显式选中时，DSH Loader 按行 id 去重，通常只激活一个实例，浏览器模块也只有一个 active source。
- 但 DSH `0.2.1-rc.2` 的插件管理器会把组合行开关标成只读（`unaddressable`），配置编辑器也可能拒绝保存目标设置。
- 这不是两个服务同时运行，也不是通过修改 DSH 核心可以安全绕过的行为；推荐只保留 Apollo 入口，不重复 add。
- [src/client.js](../src/client.js) 同时注册 `dsh-better-goal#dsh-better-goal` 和 `dsh-apollo#dsh-better-goal` 两个 row-config key，让两种装配都能找到同一个设置页，但底层仍是同一份配置和同一个行 id。
- 如果只需要临时开关有效行，可在 profile 覆盖中写 `id: dsh-better-goal`、`disabled: true`；不要写成 `id: goal, disabled: false`，那会启用原生 goal 服务。

## 开发安装

```sh
# 在仓库根目录安装依赖
npm install

# 把当前工作树链接到 profile
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-better-goal
```

链接后要重启 profile；运行时三个设置字段仍然支持保存后热更新。

Apollo 本地开发时，先在其根目录执行 `npm install`。`dsh plugin add link:` 只链接 Apollo 本身，不代装依赖；Apollo 的依赖目前固定到独立仓库的 commit，本地联调可临时改成 `file:../dsh-better-goal`。

## 测试与宿主冒烟

单元测试：

```sh
npm test
```

测试覆盖 Config 默认值与边界、round policy、goal service 的持久 schema/replay/CAS、driver 的续跑与中断、单工具动作、命令、GoalBar、设置页和提问超时影子。

宿主冒烟需要指向已安装的 DSH 包：

```sh
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke

# Apollo 装配路径
GOAL_SMOKE_MODE=apollo DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke

# 热设置 + 迟到回答
GOAL_SMOKE_HOT=1 DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke
GOAL_SMOKE_MODE=apollo GOAL_SMOKE_HOT=1 DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke

# 仅验证双入口不会重复激活；不宣称该模式可以保存设置
GOAL_SMOKE_MODE=both DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke
```

冒烟使用临时 home/profile、真实 DSH AgentLoop 和脚本化模型适配器，不调用付费模型，也不启动替代 GUI。通过条件是进程退出码为 0、输出 `BETTER_GOAL_RUNTIME_SMOKE_PASSED`，以及临时目录 `results.json` 的 `passed` 为 `true`。`apollo` / `both` 模式默认从 `../dsh-apollo` 读取 Apollo 仓库，可用 `APOLLO_PACKAGE_ROOT` 指定其他位置。

实际检查包括：真实 profile 启动、单 `goal` 工具、五动作枚举、无 `goal_id` / `revision` 参数、旧三工具隐藏、`/goal` 命令、创建/替换/暂停/恢复/完成/清除、真实工具 dispatch、native goal RPC、自动轮次、冷恢复 disarmed、fork disarmed、Agent 无需新人类消息即可控制完整生命周期；`GOAL_SMOKE_HOT=1` 还检查热设置持久化和迟到回答。冒烟路径覆盖 `standard`（standalone）以及 `eng` / `eng-noask`（apollo / both）；`apollo` / `both` 模式会检查 `eng-noask` 没有提问工具时不会被插件新增提问能力。

未覆盖：PTC 工具呈现模式、其他自定义提问工具、当前浏览器 GUI 的人工验收。单元测试或冒烟通过都不代表这些场景已验证。

## 卸载、禁用与回退

独立安装：

```sh
dsh plugin --profile <profile> remove dsh-better-goal
```

Apollo 安装：

```sh
dsh plugin --profile <profile> remove dsh-apollo
```

- 禁用或移除独立 bundle **不等于**移除 Apollo 插入的 `dsh-better-goal` 行；只要 Apollo 仍在装配，goal 能力仍然存在。
- 要彻底移除 goal 能力，需要移除 Apollo，或显式禁用该行，然后重启 profile。
- 回退到原生实现时，先移除插件装配，并确认 profile 中没有遗留的 goal 行禁用覆盖，再让原生行恢复；不要在插件仍启用时用 `goal` 行重新启用原生服务。
- 卸载不会清空已有会话日志，也没有独立 sidecar 需要迁移。再次安装后，已有 goal 仍可恢复；恢复后需要显式继续。

## 文档维护约定

- README 面向使用者：只保留用户可感知的状态、设置、命令和限制；CAS、协议版本、projection、row id、Loader 去重、兼容哨兵等内部实现放在本文档。
- README 可写五个动作的用户语义，但不写 JSON、schema 或内部引用；模型接口变化时同步更新 README、本文档和测试。
- 不伪造 CI 通过、npm 发行或版本徽章。README 只使用可直接核对的静态徽章；没有确认 npm 发行前不要加 npm 版本徽章。
- 相对链接必须在仓库内存在；修改 README 或本文档后重新检查链接。
- 测试通过、冒烟通过、当前 GUI 验收是三件事，报告中要区分。

## 许可

GPL-3.0，见 [LICENSE](../LICENSE)。移植的 DeepSeek Harness 代码保留 MIT 声明，见 [third-party/NOTICE](../third-party/NOTICE) 和 [third-party/LICENSE-MIT-dsh](../third-party/LICENSE-MIT-dsh)。
