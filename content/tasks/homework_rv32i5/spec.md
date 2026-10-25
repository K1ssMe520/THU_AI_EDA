# 课后作业：RV32I 五级流水线处理器

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
