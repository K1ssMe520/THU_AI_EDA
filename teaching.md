# AI EDA 课程实验教学指引

本讲义的 Prompt 部分使用“单次 Prompt → 单次 RTL 生成 → 教师 TB 验收”的轨迹，演示需求如何在真实工程中逐步补齐。每次运行都是独立记录：不能手改已生成 RTL，也不能把 TB 报告贴回同一次生成中要求模型修复。Agent 部分则是独立的工作流实验：允许把失败报告作为新的模型调用输入进行有限次重试，但每一步都会单独记录。API 参数部分用三组数字电路题目单独演示 `max_tokens`、`temperature` 与 `reasoning_effort` 对回答质量的影响。

所有命令均在工程顶层执行，入口为 `python -m common`；不使用 `task.json`。

## 可视化工作台

完成下方依赖安装后，使用以下命令启动本地 HTML 工作台：

```sh
make web
```

打开浏览器访问 `http://127.0.0.1:8000`。工作台默认打开 API 参数页，可通过顶部选项卡切换 API 参数 / Prompt / Agent。Prompt 的教学内容区域以只读方式展示教师维护的 5 条 Prompt（工作台内不可修改，教师直接编辑 `prompt_optimization/prompts/classroom/` 下的文件）；页面提供「生成 RTL」按钮、合并显示的模型思维文本与最终回答（生成过程中逐字更新并分色区分）、TB 面板的「运行 TB」按钮、metric 面板的「评估 metric」按钮、教师 TB 的逐周期输入/输出表，以及面积 metric。生成阶段只调用一次模型并保存运行记录，不会自动跑 TB；确认 RTL 后，可分别在 TB 面板与 metric 面板运行教师 TB、功耗脚本与综合评估。课后作业页的 Prompt 才是学生可编辑的；服务仅监听 `127.0.0.1`。

Agent 选项卡是固定 Agent 流程的只读展示与运行页面。**任务 Spec 是固定输入、最终验收结果是固定输出**：画布固定自动适配，不提供拖动 / 缩放 / 编辑；以只读的 `Task Spec` 与 `Result Summary` 固定节点展示，点击固定节点会弹窗展示完整 Spec 或最终教师 TB 的 PASS/FAIL、Area 与 Power。画布上展示固定的五个角色节点：

```text
Spec → Parser → RTL Planner → Coder → Tester
                                  │ FAIL
                                  └──→ Modifier ──→ Tester
```

- **Parser**：判断 Spec 是否充分；缺少接口、时序、复位、延迟或测试预期时，页面弹出输入框，用户补充后 Parser 重新评估（最多 3 轮）。
- **RTL Planner**：解析 Spec，规划模块结构、文件结构和顶层模块。
- **Coder**：按照计划逐个文件生成 RTL。
- **Tester**：编译全部 RTL 文件，运行固定教师 TB，并生成面积 / 功耗 metric；全部通过则结束。
- **Modifier**：Tester 失败时读取失败报告并修改 RTL，然后回到 Tester 重新测试，最多 3 轮测试。

点击流程节点只查看该节点固定的 Prompt 与重试配置，工作台不提供在线编辑。每个角色对应 `agent_optimization/subagents/` 下的独立 Python 文件，并维护自己的 `agents/<role>/context.json`；子 Agent 之间通过 `handoffs/<source>_to_<target>.json` 交接。画布上的箭头可点击，弹窗查看对应交接内容与历史 attempt。流程入口固定于 `agent_optimization/agents/simple_eda_agent.json` 与 `common/agent_runner.py`。运行记录保存在 `agent_optimization/runs/`，可以从左侧运行历史重新载入或删除。执行器不会执行用户输入的任意 shell 命令；教师 TB 与任务路径固定。Skill 与 function calling 暂不接入本流程。运行期间可以点击 `Stop` 请求取消，取消在当前模型调用返回后生效，已完成的步骤仍会保留。常用快捷键：`⌘/Ctrl + Enter` 运行 Agent。

API 参数选项卡是工作台默认首页，页面顶部同一行展示子选项卡与模型名称、API 地址，三组实验通过子选项卡分页展示。每组固定数字电路题目会真实调用一次模型：

