# 课后作业：单模块 AES-128 加密核（面积 / 功耗优化）

## 任务目标

用**一个** SystemVerilog 模块实现 AES-128 加密（FIPS-197）。算法内部可以拆成状态机、密钥扩展、S-box、行移位、列混合等多个层次，但所有逻辑必须写在同一个 `module` 内完成。

本题不提供 Prompt 模板，也没有分阶段 Prompt。学生需要自己写一条完整 Prompt（可包含算法分解、接口约束、实现方案对比和面积优化思维链），填入工作台「课后作业」页面的 Prompt 编辑器。

## 模块接口（必须完全一致）

```systemverilog
module aes128 (
    input  logic         clk,
    input  logic         rst_n,
    input  logic         start,
    input  logic [127:0] key,
    input  logic [127:0] plaintext,
    output logic         ready,
    output logic         done,
    output logic [127:0] ciphertext
);
```

## 数据表示与 AES 字节序（重要）

- `key`、`plaintext`、`ciphertext` 都是 128-bit FIPS-197 向量：**最左侧（最高有效）字节是 byte 0**，对应位 `[127:120]`；byte 1 对应 `[119:112]`，依次到 byte 15 对应 `[7:0]`。
- AES 状态矩阵采用 FIPS-197 的列优先排列：`state[r][c] = byte[4*c + r]`，其中 `r,c = 0..3`。例如 `plaintext = 00112233445566778899aabbccddeeff` 表示 `state[0][0]=8'h00`、`state[1][0]=8'h11`、`state[2][0]=8'h22`、`state[3][0]=8'h33`、`state[0][1]=8'h44`，依此类推。
- 输出 `ciphertext[127:120]` 必须是加密结果的 byte 0，输出顺序与输入约定相同，不需要额外交换字节。
- 密钥字同样按大端解释：`w0 = key[127:96] = 00010203`，`w1 = key[95:64] = 04050607`，`w2 = key[63:32] = 08090a0b`，`w3 = key[31:0] = 0c0d0e0f`。

## 握手与复位时序（必须严格满足）

1. **复位**：`rst_n` 是同步低有效复位，只在 `clk` 上升沿生效。`rst_n` 在两个上升沿之间变化时，寄存器输出必须保持原值；在上升沿采样到 `rst_n=0` 时，`done` 在该沿清 0、内部状态清空。复位后（复位释放后的第一个上升沿）模块处于空闲：`ready=1`、`done=0`。复位期间 `start` 被忽略；`ciphertext` 在非 `done` 周期不要求有效。
2. **接收**：`ready=1` 表示空闲。`start && ready` 在 `clk` 上升沿成立时，模块在该沿采样 `key` 与 `plaintext` 并开始一次加密；从该沿的下一拍起 `ready` 必须为 0，忙碌期间必须忽略新的 `start`。
3. **完成**：加密完成后 `done` 必须拉高**恰好一个时钟周期**，且该周期 `ciphertext` 有效、`ready=0`。`done` 之后的下一个上升沿起，`done=0` 且 `ready=1`，并在该拍能够立刻接受下一次 `start`（支持背靠背加密，不要求额外气泡）。
4. **输出保持**：`done=1` 周期内 `ciphertext` 必须稳定；`done=0` 时 `ciphertext` 可以为任意值，教师 TB 只在 `done` 周期采样。
5. **延迟上限**：从接收 `start` 的时钟沿（不含该沿）到 `done` 为高的时钟沿（含该沿），最多 200 个时钟周期。教师 TB 在 `start` 之后最多等待 200 个时钟沿。
6. **反压/流控**：本题只有一个输出握手（`done`），没有 `out_ready`。模块内部可按任意方案暂停计算；但单次加密必须在 200 周期内完成。
7. `clk` 在教学中按 10 ns 周期（100 MHz）驱动；本题不涉及跨时钟域。

## 功能定义

实现标准 AES-128 加密（FIPS-197）：

