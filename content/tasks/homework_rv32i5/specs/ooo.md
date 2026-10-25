# L3：RV32I + I/D Cache + 动态分支预测 + 乱序执行

目标层级：**L3**。本文件包含完整基础需求和累加扩展合同。扩展条款优先级：D > C > B > A > 基础；最终实现必须遵守 A 中的统一高级顶层接口。


> **实现接口以 §A 为准**：本文 §1–§9 是继承的基础架构说明；L1/L2/L3 的顶层端口、总线握手、能力/退休观察端口必须采用 §A 的统一高级接口，不能直接使用基础 §2 的零等待接口。若两者冲突，§A 及后续扩展章节优先。

## 基础架构需求（继承）

## 1. 任务目标

实现一个可综合的 RV32I 五级流水线处理器，顶层模块名为 `rv32i5`。处理器采用分离的指令 / 数据存储器接口（Harvard），每级一拍、无等待状态；外部 testbench 通过固定的顶层端口提供指令与数据存储模型，并通过 `halted` / `exit_code` 观测停机。

必须按 IF / ID / EX / MEM / WB 拆分模块，实现数据前递、load-use 暂停与控制冒险冲刷；不得实现成逐条串行的多周期状态机。

## 2. 顶层接口（固定）

端口名、方向、位宽固定，不得增删或改名；内部子模块端口由实现者自行规划。

```systemverilog
module rv32i5 (
    input  logic        clk,
    input  logic        rst_n,
    output logic [31:0] imem_addr,
    input  logic [31:0] imem_rdata,
    output logic        dmem_valid,
    output logic        dmem_we,
    output logic [31:0] dmem_addr,
    output logic [31:0] dmem_wdata,
    output logic [3:0]  dmem_be,
    input  logic [31:0] dmem_rdata,
    input  logic [4:0]  dbg_reg_addr,
    output logic [31:0] dbg_reg_data,
    output logic        halted,
    output logic [31:0] exit_code
);
```

## 3. 存储器接口语义

### 3.1 指令存储器

- `imem_addr` 为当前 IF 级取指字节地址，低 2 位恒为 0（字对齐）。
- 指令存储器为组合读、零等待：同一拍内 `imem_rdata` 返回 `imem_addr` 所指的 32-bit 指令字。
- IF 级只在时钟沿更新 PC，因此 `imem_addr` 在一拍内保持稳定。
- 程序从地址 0 开始；不要求支持非对齐取指。

### 3.2 数据存储器

- `dmem_valid` 在 MEM 级存在有效 load/store 时拉高恰好一个周期；复位期间及 `halted=1` 期间必须为 0。
- load：`dmem_we=0`，`dmem_addr` 为访存字节地址；`dmem_be`、`dmem_wdata` 不参与写（可为任意值）。
- store：`dmem_we=1`，外部存储器在 `dmem_valid && dmem_we` 的时钟上升沿按 `dmem_be` 逐字节写入。
- `dmem_rdata` 为组合读、零等待：在 `dmem_valid=1` 的整个时钟周期内，`dmem_rdata` 必须等于以 `{dmem_addr[31:2], 2'b00}` 为起始的小端 32-bit 字；load 在 MEM 级当拍末（MEM/WB 寄存器沿）采样，并按 `dmem_addr[1:0]` 选择字节 / 半字并做符号或零扩展。
- `dmem_addr` 在 `dmem_valid=1` 的周期内必须保持稳定。`dmem_valid=0` 时 `dmem_we` / `dmem_addr` / `dmem_wdata` / `dmem_be` 为 don't-care，外部存储模型不得据此写入；`dmem_we` 仅在有效 store 且 `dmem_valid=1` 时为 1。
- `dmem_wdata` 按访问宽度复制到四个字节 lane，`dmem_be` 选择真正写入的 lane（`be[i]` 对应字节地址 `addr[1:0]==i`）：
  - `SW`：`dmem_wdata = store_data[31:0]`，`dmem_be = 4'b1111`
  - `SH`：`dmem_wdata = {2{store_data[15:0]}}`，`dmem_be = dmem_addr[1] ? 4'b1100 : 4'b0011`
  - `SB`：`dmem_wdata = {4{store_data[7:0]}}`，`dmem_be = 4'b0001 << dmem_addr[1:0]`
- 所有 load/store 均自然对齐（`LH/SH` 要求 `addr[0]=0`，`LW/SW` 要求 `addr[1:0]=00`）；程序保证不出现非对齐访问，非对齐行为不作要求。
- 写数据 `store_data` 为经过前递的 `rs2` 值；`SB/SH` 只使用其低位。

### 3.3 调试端口与时钟

