# AI EDA 课程实验教学指引

本讲义使用“单次 Prompt → 单次 RTL 生成 → 教师 TB 验收”的轨迹，演示需求如何在真实工程中逐步补齐。每次运行都是独立记录：不能手改已生成 RTL，也不能把 TB 报告贴回同一次生成中要求模型修复。

所有命令均在工程顶层执行，入口为 `python -m common`；不使用 `task.json`。

## 可视化工作台

完成下方依赖安装后，使用以下命令启动本地 HTML 工作台：

```sh
make web
```

打开浏览器访问 `http://127.0.0.1:8000`。页面的 Prompt / 教学内容区域包含只读 Spec、可编辑 Prompt、自动本地保存状态、运行按钮、模型推理文本和最终回答、教师 TB 的逐周期输入/输出表，以及面积 metric。Prompt 编辑器会先写入浏览器 `localStorage` 防止刷新丢失，再防抖保存回本地 Prompt Markdown 文件；服务仅监听 `127.0.0.1`。

Agent 选项卡提供本地可视化工作流编辑器。左侧拖入 `Spec`、`Model`、`Verify`、`Report` 组件，画布中可拖动位置；点击节点可以编辑该步骤 Prompt 并选择唯一的下一节点。默认小型 EDA Agent 是“上升沿脉冲检测器”：`Spec → RTL Designer → Compile & TB → Result Summary`。运行后，下方公共执行窗口按步骤显示真正发给模型的 Prompt、可用的推理文本、最终回答 / RTL，以及 TB trace 和 metric。图自动保存到 `agent_optimization/agents/simple_eda_agent.json`，运行记录保存到 `agent_optimization/runs/`。为保证实验可复现，当前执行器只允许这四类受限节点、无分支链式连接和固定教师 TB；不会执行用户自定义 shell 命令，也不会自动把失败结果回灌给模型修复。

## Ubuntu 环境安装

以下以 Ubuntu 22.04/24.04 为例。先安装 Python、Icarus Verilog 与 Yosys；Icarus 用于功能验收，Yosys 用于可选的综合面积比较。

```sh
sudo apt update
sudo apt install -y python3 python3-venv python3-pip iverilog yosys
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

设置模型密钥后，后续均使用虚拟环境 Python：

```sh
export DEEPSEEK_API_KEY='你的密钥'
test -n "$DEEPSEEK_API_KEY" || { echo "请先设置 DEEPSEEK_API_KEY"; exit 1; }
.venv/bin/python -m common --help
```

`verilog-pad-analyzer` 提供 45 nm 标准单元 Liberty 库。工程在每次仿真后使用 Yosys 映射并报告同一库下的标准单元面积，同时自动保存教师 TB 的 `activity.vcd`。若已安装独立 OpenSTA，工具会读取门级网表、Liberty、10 ns 时钟约束和 VCD，报告动态、漏电与总功耗；结果写入 `test_report.json` 的 `metrics` 字段。没有 LEF/DEF 或 SPEF 时，该功耗是前布局估算，不是签核结果。未安装 OpenSTA 时仍显示面积，并明确标为 `AREA ONLY`。

功能验收与功耗活动采样使用不同测试平台：`tb.sv` 只负责通过／失败判定，`power_tb.sv` 只生成 VCD。课堂序列检测器的功耗脚本覆盖连续吞吐、重叠匹配、反压和恢复；Agent 上升沿检测器覆盖低／高保持及重复上升沿。功耗 VCD 保存为对应运行目录中的 `activity.vcd`。

## 课堂任务：ready-valid 重叠序列检测器

任务名为 `classroom_seq1011`，目标模块为 `seq1011`。它接收串行 bit，检测允许重叠的模式 `1011`。每笔输入在下一个上升沿后产生一笔输出；输入 `1011011` 的输出必须为 `0001001`。

教师 TB 会检查：RTL 是否可编译、端口是否匹配、一拍输出延迟、连续吞吐、重叠匹配、反压保持、解除反压后不重复传输，以及同步低有效复位。公开规格位于 `prompt_optimization/tasks/classroom_seq1011/spec.md`。

### P1：一句口头需求

Prompt：`classroom/P1_contract.md`

```text
帮我写一个能检测二进制序列 1011 的电路。
```

本步没有模块名、端口、握手或输出格式约束。模型可能返回解释、伪代码或不匹配的模块；即使回答中偶尔有 Verilog 片段，也无法可靠接入教师 TB。这是“自然语言需求不足”的基线。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P1_contract.md \
  --run-id class-p1-one-sentence \
  --temperature 0.2 \
  --max-tokens 4096
```