- **初始轮**：`state = plaintext XOR {w0,w1,w2,w3}`。
- **第 1–9 轮**：`SubBytes → ShiftRows → MixColumns → AddRoundKey`，第 r 轮使用轮密钥 `w[4r..4r+3]`。
- **第 10 轮**：`SubBytes → ShiftRows → AddRoundKey`（不做 MixColumns）。
- `SubBytes`：对每个字节查标准 AES S-box。下表是**正确性基准**（行是字节高 4 位、列是低 4 位）：采用查表实现时必须逐字节照抄；若尝试用组合逻辑/GF 反演做面积优化，必须保证每个输入对应的输出都与下表完全一致（手写反演极易出错，建议先保证正确再考虑优化）：

```text
     0 1 2 3 4 5 6 7 8 9 a b c d e f
0x00   63 7c 77 7b f2 6b 6f c5 30 01 67 2b fe d7 ab 76
0x10   ca 82 c9 7d fa 59 47 f0 ad d4 a2 af 9c a4 72 c0
0x20   b7 fd 93 26 36 3f f7 cc 34 a5 e5 f1 71 d8 31 15
0x30   04 c7 23 c3 18 96 05 9a 07 12 80 e2 eb 27 b2 75
0x40   09 83 2c 1a 1b 6e 5a a0 52 3b d6 b3 29 e3 2f 84
0x50   53 d1 00 ed 20 fc b1 5b 6a cb be 39 4a 4c 58 cf
0x60   d0 ef aa fb 43 4d 33 85 45 f9 02 7f 50 3c 9f a8
0x70   51 a3 40 8f 92 9d 38 f5 bc b6 da 21 10 ff f3 d2
0x80   cd 0c 13 ec 5f 97 44 17 c4 a7 7e 3d 64 5d 19 73
0x90   60 81 4f dc 22 2a 90 88 46 ee b8 14 de 5e 0b db
0xa0   e0 32 3a 0a 49 06 24 5c c2 d3 ac 62 91 95 e4 79
0xb0   e7 c8 37 6d 8d d5 4e a9 6c 56 f4 ea 65 7a ae 08
0xc0   ba 78 25 2e 1c a6 b4 c6 e8 dd 74 1f 4b bd 8b 8a
0xd0   70 3e b5 66 48 03 f6 0e 61 35 57 b9 86 c1 1d 9e
0xe0   e1 f8 98 11 69 d9 8e 94 9b 1e 87 e9 ce 55 28 df
0xf0   8c a1 89 0d bf e6 42 68 41 99 2d 0f b0 54 bb 16
```
- `ShiftRows`：`state'[r][c] = state[r][(c + r) mod 4]`（第 r 行循环左移 r 字节）。
- `MixColumns`：对每一列左乘固定矩阵
  `[[2,3,1,1], [1,2,3,1], [1,1,2,3], [3,1,1,2]]`，其中乘 2 使用 GF(2⁸) 的 `xtime`（多项式 `x^8+x^4+x^3+x+1`，即 `0x11b`）。
- **密钥扩展**：按 FIPS-197 生成 `w[0..43]`。`w[i] = w[i-4] XOR temp`；当 `i % 4 == 0` 时 `temp = SubWord(RotWord(w[i-1])) XOR Rcon[i/4]`，`Rcon[1..10] = 01,02,04,08,10,20,40,80,1b,36`；其余情况 `temp = w[i-1]`。
- 只做加密，不做解密。

**吞吐可行性提示**：16 字节 × 10 轮 = 160 次数据 SubBytes，加上密钥扩展每轮 4 字节共 40 次，一共约 200 次 S-box 计算。要在 200 周期内完成，至少需要 2 个 S-box 实例（再考虑列更新与握手开销，通常 4 个或按列并行更稳妥）；只用一个 S-box 顺序处理一定超时。追求低面积时请同时检查这条时间下限。

公开测试向量（教师 TB 还会检查其他标准向量与连续加密）：