- `dbg_reg_addr` 选择架构寄存器 `x0..x31`，`dbg_reg_data` 组合读出其当前值；`x0` 恒读 0；不含前递；只读，不要求调试写端口。
- 单时钟域，`clk` 周期 10 ns（100 MHz），由外部 testbench 驱动。

## 4. 复位与停机协议

- `rst_n` 为同步低有效复位，只在 `clk` 上升沿生效；不实现异步复位。
- 复位沿（采样到 `rst_n=0` 的上升沿）：PC 清零到 `0x0000_0000`、32 个架构寄存器清零、全部流水线 valid 清零、`halted=0`、`exit_code=0`，且不产生任何数据存储器写（`dmem_valid=0`）。
- `rst_n=0` 期间（包括第一个复位上升沿之前）`dmem_valid` 必须为 0；实现应在输出级用 `rst_n` 组合屏蔽已进入 MEM 的 store，避免复位沿写入外部存储器。复位期间不检查 `imem_addr` / `dmem_addr` / `dmem_wdata` / `dmem_be` 的具体值。
- 复位优先于所有控制动作：`rst_n=0` 的上升沿丢弃同拍的分支重定向、`ECALL` 提交和 store 写请求，`halted` / `exit_code` 清零。复位释放后从 PC 0 开始取指。
- `halted` / `exit_code` 是寄存器输出；在 ECALL 提交沿之后（从下一拍起）才要求 `halted=1` 且 `exit_code` 等于最终 `x10`。
- `ECALL`（指令字恰为 `32'h0000_0073`）是本任务唯一的停机约定：它按普通指令流经流水线，不进入异常 / CSR / trap 流程，自身不写寄存器、不访问数据存储器。
- `ECALL` 在 ID 级被识别、且当拍没有更老的控制转移重定向时进入 halt-pending 状态：PC 保持，IF/ID 每拍写入 `valid=0`（后续取到的指令全部丢弃），不得产生新的数据存储器事务；比它更老的指令继续完成并提交。
- 在 halt-pending 期间，`ECALL` 自身必须作为有效指令继续经 EX → MEM → WB 前进，不得在 ID/MEM 级提前置位 `halted`，也不得写寄存器或访问数据存储器。
- 当 `ECALL` 到达 WB 级并在该时钟沿提交时：置 `halted=1`，同时 `exit_code ← x10`。该时刻所有更老指令均已提交，`x10` 已是最终值。
- 若更老的控制转移冲刷掉 ID 级的 `ECALL`，则该 `ECALL` 不产生停机；只有实际提交到 WB 的 `ECALL` 才置位 `halted`。
- `halted=1` 后保持到下一次复位：流水线停止推进（或全部 valid 清零），WB 不得再写寄存器，`dmem_valid=0`，PC 与 `imem_addr` 保持停机时的值；架构寄存器保持稳定，因此同一 `dbg_reg_addr` 下 `dbg_reg_data` 保持稳定，`exit_code` 保持稳定。
- `halted=0` 时 `exit_code=0`；`halted=1` 期间 `exit_code` 稳定等于停机时的 `x10`。

## 5. 指令集范围与语义

仅实现 RV32I 的下列子集，指令均为 32-bit 定长、4 字节对齐。

### 5.1 整数运算 / 逻辑 / 移位

- R 型：`ADD`、`SUB`、`SLL`、`SLT`、`SLTU`、`XOR`、`SRL`、`SRA`、`OR`、`AND`
- I 型：`ADDI`、`SLTI`、`SLTIU`、`XORI`、`ORI`、`ANDI`
- 立即数移位：`SLLI`、`SRLI`、`SRAI`，移位量取 `imm[4:0]`；寄存器移位 `SLL/SRL/SRA` 的移位量取 `rs2[4:0]`
- `SLT/SLTI` 按 32 位补码有符号比较；`SLTU/SLTIU` 按无符号比较（`SLTIU` 的立即数先按标准符号扩展、再按无符号比较）；`SRA/SRAI` 为算术右移。

### 5.2 上位立即数

- `LUI`：`rd = {inst[31:12], 12'b0}`
- `AUIPC`：`rd = pc + {inst[31:12], 12'b0}`，`pc` 为 `AUIPC` 自身的地址。

### 5.3 Load / Store

- Load：`LB`、`LH`、`LW`、`LBU`、`LHU`；Store：`SB`、`SH`、`SW`
- load / store 的有效地址 = 前递后的 `rs1 + sext(imm[11:0])`。
- load 数据按 `funct3` 符号 / 零扩展后写回；store 写数据取自前递后的 `rs2`。

### 5.4 控制转移

