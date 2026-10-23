# dsh-better-goal

独立的 DSH Goal 插件，接管原生 goal 状态服务、自动续跑、工具、命令和 GoalBar。目标与 TODO 分离：一个 goal 保存总目标，步骤继续用 DSH 的 `todo_write`。

实现参考 pi-atlas 的目标控制与续跑方式，以及 Codex 的目标、计划分离和完成审计。状态日志保持 DSH `goal/change` v1 协议兼容。无构建步骤；最低基准为 DSH `0.2.1-rc.2`、Node.js `^22.19.0 || >=24.0.0`。版本范围声明不代表后续 RC 均已验证。

## 安装

```sh
# PR/开发阶段固定到本次交付的提交；<commit> 替换为真实提交 SHA
dsh plugin --profile <profile> add github:Menghuan1918/dsh-better-goal#<commit>

# 本地开发：先安装仓库依赖，再链接
npm install
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-better-goal
```

修改宿主插件或新增 bundle 后，需要重启对应 profile 的 DSH。设置中的三个运行时字段保存后不需要重启。仅刷新网页不能替换宿主实现。

Apollo 会把它作为依赖装配，通常只安装 Apollo 就够了。需要脱离 Apollo 使用时，单独安装本插件。两个入口共享同一个顶层 `dsh-better-goal` 行；不需要在同一 profile 再次显式启用两个 bundle，宿主对此存在下文说明的设置管理限制。Apollo 以 `link:` 方式开发时，也必须先在 Apollo 仓库安装依赖。

## 工具与命令

模型只看到一个 `goal` 工具，动作包括：

| 动作 | 行为 |
| --- | --- |
| `get` | 读取当前目标、ID、revision 和运行状态 |
| `create` | 创建并启动目标，参数 `objective` |
| `edit` | 修改目标或轮数策略，保留已有执行计数 |
| `pause` | 暂停并停止自动续跑 |
| `resume` | 显式恢复目标，包括被暂停的目标 |
| `complete` | 目标已完成，停止续跑 |
| `fail` | 说明具体失败/阻塞原因，立即停止续跑 |
| `clear` | 清空目标，保留日志历史 |

除 `get/create` 外，操作携带当前 `goal_id`、`revision`，防止旧结果覆盖新状态。`fail` 还需非空 `reason`。Agent 完整控制生命周期，没有“必须人类重新发言”或“只有 UI 才能恢复”的额外限制。基本状态机校验仍然有效，例如已完成目标需要创建新目标；暂停目标应先恢复再报告失败。

```json
{"action":"create","objective":"完成并验证整个需求"}
{"action":"get"}
{"action":"pause","goal_id":"<id>","revision":1}
{"action":"resume","goal_id":"<id>","revision":2}
```

人类命令：`/goal <目标>`、`/goal edit <目标>`、`/goal pause`、`/goal resume`、`/goal complete`、`/goal fail <原因>`、`/goal clear`。`/goal off` / `/goal on` 是暂停/恢复别名；`/goal` 无参数显示当前状态。

GoalBar 使用原生 Goal RPC，带 ID/revision 并发保护，不向聊天写入内部 JSON 命令。它显示执行、暂停、失败及等待显式恢复的状态，并提供编辑、暂停、继续和清空操作。

## 运行时设置

独立安装时打开 **Plugins → dsh-better-goal → dsh-better-goal 行**；由 Apollo 嵌入时打开 **Plugins → dsh-apollo → dsh-better-goal 行**。两者操作同一份配置。配置由 DSH 正式 Config 持久化到当前 profile，不另建设置数据库。

| 设置 | 默认 | 行为 |
| --- | --- | --- |
| `roundLimitMode` | `agent` | `agent` / `unlimited` / `fixed` |
| `roundLimit` | `256` | 仅 `fixed` 使用的正整数上限 |
| `questionTimeoutSeconds` | `120` | 新提问等待秒数；`-1` 表示永不超时 |

- **Agent 决定**：工具提供可选 `max_goal_rounds`。创建时省略表示不施加策略性硬上限；编辑/恢复时省略保留已有上限。
- **无上限**：工具不提供轮数参数，设置优先。
- **固定数字**：工具也不提供该参数，统一使用设置值，陈旧调用不能覆盖它。

下一 step 刷新工具 schema；下一次操作或续跑调度读取新策略，不重置轮数、不自动恢复已停止的目标。降低上限到已执行轮数以下会停续，不能把历史计数写成非法快照。若要再次恢复，需要先提高或取消上限。

