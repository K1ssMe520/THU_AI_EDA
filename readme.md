# AI EDA Lab

面向《人工智能辅助数字集成电路》的实验工程。代码按三部分组织：

- `prompt_optimization/`：Prompt 综合实验的任务、Prompt、实验说明与运行记录；
- `agent_optimization/`：可视化 Agent 综合实验的流程图、固定规格、教师 TB 与运行记录；
- `common/`：Prompt / Agent 实验与 API 参数演示共用的模型调用、参数实验、RTL 自动验收和函数接口。

Prompt 综合实验严格执行一次性实验轨迹：

```text
冻结规格 + 一条 Prompt → 一次模型调用 → 原始 RTL → 教师 TB 自动验收
```

该轨迹的测试报告绝不会回传给同一次模型调用，也不会修改已保存的 RTL、规格或测试平台。Agent 选项卡是独立的可视化工作流实验：它可以把失败报告作为下一次模型调用的输入，但每次重试都会形成独立步骤与可追溯的运行记录。

## 可视化工作台

安装依赖并设置 `DEEPSEEK_API_KEY` 后，启动本地 HTML 工作台：

```sh
make web
```

浏览器访问 `http://127.0.0.1:8000`。工作台包含 API 参数 / Prompt / Agent 三个顶级选项卡，默认打开 API 参数页；Prompt 的教学内容页以只读方式展示 5 条教学 Prompt（由教师直接维护文件，工作台内不可修改），并提供流式生成按钮、可选模型思维文本与最终回答（生成过程中逐字更新、合并显示并分色区分）、TB 面板的「运行 TB」按钮、metric 面板的「评估 metric」按钮、TB 周期时序表及综合面积 metric。Prompt 下的「课后作业」子页展示课后任务 Spec，只提供一个可编辑的空白 Prompt 编辑器，学生自行编写包含算法分解与面积优化思维链的完整 Prompt；同样先流式生成 RTL，再分别运行教师 AES TB 与面积/功耗评估。

如果开启 thinking 后出现「模型没有返回最终文本内容（finish_reason=length…）」，通常是思考过程占用了大部分输出预算：客户端会自动重试一次偶发空响应，仍为空时请提高 `max_tokens`（8192/16384），或关闭 thinking 后重试。

Agent 选项卡是固定 Agent 流程的**只读展示与运行页面**。流程定义在代码中，网页不提供在线编辑：

- **Spec Parser**：用模型判断 Spec 是否充分，检查接口、时序、复位、延迟、测试预期等是否缺失；不充分时在页面上弹出输入框，用户补充后重新评估（最多 3 轮）。
- **RTL Planner**：解析 Spec，输出模块结构与文件结构（JSON 计划）。
- **Coder**：按计划逐个文件生成 RTL。
- **Tester**：编译全部项目 RTL，运行固定教师 TB，并执行面积 / 功耗评估；全部通过则结束。
- **Modifier**：Tester 失败时根据失败报告修改 RTL，然后回到 Tester 重新验证，最多 3 轮测试。
- 画布固定自动适配，不提供拖动 / 缩放 / 编辑；以只读节点展示 `Task Spec → Parser → Planner → Coder → Tester / Modifier → Result Summary`。点击固定节点可查看完整 Spec 或最终 PASS/FAIL、Area、Power；点击流程节点只查看 Prompt 与重试配置。
- 运行结束后自动生成固定输出结果；Parser 的补充内容、Planner 计划、生成文件、Tester 尝试次数与最终 metrics 都保存在运行记录中。

每个角色都是一个独立维护上下文的 Python 子 Agent：

- [parser.py](agent_optimization/subagents/parser.py)：Spec 完整性判断与用户补充；
- [planner.py](agent_optimization/subagents/planner.py)：模块 / 文件规划；
- [coder.py](agent_optimization/subagents/coder.py)：逐文件 RTL 生成；
- [tester.py](agent_optimization/subagents/tester.py)：教师 TB、面积与功耗评估；
- [modifier.py](agent_optimization/subagents/modifier.py)：失败修复。