- 条件分支：`BEQ`、`BNE`、`BLT`、`BGE`、`BLTU`、`BGEU`；无条件跳转：`JAL`、`JALR`
- 分支条件与跳转目标在 EX 级用前递后的操作数解析；没有分支延迟槽。
- `JAL`：`rd = pc + 4`（`pc` 为 `JAL` 自身地址），目标 = `pc + sext(J 型立即数)`。
- `JALR`：`rd = pc + 4`，目标 = `(rs1 + sext(I 型立即数)) & 32'hFFFF_FFFE`。
- 有效程序保证所有控制转移目标 4 字节对齐（PC[1:0] 恒为 00）。

### 5.5 不支持

- 不支持 `M`/`A`/`F`/`D` 扩展、压缩指令、`FENCE`、CSR、异常、中断和调试指令。
- 除 `ECALL` 外的 system 指令无需实现；非法指令行为不作要求，但不得破坏已定义指令的正确性。

### 5.6 有效程序假设

- 程序从地址 0 开始，并以一条可提交到 WB 的 `ECALL` 结束；因此 `halted` 最终必然出现。
- 所有指令地址、分支目标和跳转目标均 4 字节对齐；load/store 自然对齐且地址位于外部存储模型范围内。
- 不出现非法指令、非对齐访问或越界访问；这些情况的行为不在本 Spec 定义范围内。

## 6. 标准编码、立即数与地址规则

### 6.1 编码

| 类型 | opcode | funct3 / funct7 |
|---|---|---|
| R 型 | `0110011` | ADD `000/0000000`、SUB `000/0100000`、SLL `001/0000000`、SLT `010/0000000`、SLTU `011/0000000`、XOR `100/0000000`、SRL `101/0000000`、SRA `101/0100000`、OR `110/0000000`、AND `111/0000000` |
| I 型 ALU | `0010011` | ADDI `000`、SLTI `010`、SLTIU `011`、XORI `100`、ORI `110`、ANDI `111`；SLLI `001/0000000`、SRLI `101/0000000`、SRAI `101/0100000` |
| Load | `0000011` | LB `000`、LH `001`、LW `010`、LBU `100`、LHU `101` |
| Store | `0100011` | SB `000`、SH `001`、SW `010` |
| Branch | `1100011` | BEQ `000`、BNE `001`、BLT `100`、BGE `101`、BLTU `110`、BGEU `111` |
| JAL | `1101111` | — |
| JALR | `1100111` | `000` |
| LUI | `0110111` | — |
| AUIPC | `0010111` | — |
| ECALL | `1110011` | 指令字恰为 `32'h0000_0073` |

### 6.2 立即数格式（均按 RV32I 标准）

- I 型：`imm = sext(inst[31:20])`；S 型：`imm = sext({inst[31:25], inst[11:7]})`
- B 型：`imm = sext({inst[31], inst[7], inst[30:25], inst[11:8], 1'b0})`
- U 型：`imm = {inst[31:12], 12'b0}`；J 型：`imm = sext({inst[31], inst[19:12], inst[20], inst[30:21], 1'b0})`

### 6.3 访存与字节 lane

- 小端：字节地址 `a` 的数据位于 `dmem_rdata` 的 `[8*a[1:0] +: 8]`。
- 扩展规则：`LB/LBU` 取 `dmem_rdata` 的一个字节，`LH/LHU` 取由 `addr[1]` 选中的半字，`LW` 取整字；`LB/LH` 符号扩展，`LBU/LHU` 零扩展。
- 字节使能与 `dmem_wdata` 的复制规则见 §3.2。

### 6.4 分支 / 跳转目标

- Taken 条件：`BEQ` 为 `rs1==rs2`、`BNE` 为 `rs1!=rs2`；`BLT/BGE` 按补码有符号比较；`BLTU/BGEU` 按无符号比较。
- 分支目标 = 分支指令 PC + B 型立即数；`JAL` 目标 = PC + J 型立即数；`JALR` 目标 = `(rs1 + I 型立即数) & 32'hFFFF_FFFE`。
- 链接地址 = 跳转指令 PC + 4。
- `x0` 恒为 0：读恒为 0，任何写 `x0` 的结果被丢弃；`rd=x0` 不产生写回、前递或 load-use 暂停。

## 7. 五级流水线与冒险处理

### 7.1 各级职责

| 级 | 职责 |
|---|---|
| IF | 维护 PC，驱动 `imem_addr`，锁存 `imem_rdata`；重定向后从目标取指 |
| ID | 译码、读寄存器堆、生成立即数与全部控制信号；识别 `ECALL` |
| EX | 操作数前递、ALU 运算、分支判断与目标计算、`JAL/JALR` 目标与链接值、store data 准备 |
| MEM | load/store 访问 `dmem`；load 数据选择与扩展；store data 前递 |
| WB | 写回寄存器堆（`rd!=0` 才生效）；`ECALL` 提交并置 `halted` |