```text
# FIPS-197 附录 C.1
key        = 000102030405060708090a0b0c0d0e0f
plaintext  = 00112233445566778899aabbccddeeff
ciphertext = 69c4e0d86a7b0430d8cdb78070b4c55a

# 全零向量
key        = 00000000000000000000000000000000
plaintext  = 00000000000000000000000000000000
ciphertext = 66e94bd4ef8a2c3b884cfa59ca342b2e

# FIPS-197 附录 B 示例
key        = 2b7e151628aed2a6abf7158809cf4f3c
plaintext  = 3243f6a8885a308d313198a2e0370734
ciphertext = 3925841d02dc09fbdc118597196a0b32
```

教师 TB 会检查上述三组向量、其中一组的重复加密、忙时复位和连续两次加密；实现必须对任意符合接口的输入通用，不能对测试向量硬编码。

## 实现与可综合性约束

- **只允许一个 module**：不得例化任何其他模块（包括自身），不得使用 `include`、`$readmemh`、外部文件、IP 或 DPI。`function`、`task`、`generate`、多个 `always` 块均可在模块内部使用；函数之间可以互相调用。
- 不得修改端口名称、位宽或方向。
- 综合与仿真必须同时满足：功能 TB 使用 `iverilog -g2012` 编译，面积/功耗 metric 使用 Yosys 0.70 映射到课程标准单元库。请使用其支持的 Verilog-2005/有限 SystemVerilog 子集：`logic`、`always_ff`、`always_comb`、`typedef enum`、`localparam`、`function` 均可用。
- 已知 Yosys 前端限制：**函数内部不要使用 SystemVerilog 的 `return`**，请用 Verilog-2005 风格在函数体内给函数名赋值；避免动态数组、class、interface、assertion、`$readmemh` 等综合不支持的写法。否则功能 TB 可能通过，但 metric 会显示 SYNTH FAILED。
- 复位必须为同步低有效；`start`、`ready`、`done` 的握手语义必须严格满足上文协议。
- 教师 TB 与功耗测试脚本位于 `content/tasks/homework_aes128/`，学生不得修改。

## 面积与功耗评估口径

- **功能验收**：`tb.sv` 检查复位/握手、FIPS 标准向量、连续加密、忙时复位、`done` 单脉冲与 200 周期上限。
- **面积**：`synthesize_metrics` 用 Yosys 的 `read_verilog -sv → hierarchy → proc/opt/fsm/memory/techmap → dfflibmap/abc` 流程映射到课程 `gscl45nm` 标准单元库，报告 chip area（包含寄存器、组合逻辑与复位/多路选择逻辑）。
- **功耗**：教师功耗脚本 `power_tb.sv` 在复位后连续执行 12 组不同 key/plaintext 的加密：每次等待 `ready=1` 后拉高 `start` 一拍，组间不插入额外空闲，生成覆盖整个仿真的 `activity.vcd`；OpenSTA 在 10 ns 时钟约束下读取门级网表、Liberty 与 VCD，报告 internal / switching / leakage / total power。该结果是前布局、无寄生参数的估算，仅用于同一工具/库/脚本下的相对比较。
- 这两个脚本和综合流程是固定的；学生只提交 `aes128` 模块源码。每次运行都会保存 `test_report.json`，其中包含 `passed`、trace 与 `metrics`。

## 面积与功耗优化建议

建议在 Prompt 中主动设计面积优化思维链，至少比较：

1. S-box 实现方式：256×8 查表、组合逻辑反演或分段实现；
2. 密钥扩展：存储 11 组轮密钥、按轮在线展开或复用寄存器；
3. 轮函数结构：全展开、单轮迭代或多轮并行，及其对面积/吞吐的影响；
4. `MixColumns`：常量乘法 `xtime` 复用、字节级共享加法；
5. 寄存器复用与无效翻转：避免整块状态无意义翻转、减少宽多路选择器与冗余计数器。

评分会同时考虑功能是否通过教师 TB，以及相同模型配置下多次独立运行的面积/功耗 metric。功能不通过的实现不参与面积/功耗比较。