子 Agent 之间只通过 `runs/<run-id>/handoffs/` 下的 JSON 文件交接；每次运行还会为每个子 Agent 保存独立的 `runs/<run-id>/agents/<role>/context.json`。画布上的箭头可点击，弹窗展示对应 handoff 文件的内容（含多次 attempt 的版本）。流程和角色入口固定于 `agent_optimization/agents/simple_eda_agent.json` 与 [common/agent_runner.py](common/agent_runner.py)。Skill 与 function calling 暂不在本 Agent 流程中启用。

运行期间可以点击 `Stop` 请求取消；等待用户补充 Spec 时也可以停止。快捷键：`⌘/Ctrl + Enter` 运行 Agent。

API 参数选项卡用于演示大模型 API 对接参数（默认首页，三组实验通过子选项卡分页展示）：

- 页面顶部只有一行：子选项卡 + 当前 `model` / `base_url`，不再额外铺开参数说明，直接进入实验内容。
- `max_tokens`：同一道同步 FIFO 设计题分别以 512 / 4096 运行；512 会在 RTL 中途被截断（`finish_reason=length`），4096 才能得到包含 `endmodule` 的完整回答。
- `temperature`：同一道 8 位乘法器架构选择题在 0.0 / 1.4 下各连续运行两次；低温两次回答高度一致，高温更容易给出不同的架构与表述，页面直接给出两次回答的相似度。
- `reasoning_effort`：同一道双路径 setup/hold 时序分析题分别以 low / high / max 运行；需要正确区分 setup 用最大延迟、hold 用最小延迟，并处理时钟偏斜符号。页面逐项比对 5 个参考答案（A/B 两条路径的 setup、hold slack 与最高频率 169.49 MHz），并可展开思维链比较推导过程。
- 三组实验只调用 `common/param_lab.py` 中登记的固定题目，单次调用、不写任何实验记录，便于课堂上快速对比参数效果。

## 快速开始

1. 安装依赖：`python -m pip install -r requirements.txt`
2. 如需在工作台显示基于 VCD 活动的功耗估算，安装 OpenSTA；项目优先使用 `.tools/opensta/bin/sta`，未安装时仍会显示面积。
3. 配置 `DEEPSEEK_API_KEY` 环境变量。
4. 在工程顶层直接运行参数化命令（完整课堂流程见顶层 `teaching.md`）：

   ```sh
   python -m common run \
     --task homework_aes128 \
     --prompt homework/H1_custom.md \
     --run-id hw-seed-01 \
     --temperature 0.2 \
     --max-tokens 8192
   ```

结果保存在 `prompt_optimization/runs/<task>/<run-id>/`。其中 `prompt.md`、`raw_response.txt`、`generated.sv`、`metadata.json` 和 `test_report.json` 共同构成一条可复现实验记录。

## 公共函数

- `create_run()`：仅进行一次模型调用，不测试。
- `test_rtl()`：对已有 RTL 执行教师测试。
- `run_prompt_experiment()`：严格按“生成一次，再测试一次”完成一条轨迹。
- `retest_run()`：重跑已有运行记录，并校验 RTL 未被修改。
- `summarize_task()`：返回一个任务的结果汇总。

`run_prompt_experiment()` 不接受失败报告作为输入。重新设计 Prompt 必须新建一个独立 run；不得在生成后手改 `generated.sv`。重测时会校验 RTL 哈希，检测到修改会拒绝执行。

## 课程组织

- `prompt_optimization/tasks/classroom_seq1011`：课堂演示题。教师按 P1 口头需求 → P2 接口与输出约束 → P3 握手与复位 → P4 增量补充 → P5 思维链面积优化，演示 Prompt 如何一步步搭建。
- `prompt_optimization/tasks/homework_aes128`：课后作业。单模块 AES-128 加密核，包含公开 Spec、教师 TB 与功耗脚本；工作台课后作业页只有一个空白 Prompt 编辑器，学生需自行写出包含算法分解、实现方案对比与面积/功耗优化思维链的完整 Prompt。

使用 `python -m common --help` 查看命令帮助；`run`、`retest` 和 `summarize` 分别用于生成并验收、重测记录和汇总结果。教师可在 `common/cli.py` 的 `TASKS` 中登记新题目及其测试平台顶层名。学生只提交 `prompt_optimization/runs/` 下的实验记录与报告。正式评分时，建议教师在干净环境以隐藏测试集重跑 `generated.sv`。