- 所有控制判断都必须以源级 `valid=1` 为前提：Taken 分支、`JAL`/`JALR` 重定向、`ECALL` 识别、load-use 暂停、前递命中均不得被无效流水线项触发。
- MEM/WB 寄存器保存最终写回值，EX 级 MEM/WB 前递直接使用该值。写回数据选择如下：

| 指令类别 | WB 写回数据 |
|---|---|
| ALU 型、`LUI` | ALU 结果（`LUI` 为 `inst[31:12] << 12`） |
| `AUIPC` | `pc + {inst[31:12], 12'b0}` |
| `LB/LH/LW/LBU/LHU` | MEM 级按字节/半字选择并扩展后的 load 数据 |
| `JAL/JALR` | 跳转指令 `pc + 4` |

- `wb_stage` 至少负责写回数据选择、寄存器堆写使能、`rd=x0` 丢弃以及 `halted` / `exit_code` 寄存器。
- 性能要求：直线 ALU 程序应达到稳态 CPI = 1；load-use 最多暂停 1 拍；Taken 控制转移最多 2 个 bubble；不得实现为逐条多周期串行状态机。
- 每个流水线寄存器均携带 valid 位；bubble / flush 一律通过清除 valid 实现，不依赖数据值。
- 流水线寄存器至少携带：PC、PC+4、指令、`rs1/rs2` 值与编号、立即数、ALU/访存/写回控制、目标寄存器号、valid。
- 每级每拍推进；PC 更新优先级为：复位 > 控制转移重定向 > `ECALL` 停机冻结 > load-use 暂停 > `PC+4`。
- 除 load-use 暂停与重定向冲刷外不得停顿，不允许逐条多周期执行。

### 7.2 数据前递

- EX 级两个源操作数 `rs1`、`rs2` 需从 EX/MEM 与 MEM/WB 前递；`x0` 不参与前递。
- 前递条件：来源有效、`reg_write=1`、`rd != 0`、且 `rd` 等于 EX 级源寄存器号。
- 优先级：EX/MEM 高于 MEM/WB。
- EX/MEM 中的 load 结果不可用于 EX 前递（load 数据在 MEM 级末才有效）；load-use 暂停保证 load 结果总是经 MEM/WB 前递。
- store data 在 MEM 级前递：若 MEM/WB 有效且其 `rd` 等于 store 的 `rs2`（且非 0、写回有效），则 `store_data` 取 MEM/WB 的写回值，否则取 EX/MEM 传来的 `rs2` 值。
- 分支比较、`JALR` 的 `rs1`、store 地址计算均使用前递后的值。
- 寄存器堆写回在 WB 级时钟沿生效；同一拍 ID 读口与 WB 写口命中同一寄存器时，读口必须返回正在写入的新值（写优先，或等价的旁路），以保证间隔 ≥3 条指令的 RAW 依赖正确。

### 7.3 Load-use 冒险

- 若 EX 级是有效 load（将在 MEM 级产生 `dmem_valid`、`rd != 0`），且 ID 级有效指令的 `rs1` 或 `rs2` 等于该 `rd`（store 的 `rs2` 见下条），则暂停一拍：冻结 PC 与 IF/ID、清除 ID/EX 的 valid（插入 bubble），不冲刷更老指令。
- 暂停解除后 load 已到 MEM/WB，通过 MEM/WB 前递供 EX 使用。
- store 的 `rs2` 依赖可用 MEM 级 store data 前递消除而不暂停；若实现仍按上条暂停，同样正确，但写出数据必须正确。
- 同一拍同时发生重定向与 load-use 暂停时，重定向优先：被暂停的指令在目标路径重新取指。

### 7.4 控制冒险

- 分支、`JAL`、`JALR` 在 EX 级解析。判定 Taken（`JAL/JALR` 恒 Taken）时：下一拍 PC 更新为目标地址，并在该时钟沿清除 IF/ID 与 ID/EX 的 valid，使更年轻的 IF、ID 两级指令不产生任何架构副作用。
- 无分支延迟槽；Taken 转移最多产生 2 个 bubble（IF、ID 两级），Not-Taken 分支不产生额外 bubble。
- `JALR` 目标依赖前递后的 `rs1`；分支 / `JAL` 目标由 EX 级 PC 与立即数计算，均在下一拍取指前给出。

## 8. 模块与文件划分

