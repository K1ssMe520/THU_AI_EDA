# AI EDA Lab

面向《人工智能辅助数字集成电路》的实验工程。代码按三部分组织：

- `prompt_optimization/`：Prompt 综合实验的任务、Prompt、实验说明与运行记录；
- `agent_optimization/`：可视化 Agent 综合实验的流程图、固定规格、教师 TB 与运行记录；
- `common/`：两项实验共用的 API 调用、RTL 自动验收和函数接口。

当前已实现 Prompt 综合实验，它严格执行一次性实验轨迹：

```text
冻结规格 + 一条 Prompt → 一次模型调用 → 原始 RTL → 教师 TB 自动验收
```

测试报告绝不会回传给模型；平台没有修复循环，也不会修改 RTL、规格或测试平台。

## 可视化工作台

安装依赖并设置 `DEEPSEEK_API_KEY` 后，启动本地 HTML 工作台：

```sh
make web
```

浏览器访问 `http://127.0.0.1:8000`。工作台包含 Prompt / Agent 顶级选项卡；Prompt 的教学内容页提供公开 Spec、可实时保存的 Prompt 编辑器、运行按钮、可选模型思维文本与最终回答、TB 周期时序表及综合面积 metric。

Agent 选项卡是一个本地可视化工作流编辑器：将 `Spec` / `Model` / `Verify` / `Report` 组件拖入画布、拖动位置，点击节点编辑 Prompt 并选择下一节点，然后运行搭建出的流程。执行窗口会按步骤展示实际渲染后发送给模型的 Prompt、可用的推理文本、原始回答 / RTL 以及 TB 报告。内置的最小可运行 Agent 为：

```text
Design Spec → RTL Designer → Compile & TB → Result Summary
```

它设计同步上升沿脉冲检测器 `rise_edge`。流程图保存于 `agent_optimization/agents/simple_eda_agent.json`，每次运行保存于 `agent_optimization/runs/`。执行器只允许页面展示的四种组件与固定本地验证工具；拖拽节点不能执行任意 shell 命令或访问任意文件路径。

## 快速开始

1. 安装依赖：`python -m pip install -r requirements.txt`
2. 如需在工作台显示基于 VCD 活动的功耗估算，安装 OpenSTA；项目优先使用 `.tools/opensta/bin/sta`，未安装时仍会显示面积。
3. 配置 `DEEPSEEK_API_KEY` 环境变量。
4. 在工程顶层直接运行参数化命令（完整课堂流程见顶层 `teaching.md`）：

   ```sh
   python -m common run \
     --task homework_sync_fifo \
     --prompt homework/P1_contract.md \
     --run-id p1-seed-01 \
     --temperature 0.2 \
     --max-tokens 4096
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

- `prompt_optimization/tasks/classroom_seq1011`：课堂演示题。教师演示从一句口头需求、接口约束、协议契约、最小补充到面积优化 Prompt 的迭代。
- `prompt_optimization/tasks/homework_sync_fifo`：课后题。学生提交 P0--P2 等多个独立 Prompt 条件，每个条件建议固定模型配置并使用至少三个独立运行。

使用 `python -m common --help` 查看命令帮助；`run`、`retest` 和 `summarize` 分别用于生成并验收、重测记录和汇总结果。教师可在 `common/cli.py` 的 `TASKS` 中登记新题目及其测试平台顶层名。学生只提交 `prompt_optimization/runs/` 下的实验记录与报告。正式评分时，建议教师在干净环境以隐藏测试集重跑 `generated.sv`。