**无上限的兼容表示**：原生 v1 协议强制保存正安全整数，本插件使用已确认的 `Number.MAX_SAFE_INTEGER` 哨兵。自身驱动对该值不另施加策略性轮数限制，界面显示“无上限”；它不是数学无限，回退到原生实现后会显示一个极大的有限数。

提问超时仅在 goal 处于 active + armed 时接管本来已存在的 `ask_user_question`，不向无提问预设添加工具。设置覆盖该模式下模型传入的等待时间。热改只影响新发起的提问，正在等待的问题保留原期限。

超时返回原生 pending 结果，问题仍可在之后回答。超时不伪造答案、不等于用户批准；Agent 可以继续独立工作，真正被输入阻塞时应报告失败并等待恢复。

## 恢复、分叉与停止

- 重新打开、恢复、fork 会话时，恢复目标与计数，但续跑保持 disarmed。UI 点击继续或 Agent 显式调用 `resume` 才会启动。
- fork 按 DSH 原生日志前缀恢复目标，不引入独立 sidecar 状态或日志截断式 rewind。
- 用户中断优先：停止续跑，并在安全的回合边界持久化暂停；不会把暂停通知当成新提示自动启动。
- Plan mode 及其待提交的选择不自动续跑。
- 每次只保留一个候选续跑，实际进入 step 前再次检查当前 revision、竞争输入、取消与落盘状态。
- 真正的运行时终止错误会停续；普通工具返回失败不自动等于整个目标失败。
- 完成前逐项检查当前文件、测试、命令结果和运行状态，不能用局部进度或旧记忆代替完成证据；不强制等待三个阻塞轮次。

## 升级、禁用与回退

插件通过正式 bundle patch 禁用原生 `goal`、`goal-round-driver`、`command-goal`、`tool-goal`、`ui-goal` 宿主行；对各 Agent 的旧三工具做 scoped 过滤，并提供统一工具与命令。不会修改 DSH 安装目录。

事件保持原生 schema 和 projection `stateVersion: 6`，可读取原有目标；新写入也可由相同协议版本的原生实现回放。没有使用禁止第三方调用的实验性 plugin records。

卸载独立包时使用 `dsh plugin --profile <profile> remove dsh-better-goal`。如果 Apollo 仍装配该行，禁用独立 bundle 并不会移除 Apollo 的行；回退需要同时移除相应装配和原生行的禁用覆盖，再重启 profile。不要让两个状态服务或续跑驱动同时工作。

DSH `0.2.1-rc.2` 在同时显式选择两个 bundle 时，Loader 仍只激活一个实例，但管理器会把组合行开关标成只读（`unaddressable`），配置编辑器也可能拒绝保存目标设置。此时取消独立 better-goal bundle 的显式选择，由 Apollo 保留其依赖和装配；这不删除子插件能力。该宿主限制不通过修改 DSH 核心绕过。若只需开关有效行，可在 profile 的覆盖层最后添加：

```yaml
- id: dsh-better-goal
  disabled: true # false 重新启用
```

不要通过 `id: goal, disabled: false` 开启它，那会启用原生服务。

## 开发与验证

从源码仓库运行：

```sh
npm install
npm test

DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke
GOAL_SMOKE_MODE=apollo DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke
# 两种正常装配路径：验证真实热设置与迟到回答
GOAL_SMOKE_HOT=1 DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke
GOAL_SMOKE_MODE=apollo GOAL_SMOKE_HOT=1 DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke
# 兼容性检查仅验证双入口不重复激活，不宣称该模式可保存设置
GOAL_SMOKE_MODE=both DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run smoke
```

宿主冒烟使用独立临时 home/profile、真实 DSH AgentLoop 与脚本化模型适配器，不调用付费模型，也不启动替代 GUI。通过条件是进程退出码 0、`BETTER_GOAL_RUNTIME_SMOKE_PASSED`，以及输出临时目录的 `results.json` 中 `passed: true`。实际验证覆盖 standard、eng、eng-noask；PTC 工具呈现模式和其它自定义提问工具未作专项验证。覆盖的实际检查列在该文件中；单元测试与宿主冒烟不等于已经在当前浏览器完成验收。

主要入口：状态服务 `src/service.js`，续跑 `src/driver.js`，工具 `src/tool.js`，命令 `src/commands.js`，提问适配 `src/ask-user.js`，配置与界面 `src/config.js` / `src/client.js`。

## 许可

GPL-3.0。移植的 DeepSeek Harness 代码保留 MIT 声明，见 `third-party/NOTICE` 和 `third-party/LICENSE-MIT-dsh`。