```text
rtl/rv32i5.sv           module rv32i5             // 顶层
rtl/if_stage.sv         module if_stage
rtl/id_stage.sv         module id_stage
rtl/ex_stage.sv         module ex_stage
rtl/mem_stage.sv        module mem_stage
rtl/wb_stage.sv         module wb_stage
rtl/hazard_unit.sv      module hazard_unit         // load-use 暂停 / 控制冒险 flush
rtl/forwarding_unit.sv  module forwarding_unit     // EX/MEM、MEM/WB 前递选择
```

- 上述 8 个文件必须存在、模块名一致，并由顶层 `rv32i5` 实例化使用。
- 内部端口由 Planner 在规划阶段一次性冻结；各 stage 文件之间使用同一套端口名、位宽与 valid 语义，Coder 按冻结接口逐文件实现。顶层只负责例化与连线。
- 可增加辅助模块 / 文件（如 ALU、立即数生成、寄存器堆），但不得把全部逻辑塞进顶层单个模块。
- 允许将寄存器堆放在 `id_stage` 内，或将 ALU 独立成模块；流水线寄存器建议归属于各 stage 模块。

## 9. 实现约束

- 仅使用可综合的 SystemVerilog 子集：`logic`、`always_ff`、`always_comb`、`localparam`、`function` 等；所有时序状态在 `always_ff @(posedge clk)` 中更新。
- 不使用异步复位、锁存器、`initial`、DPI、`$readmemh`、延时、外部 IP；RTL 中不使用 `include`、`package` 或 `import`（避免 Yosys/Icarus 行为分叉，跨文件常量用 `localparam` 或 parameter 传递）。
- 面向 Yosys 前端：`function` 内不使用 `return`，用过程赋值给出返回值。
- 位宽显式：立即数扩展、比较、移位均按 RV32I 语义处理，避免隐式截断。
- 面积 / 功耗优先：不做不必要的大位宽复制、不保留无用流水字段，组合路径保持简单。
- 交付为 `rtl/` 下上述文件；代码需可被 Icarus Verilog 编译、被 Yosys 综合。
## A. 高级层统一接口与优先级（L1 / L2 / L3）

本文件先给出基础架构语义，再在以下章节定义本层扩展。基础的全部 RV32I 指令、小端访存、同步复位、调试寄存器和 ECALL 最终结果要求持续有效；下述高级接口和微架构条款优先于基础 §1、§2、§3、§4 中固定五级时序、§7 的无等待限制，以及 §8 的模块划分。不要把基础的零等待接口直接套到高级层。

顶层模块仍为 `rv32i5`，端口固定如下；所有高级层都必须实现整套端口，未启用的能力事件拉低。端口无需用 `ifdef` 隐藏；教师 TB 会自动识别高级接口并使用 `RV32I_FEATURE_PORTS` 宏编译教师侧连接。

```systemverilog
module rv32i5 (
    input  logic        clk,
    input  logic        rst_n,
    output logic [31:0] imem_addr,
    input  logic [31:0] imem_rdata,
    output logic        imem_valid,
    input  logic        imem_ready,
    output logic        dmem_valid,
    output logic        dmem_we,
    output logic [31:0] dmem_addr,
    output logic [31:0] dmem_wdata,
    output logic [3:0]  dmem_be,
    input  logic [31:0] dmem_rdata,
    input  logic        dmem_ready,
    input  logic [4:0]  dbg_reg_addr,
    output logic [31:0] dbg_reg_data,
    output logic        halted,
    output logic [31:0] exit_code,
    output logic [2:0]  dbg_features,
    output logic        dbg_retire_valid,
    output logic [31:0] dbg_retire_pc,
    output logic [31:0] dbg_retire_insn,
    output logic        dbg_bp_resolve,
    output logic        dbg_bp_mispredict,
    output logic        dbg_ooo_issue,
    output logic        dbg_ooo_bypass
);
```

### A.1 外部存储器总线

- 外部端口连接 Cache 下一级的字存储器；每次事务传送 32 bit，全部地址为字节地址、字对齐。一个 Cache line 的 refill 必须由 4 个不同字地址的事务完成。
- 请求在 `valid && ready` 的上升沿接受。读返回值在该上升沿采样；`ready=0` 时读数据无效，禁止使用。
- `imem_valid && !imem_ready` 期间保持 `imem_valid=1` 与 `imem_addr` 稳定；直到一次接受沿后才可发下一字。
- `dmem_valid && !dmem_ready` 期间保持 `dmem_valid=1`、`dmem_we`、地址、字节使能和写数据稳定；外存仅在接受沿读/写一次，不能把等待拍重复当成事务。
- 同一接口至多一个请求在途；I、D 接口可以独立等待。TB 会插入确定性和变化的等待周期；不得假定 `ready` 常为 1。
- 一旦总线请求已发出，分支恢复不会撤销它；允许完成已经在途的错误路径只读取指，但其响应必须用 epoch / valid 等机制丢弃，不能进入架构提交。错误路径 store 永远不能发到总线。
- 同步复位清空 Cache valid、请求状态与全部架构/微架构有效项。复位期间输出 `imem_valid=dmem_valid=0`；复位具有最高优先级，TB 同时丢弃未接受的请求。
- 停机只发生在 ECALL 顺序提交、全部更老的 store 已得到总线确认之后。`halted=1` 时两个 valid 均为 0，寄存器、PC 和 exit_code 保持稳定。

