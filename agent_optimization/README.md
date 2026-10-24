# Agent 优化实验

本目录实现了一个可视化、可运行的最小 EDA 自动设计 Agent。启动顶层的 `make web`，打开 Agent 选项卡即可拖动组件搭建流程、点击节点编辑该步骤的 Prompt，并在同一个执行窗口检查每个步骤的实际输入与输出。

默认流程是：

```text
Design Spec → RTL Designer → Compile & TB → Result Summary
```

默认任务是 `rise_edge`：为单比特输入生成同步上升沿脉冲。公开规格和教师 TB 分别位于 `tasks/rise_edge/spec.md` 与 `tasks/rise_edge/tb.sv`。一次运行会保存图快照、模型原始回答、提取的 RTL、可选 reasoning 文本、TB trace / 报告与面积 metric 到 `runs/<run-id>/`。

## 受限图模型

图定义保存在 `agents/simple_eda_agent.json`，支持以下节点：

- `spec`：将节点文本作为规格注入上下文；
- `model`：调用模型并提取 RTL；Prompt 可引用 `{spec}`、`{rtl}`、`{tb_result}` 与 `{previous}`；
- `verify`：以固定教师 TB 编译、仿真并计算 metric；
- `report`：汇总当前结果。

`verify` 和 `report` 的 Prompt 是可见、可保存的步骤说明；前者不会把文字传给模型，而是调用固定教师 TB。为使课堂实验可复现且安全，浏览器只能保存这四种节点，且每个节点最多一个前驱与一个后继；验证任务、测试平台及输出目录均固定，不能由 Prompt 或拖拽组件指定任意命令或路径。该 Agent 不会把失败 TB 自动反馈给模型修复，因而一次运行仍清楚区分了模型生成和后验验证。