### P2：接口与可提取 RTL

Prompt：`classroom/P2_interface_and_arithmetic.md`

本步新增精确的 `seq1011` 端口，并要求“只输出 SystemVerilog RTL”。因此平台能够从回答中提取 RTL 并连接 TB。它仍未定义 valid/ready 的传输时机、反压、复位和重叠处理，预期可能编译成功但功能失败。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P2_interface_and_arithmetic.md \
  --run-id class-p2-interface \
  --temperature 0.2 \
  --max-tokens 4096
```

### P3：明确握手与复位的初版需求

Prompt：`classroom/P3_timing_and_backpressure.md`

本步新增：输入在 `in_valid && in_ready` 时接收、每笔输入下一拍产生一笔输出、无反压时每周期吞吐、`out_valid/match` 的反压保持、允许重叠的 `1011`、同步低有效复位。它是可实现的完整功能契约，但“同步复位”仍可能被模型误写成异步敏感列表。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P3_timing_and_backpressure.md \
  --run-id class-p3-protocol \
  --temperature 0.2 \
  --max-tokens 4096
```

### P3.1：根据实际生成做最小需求补充

Prompt：`classroom/P3_1_sync_reset_clarification.md`

这是对真实工程需求迭代的模拟：教师先阅读 P3 的 RTL 和报告，再针对一个明确歧义新增一条约束。本版本只澄清同步复位：`rst_n` 不得出现在敏感列表中；复位在时钟边沿之外不能改变输出，到下一个上升沿才清空状态。P3.1 是新 Prompt、新运行记录，不修改 P3 的 RTL，也不把 TB 输出粘贴给模型。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P3_1_sync_reset_clarification.md \
  --run-id class-p3-1-sync-reset \
  --temperature 0.2 \
  --max-tokens 4096
```

### P4：内部状态推导与面积优化

Prompt：`classroom/P4_full_contract.md`

P4 保持 P3.1 的外部功能、时序和接口不变，仅增加内部推导要求：将状态定义为模式前缀的最长后缀，推导重叠匹配的状态转移，并比较三位历史移位寄存器与最小编码 FSM，选择状态位和组合逻辑更少的实现；同时要求只在实际输入握手时更新模式状态，避免无意义翻转。最终仍只输出 RTL，不输出推导过程。

TB 先确保 P3.1 与 P4 行为等价；再比较两次记录中 `test_report.json` 的 `metrics.area`。只有在两者均通过功能验收、并且使用相同 Yosys/库版本时，面积较小才可视为 P4 的面积优化证据。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P4_full_contract.md \
  --run-id class-p4-min-area \
  --temperature 0.2 \
  --max-tokens 4096
```

## 课后实验：同步 FIFO

课后题仍为 `homework_sync_fifo`。比较 P0、P1、P2 三个 Prompt 条件；每个条件独立运行至少三次，保持模型、温度、最大 token、思考模式与教师 TB 不变。学生只可编辑 `prompt_optimization/prompts/homework/` 下的 Prompt，不能修改 `tasks/homework_sync_fifo/` 中的规格和 TB。

```sh
.venv/bin/python -m common run --task homework_sync_fifo --prompt homework/P0_function_only.md --run-id p0-r01 --temperature 0.2 --max-tokens 4096
.venv/bin/python -m common run --task homework_sync_fifo --prompt homework/P1_contract.md --run-id p1-r01 --temperature 0.2 --max-tokens 4096
.venv/bin/python -m common run --task homework_sync_fifo --prompt homework/P2_contract_and_checklist.md --run-id p2-r01 --temperature 0.2 --max-tokens 4096
```

将 `r01` 改为 `r02`、`r03`，完成独立重复。汇总记录：

```sh
.venv/bin/python -m common summarize --task classroom_seq1011
.venv/bin/python -m common summarize --task homework_sync_fifo
```

## 清理运行记录

以下命令会删除整个 `prompt_optimization/runs/`，包括 Prompt、原始回答、RTL、报告和面积记录；不会删除任务、Prompt 模板或教师 TB。

```sh
make clean-runs
```