### A.2 退休与能力观察端口

- `dbg_features` 是复位期间也稳定的能力常量：L1 为 `3'b001`，L2 为 `3'b011`，L3 为 `3'b111`。不允许动态改变或随测试程序切换。
- `dbg_retire_valid` 在每条指令真正改变已提交架构状态的上升沿为 1；同拍给出该指令的原始 `dbg_retire_pc` 与 `dbg_retire_insn`。包括 rd=x0 的指令、分支、store、NOP 与 ECALL；无效项和被冲刷指令不能退休。本课程统一每拍最多退休一条。
- 调试寄存器端口只读出已提交架构寄存器，不能读投机结果。x0 恒为 0。
- L2/L3 的 `dbg_bp_resolve` 在一条有效控制转移（条件分支、JAL、JALR）完成实际方向/目标解析的那一拍为 1；每条最多一个事件。`dbg_bp_mispredict` 是它的子集，当且仅当本条的预测下一 PC 与实际下一 PC 不同时为 1。复位/冲刷后的无效项不得计数。
- L3 的 `dbg_ooo_issue` 在一条有效指令由发射队列被功能单元真正接受的那拍为 1；`dbg_ooo_bypass` 标记其中“有更老未完成 load 时，独立的更年轻整数 ALU 指令仍被发射并完成”的事件。两者都应来自真实内部状态，不可用计数器或 PC 模式伪造。
- L1 的分支与乱序事件全部为 0；L2 的乱序事件全部为 0。`rst_n=0` 或 `halted=1` 时所有事件为 0。
- TB 综合声明、握手流量、缓存复用、预测命中和乱序旁路行为给出已验证层次。声明位仅是测试入口，不替代行为验收；内部结构容量仍属于代码/综合审查要求。

## B. L1：分离 I/D Cache

### B.1 固定组织

- I-Cache 与 D-Cache 分离，每个恰好 **256 bytes、直接映射、16-byte line、16 lines**。每行含 valid、tag、4 个 32-bit word；索引为地址 [7:4]，行内字选择为 [3:2]，tag 为 [31:8]。
- I-Cache 只读；D-Cache 为 **write-through + write-allocate**。不允许用预先知道程序的 ROM、全地址影子存储器或无容量限制的行为模型代替 Cache。
- 复位清除全部 valid；无需复位数据/tag 阵列内容。第一个 miss 必须经总线 refill；命中时返回缓存数据，不能无条件重复向外存发同一读请求。
- miss refill 按 line base、base+4、base+8、base+12 获取完整一行。全部字接收完成后该行才可置 valid。直接映射冲突必须替换原行，不能串用旧 tag 或半条新行。
- 对同一 line 的冷访问和重复访问，外部事务数量必须体现一次 refill 后的命中复用。教师 TB 会用间隔 256 bytes 的地址检查冲突替换。

### B.2 数据一致性与管线控制

- D load 命中使用缓存字，并按基础指令语义选字节/半字与扩展；D load miss 阻塞当前访存直到 refill 完成。
- D store 命中按 byte-enable 更新缓存，并发送一次 write-through 事务；miss 先 refill 目标行、合并该 store 的 byte lane，再发送一次 write-through。store 只有外存接受后才完成/退休。
- store 总线地址对齐到所在 word；SB/SH 的复制数据与 byte-enable 规则保持基础 §3.2。Cache 内被遮罩 lane 保持原值。
- 禁止丢失连续 store、重复 store、把等待态写多次，或让后续 load 读取尚未合并的旧值。I 与 D 地址空间分离；不测试自修改代码，不要求缓存一致性协议或 FENCE。
- 阻塞式 Cache miss 可以冻结相应流水线；必须完整保持 valid、PC、操作数和控制，并正确处理 miss 与分支重定向、load-use、ECALL、复位同拍发生的优先级。L1/L2 不要求非阻塞 Cache。
- Cache 命中下保持基础稳态直线 ALU CPI≈1；基础“load-use 恰好 1 拍”的绝对时序只用于零等待 L0，不能用于高级层的 miss 周期。
- 允许用独立 refill FSM；禁止在处理器整体以逐条串行的多周期 FSM 代替五级流水。

