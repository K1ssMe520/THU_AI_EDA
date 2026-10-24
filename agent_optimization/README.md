# Agent 优化实验

本目录实现一个固定流程的最小 EDA 自动设计 Agent。启动顶层 `make web`，打开 Agent 选项卡即可查看固定的 Agent 设计，并运行、回看每次执行过程。流程定义在代码中，网页只做只读展示，不提供在线编辑。

## 固定流程

```text
任务 Spec（固定输入）
   │
   ▼
Parser ── Spec 不充分 → 页面输入框补充 → 重新评估（最多 3 轮）
   │
   ▼
RTL Planner ── 规划模块结构 / 文件结构
   │
   ▼
Coder ── 逐个文件生成 RTL
   │
   ▼
Tester ── 编译全部 RTL + 教师 TB + 面积/功耗
   │ PASS
   ├──────────────→ Result Summary（固定输出）
   │ FAIL
   ▼
Modifier ── 修复 RTL ──→ Tester（最多 3 轮测试）
```

- **Parser**：用模型判断 Spec 是否充分；缺少接口、时序、复位、延迟或测试预期时，通过网页输入框向用户提问，用户补充后重新评估。
- **RTL Planner**：输出 JSON 计划，列出项目模块与文件结构。
- **Coder**：按计划逐个文件生成 SystemVerilog。
- **Tester**：把所有项目文件合并后交给固定教师 TB，并生成面积 / 功耗 metric；通过即结束。
- **Modifier**：失败时根据失败报告修改 RTL 文件，再回到 Tester；最多 3 轮测试。
- Spec 和 Summary 是画布上的只读固定节点，点击可查看完整内容；网页不提供节点编辑、连线、保存或设计空间。画布固定自动适配，不支持拖动或缩放。

## 子 Agent 实现

每个角色是一个单独的 Python 文件，并维护自己的上下文：

| 角色 | 文件 | 独立上下文 |
|---|---|---|
| Parser | `subagents/parser.py` | `runs/<run>/agents/parser/context.json` |
| RTL Planner | `subagents/planner.py` | `runs/<run>/agents/planner/context.json` |
| Coder | `subagents/coder.py` | `runs/<run>/agents/coder/context.json` |
| Tester | `subagents/tester.py` | `runs/<run>/agents/tester/context.json` |
| Modifier | `subagents/modifier.py` | `runs/<run>/agents/modifier/context.json` |

子 Agent 之间只通过 `runs/<run>/handoffs/` 下的 JSON 文件交互：

- `spec_to_parser.json`
- `parser_to_planner.json`
- `planner_to_coder.json`
- `coder_to_tester.json`
- `tester_to_modifier[_attemptN].json`
- `modifier_to_tester[_attemptN].json`
- `tester_to_summary[_attemptN].json`

画布上的箭头可点击，页面会读取对应的 handoff 文件，并支持在弹窗中切换多次 attempt 的版本。

## 目录与数据

- `agents/simple_eda_agent.json`：画布展示用的固定流程节点、角色说明与重试关系；
- `tasks/rise_edge/`：固定任务 Spec、教师 TB 与功耗脚本；
- `runs/<run-id>/`：每次运行的图快照、逐步事件、Parser 结果、计划、项目 RTL 文件、Tester 报告 / VCD、最终 `result.json` 与 metadata；
- `skills/` 与 `common/tooling.py`：此前实验中的 Python skill 与工具库代码，暂时未接入新的 Agent 流程，保留供后续启用。

## 安全与限制

执行器只按固定流程调用模型与本地教师 TB，不执行任意 shell 命令或访问任意文件路径；模型生成的文件路径会被限制在本次运行的项目目录内。Tester 使用固定的 `rise_edge` 任务与教师 TB，不能由网页替换。运行期间可点击 `Stop`；等待 Spec 补充时也可停止。