1. `max_tokens`：同一道同步 FIFO 设计题分别用 512 和 4096 运行。512 时回答在 RTL 中途被截断，`finish_reason=length` 且没有 `endmodule`；4096 才能完整输出模块，页面会自动判定完整性。
2. `temperature`：同一道 8 位乘法器架构选择题在 0.0 和 1.4 下各连续运行两次。低温两次回答高度一致，高温更容易给出不同的架构与理由，页面用字符相似度直观展示差异。
3. `reasoning_effort`：同一道双路径 setup/hold 时序分析题分别以 low / high / max 运行。正确答案为 A_setup=2.10 ns、A_hold=0.90 ns、B_setup=3.40 ns、B_hold=0.55 ns、fmax=169.49 MHz；题目故意包含“setup 用最大延迟、hold 用最小延迟”和正时钟偏斜两个易错点，页面会逐项比对 5 个答案并可展开思维链对比推导步骤。

这三组实验只使用 `common/param_lab.py` 中登记的固定题目，只做单次模型调用、不写实验记录，因此可以反复点击观察参数变化。等价的代码入口仍可通过 `ModelClient(temperature=..., max_tokens=..., thinking=..., reasoning_effort=...)` 在命令行实验中使用。

如果运行后显示「模型没有返回最终文本内容（finish_reason=length…）」，通常不是 Prompt 或文件问题，而是开启 thinking 后思考过程占用了大部分输出预算。客户端会对偶发空响应自动重试一次；若仍为空，按提示提高 `max_tokens`（如 8192/16384），或仅在需要 RTL 时关闭 thinking。页面在勾选思考模式且 max tokens 较低时也会弹出提醒。

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

Prompt：`classroom/P1_oral_request.md`

```text
帮我写一个能检测二进制序列 1011 的电路，用 SystemVerilog 实现，谢谢！
```

本步没有模块名、端口、握手细节和输出格式约束。模型通常会把解释、代码片段甚至其他模块混在一起回答；平台无法稳定提取出可接入教师 TB 的 RTL，也会产生大量与设计无关的文字。这是“自然语言需求不足”的基线，P1 的运行结果不应直接作为功能结论。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P1_oral_request.md \
  --run-id class-p1-oral \
  --temperature 0.2 \
  --max-tokens 4096
```

### P2：接口与可提取 RTL

Prompt：`classroom/P2_interface_and_output.md`

本步新增精确的 `seq1011` 端口，并明确“只输出 SystemVerilog RTL”。因此平台可以从回答中提取 RTL、接入教师 TB 并得到可比较的测试报告。它仍未定义 valid/ready 传输时机、输出延迟、反压和复位方式，预期可以编译但功能测试失败——这正是后续 Prompt 要逐步修正的地方。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P2_interface_and_output.md \
  --run-id class-p2-interface \
  --temperature 0.2 \
  --max-tokens 4096
```

### P3：明确握手信号与复位逻辑

Prompt：`classroom/P3_handshake_and_reset.md`

本步补上 valid/ready 握手与复位的基本语义：仅在 `in_valid && in_ready` 时接收一个 bit，输出通过 `out_valid/out_ready` 传输，`rst_n` 低有效复位清空历史与在途输出，并明确检测允许重叠的 `1011`。但输出延迟、每周期吞吐、反压保持和同步复位写法仍未定义，生成的 RTL 仍可能无法通过 TB——这里不要求本步一定可用，目的是展示“补上握手与复位后还缺什么”。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P3_handshake_and_reset.md \
  --run-id class-p3-handshake-reset \
  --temperature 0.2 \
  --max-tokens 4096
```

### P4：根据实际生成做最小增量补充

Prompt：`classroom/P4_incremental_clarification.md`

真实工程中的需求不会一次到位。教师先阅读 P3 生成的 RTL 与 TB 报告，根据实际失败点只补充少量细节：每拍输入恰好一笔输出且 N+1 拍给出结果、反压时 `out_valid/match` 保持且不丢失/重复/重排、复位必须是同步低有效并禁止异步敏感列表。P4 是新 Prompt、新运行记录，不修改 P3 的 RTL，也不把 TB 输出回传给同一次模型调用。到这一步才形成可稳定通过教师 TB 的完整契约。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P4_incremental_clarification.md \
  --run-id class-p4-complete-contract \
  --temperature 0.2 \
  --max-tokens 4096
```