### B.3 文件要求

保留基础 8 个模块与五级流水结构，增加 `rtl/icache.sv` / `module icache` 与 `rtl/dcache.sv` / `module dcache`，由取指/访存路径实际使用；允许增加总线控制、Cache RAM 等辅助文件。Planner 必须冻结 CPU→Cache 与 Cache→外存的独立接口、miss/flush/ready 的握手关系，并让所有 Coder 文件使用同一合同。

## C. L2：动态分支预测与精确恢复

本层包含 A、B 的全部要求，`dbg_features=3'b011`。

- 在 IF 级真正使用动态预测的下一 PC，预测命中时允许前端沿正确目标提前取指。只统计分支结果、实际仍每次到 EX 才改 PC，不满足要求。
- 实现 **16-entry 直接映射 BTB**，每项含 valid、完整 PC tag、32-bit target 与控制转移类型；索引可用 PC[5:2]。至少为条件分支和 JAL/JALR 保存目标。
- 实现 **16-entry 2-bit 饱和计数器 BHT**，复位为弱不跳转 `01`；00/01 预测 Not Taken、10/11 预测 Taken。有效条件分支解析后按实际方向饱和更新；JAL/JALR 的方向不更新 BHT。
- 对 BTB hit 的条件分支，BHT Taken 时使用 BTB target；Not Taken、BTB miss 均预测 PC+4。BTB hit 的 JAL/JALR 预测 target。第一次 miss 由实际解析训练。
- 预测元数据随指令携带：原 PC、预测下一 PC、有效位，直到解析；将实际下一 PC 与本条预测值比较。方向正确但目标错误也属于误预测，必须恢复。
- 误预测时冲刷全部更年轻有效项，并取消其架构写回、store 和 ECALL；不冲刷更老的指令。预测正确的 Taken 不应再次无条件 flush 两级。
- JAL/JALR 链接值始终为本条 PC+4；前递、load-use、Cache miss 与预测恢复相遇时，按指令年龄保持精确结果。预测路径上的 ECALL 可以被前端暂时截断，但只有真正退休才允许 halted。
- 无返回地址栈要求；JALR 可由 BTB 最近目标预测。BTB alias/tag miss 必须视为 miss，不能借错其他 PC 的目标。
- 教师热循环包含约 64 次重复 taken 控制转移：预热后必须能训练，累计有效解析至少 60 次、误预测不超过 8 次；同时用方向变化、JALR 目标变化、别名和错误路径 store/ECALL 检查恢复。该局部阈值用于验证预测行为，性能报告还会给出实际误预测率与总 CPI。
- 在基础和 Cache 模块之外增加 `rtl/branch_predictor.sv` / `module branch_predictor`，由 IF/解析路径真实连接；不得依据 TB 测试名称、运行次数或固定程序地址输出能力事件。

## D. L3：寄存器重命名、乱序执行、顺序提交

本层包含 A、B、C 的全部接口、Cache 和预测要求，`dbg_features=3'b111`。本节替换基础 §1、§7、§8 对严格五级流水和固定 8 个 stage 模块的限制；ISA、结果、总线和精确状态要求仍有效。前端可保留 IF/ID，后端改为重命名/分派→选择发射→执行/写结果→ROB 提交。

### D.1 最低结构规模

- 单发射、单退休即可；必须真的允许乱序发射/完成，并以程序顺序提交。实现至少 **8 项 ROB、8 项整数发射队列、40 个物理寄存器（含 x0）、2 项 load/store 队列或等价内存队列**。
- 维护架构寄存器到物理寄存器的 speculative map 与 committed map、物理寄存器 ready 位、空闲表。目的物理寄存器在完成时写结果，但对应架构值只在 ROB head 提交时生效；退休后才安全回收旧物理寄存器。
- x0 固定映射物理零寄存器，永远 ready、值为 0，不分配新目标。RAW 等待 producer ready，WAW/WAR 通过重命名消除；被 squash 的目的寄存器不得污染恢复后的映射。
- ROB 记录本条 PC、原始指令、有效/完成、架构/物理目的、旧映射、控制转移/ECALL/store 元信息。队列满、空闲物理寄存器不足或内存队列满时正确反压分派。
- 至少独立的整数执行通路与访存通路；较老 load 等待 D-Cache refill / 外部 ready 时，允许不依赖该 load 的更年轻 ALU 指令发射并写完成结果。不得把所有单元随 miss 全局冻结。
- D-Cache 仍可 blocking，一次一个 D miss；要求的是 ALU 与该未完成 load 重叠，不要求多 miss / MSHR。Cache 模块不得把所有后端队列的推进统一关掉。

### D.2 顺序提交与内存顺序

- ROB head 完成且满足副作用条件时才退休，每拍至多一条。调试寄存器只看 committed map 的值；程序最终状态必须与按序 RV32I 执行完全一致。
- 可将 load/store 严格按程序次序进入内存执行，不要求推测性 load 或 load-store forwarding；这样仍需允许独立 ALU 越过未完成 load。
- store 在 ROB head 且所有更老控制转移已确定后才能向 D-Cache / 外存产生写副作用；byte-lane、write-through 接受与退休顺序遵循 B.2。
- 在等待较老 store 的总线确认期间不得让年轻 ECALL 退休。更年轻 load 若能提前执行，必须满足所有更老 store 的地址与数据已知、无冲突，或具有正确转发/重放机制；简化实现可直接等更老 store 完成。
- 按程序顺序处理 load/store，保持 load→store、store→load 同地址、字节/半字重叠和不同地址访问的正确结果。
- ECALL 作为 ROB 中的序列化操作，不在译码时永久停机；只有到达 ROB head 且更老项已提交并排空 store 后才设置 halted/exit_code。它和更年轻项在误预测时可以被 squash。

### D.3 控制恢复与复位

- 分支执行完成后比较本条预测/实际下一 PC；误预测只丢弃更年轻 ROB/IQ/LSQ 项，并恢复正确重命名映射与空闲物理寄存器。
- 允许 checkpoint，也允许从 committed map 加上仍保留的更老 ROB 项重建 speculative map；必须避免把尚未提交的正确更老结果丢失，不能简化为清空全部 ROB。
- 已开始的错误路径只读取指事务可完成后丢弃；错误路径寄存器结果不可提交、store 不可写外存、ECALL 不可停机。
- 同步复位清空全部队列有效位、重命名/ready/free-list 状态、Cache valid 与预测状态，并恢复 32 个架构寄存器为 0、PC=0。`rst_n=0` 时不能向外存发请求或输出能力事件。
- TB 会用 load miss + 独立 ALU、RAW/WAW/WAR 链、队列压力、分支恢复与错误路径 store/ECALL 提供行为证据；`dbg_ooo_bypass` 必须与真实 miss 等待和独立年轻 ALU 发射/完成对应。容量与真正重命名结构还须接受代码/综合审查，有限黑盒用例不能证明任意内部实现。

### D.4 文件与实现

顶层 `rtl/rv32i5.sv` 只做连接与全局控制；必须把 `icache`、`dcache`、`branch_predictor`、`rename_unit`、`issue_queue`、`reorder_buffer`、`load_store_unit` 拆为相应同名 `rtl/*.sv` 文件与模块并实际使用。可增加 fetch/decode/ALU/PRF/ROB 恢复辅助模块；高级模块端口由 Planner 一次冻结。所有结构使用有限数组与可综合逻辑，不使用类、动态队列、DPI、initial、延时或外部 IP。

本课程不增加异常、CSR、中断、RV32M、压缩指令或虚拟内存要求；复杂度来自微架构状态、握手、推测恢复与并发执行的组合。

## E. 共用教师 TB 与性能报告

- 所有层复用 `content/tasks/homework_rv32i5/tb.sv` 入口；教师代码可按时钟/存储器、编码器/汇编器、基础 ISA 测试、Cache、预测、乱序、性能负载分文件维护。模型只交付 RTL，不修改教师文件。
- 教师根据高级端口和固定能力声明选择扩展观察合同，继续执行基础 ISA/前递等结果测试，再叠加相应扩展测试。所有已声明层的必要测试都必须通过，才能获得该层通过结果；基础 PASS 不等于高级层通过。
- 测试报告分别保留目标层、声明层、行为验证层、每组检查结果和性能数据，便于把“实现了更复杂结构”与“复杂结构有效加速”分别讨论。
- 性能以真实工作负载运行到 ECALL 计算周期数、退休指令数、CPI/IPC、有效外存事务、预测解析/误预测和乱序重叠事件；同时报告已有面积/功耗评估。
- 使用同一 ISA、相同程序与内存等待方案比较层级。不能直接把零等待 L0 的周期与带延迟总线高级层当成缓存收益；必须同时说明各场景内存模型。
- 教学性能负载覆盖整数循环、分支、链表/数组访存和整数算法。若使用 CoreMark 风格内核，它是教学缩小负载，结果不能标为官方 CoreMark 分数；只有完整官方源码、合规编译/运行与计分条件都满足才可报告该名称的正式分数。
- 不要求某层在所有程序上都更快；必须正确报告实际结果与复位/预热是否计入。禁止对固定 benchmark、程序长度、地址、预期结果或运行次数硬编码行为。