### P5：思维链指导低面积 / 低功耗实现

Prompt：`classroom/P5_cot_low_area.md`

P5 在 P4 的完整契约之上新增一个独立的「思维链」小节：先把状态抽象为“已接收历史中同时是 `1011` 前缀的最长后缀”，比较二进制与 one-hot 编码，把输出缓冲与模式状态分离，只在握手成功时更新状态，并复查无效翻转与多余逻辑。该小节只用于指导模型内部推导，最终仍只输出 RTL，不输出推导过程。TB 先确保 P4 与 P5 行为等价，再比较两次记录 `test_report.json` 中的 `metrics.area`；只有在两者均通过功能验收且使用相同 Yosys/库版本时，面积较小才可视为 P5 的优化证据。

```sh
.venv/bin/python -m common run \
  --task classroom_seq1011 \
  --prompt classroom/P5_cot_low_area.md \
  --run-id class-p5-cot-area \
  --temperature 0.2 \
  --max-tokens 4096
```

## 课后作业：单模块 AES-128 加密核

课后题任务名为 `homework_aes128`，目标模块为 `aes128`。它要求用**一个** SystemVerilog 模块实现标准 AES-128 加密（FIPS-197）；算法内部可以拆成密钥扩展、S-box、行移位、列混合和轮控制等多个层次，但所有逻辑必须写在同一个 `module` 内，禁止例化其他模块或引用外部模块、IP、外部文件。

工作台的「Prompt → 课后作业」子页提供：

- 只读 Spec，教师 TB 与功耗脚本固定，学生不可修改；
- 一条空白的 Prompt 编辑器，没有 Prompt Stage 模板；
- 流式「生成 RTL」按钮：模型输出逐字显示，只保存运行记录，不自动测试；
- TB 面板的「运行 TB」按钮与 metric 面板的「评估 metric」按钮：分别对已生成的 RTL 运行教师 AES TB、以及功耗脚本与综合评估；
- 运行历史：每条记录显示该轮 Prompt 摘要；点击后会把该轮 Prompt 载入编辑器，同时恢复模型回答、教师 TB 的握手/标准向量/忙时复位检查以及面积与功耗 metric。

学生需要自行设计一条完整 Prompt，建议覆盖：

1. 算法分解：密钥扩展、S-box、ShiftRows、MixColumns、轮计数与输出握手；
2. 接口与协议：`ready` / `start` / `done` 握手、`done` 单周期、200 拍内完成、连续多组加密；
3. 实现方案对比：S-box 查表或组合逻辑、轮密钥存储或在线展开、轮函数串行/并行；
4. 面积与功耗优化思维链：资源复用、寄存器位宽、减少无效翻转、避免宽多路选择器。

教师 TB 会检查 FIPS-197 标准向量、连续加密、忙时复位与 `done` 单脉冲；功耗脚本生成 `activity.vcd` 后由 OpenSTA 估算动态/漏电功耗。评分同时考虑功能通过情况与相同模型配置下的面积/功耗 metric。

命令行运行（Prompt 文件位于 `prompt_optimization/prompts/homework/H1_custom.md`，也可直接在页面编辑器中保存）：

```sh
.venv/bin/python -m common run \
  --task homework_aes128 \
  --prompt homework/H1_custom.md \
  --run-id hw-r01 \
  --temperature 0.2 \
  --max-tokens 8192
```

将 `hw-r01` 改为 `hw-r02`、`hw-r03` 完成独立重复。汇总记录：

```sh
.venv/bin/python -m common summarize --task classroom_seq1011
.venv/bin/python -m common summarize --task homework_aes128
```

旧的 `homework_sync_fifo` 任务仍保留在 `common/cli.py` 的 `TASKS` 中，用于复现历史同步 FIFO 实验记录。

## 清理运行记录

以下命令会删除整个 `prompt_optimization/runs/`，包括 Prompt、原始回答、RTL、报告和面积记录；不会删除任务、Prompt 模板或教师 TB。

```sh
make clean-runs
```
