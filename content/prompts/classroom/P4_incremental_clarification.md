在上一版 `seq1011` 的基础上补充以下细节，其余接口与功能保持不变。最终输出只能包含该模块的 RTL 源码；不要输出 Markdown、解释、testbench 或外部模块。

补充需求：

1. 每个被接收的 bit 恰好产生一笔输出，且输出延迟必须严格为 1 个时钟周期，输出由寄存器驱动：
   - 在上升沿 N 接收一个 bit 时，本拍只计算该 bit 的匹配结果并存入“待输出”寄存器；这一拍**不得拉高 `out_valid`**，也不得改变当前输出侧的 `out_valid`/`match`。
   - 在上升沿 N+1 才把“待输出”结果搬入输出寄存器，使 N+1 上升沿之后（教师 TB 在上升沿后 1 ns 采样）读到该 bit 对应的 `out_valid=1` 与 `match`。
   - 连续输入 b0、b1、b2 且无反压时：周期 N 接收 b0 且 `out_valid=0`；周期 N+1 接收 b1 且 `out_valid=1`、`match` 为 b0 的结果；周期 N+2 接收 b2 且 `out_valid=1`、`match` 为 b1 的结果。
   - 禁止零延迟实现（接收同一拍就把 `out_valid` 置 1，或直接组合输出 `match`）；无反压时必须支持每周期接收一笔并传输一笔。
2. `out_valid=1 && out_ready=0` 时，`out_valid` 与 `match` 必须保持稳定；允许因输出反压暂停输入，但不得丢失、重复或重排结果。
3. `rst_n` 必须是同步低有效复位：只有在 `clk` 上升沿采样到 `rst_n=0` 时才清空检测历史与所有在途输出，并使 `out_valid=0`；`rst_n` 在两个时钟上升沿之间变化时，所有寄存器输出必须保持原值。
4. 时序块只能以 `posedge clk` 作为敏感事件，禁止 `posedge clk or negedge rst_n` 等异步复位写法。
5. 可编译性：教师 TB 使用 `iverilog -g2012` 编译。请避免 `typedef enum`，尤其不要用三目表达式给枚举变量赋值（例如 `next_state = cond ? S1 : S0;` 会触发 “requires an explicit cast”）；状态寄存器请使用 `logic [1:0]` 配合 `localparam` 编码，确保生成的 RTL 能直接被 iverilog 编译。

生成前请自查：接收 bit 的那一拍 `out_valid` 不能变成 1，对应 `match` 必须到下一拍才可见；如果你在接收同拍拉高 `out_valid`，教师 TB 会报 `one_cycle_latency_no_early_output` 失败。 另外必须逐条确认：`in_ready`、`out_valid`、`match` 三个输出端口都被明确驱动（不得只有内部寄存器而没有连接输出端口）；状态编码不要用 `typedef enum`；复位同时清空状态与输出寄存器。

接口必须与下列定义完全一致：

```systemverilog
module seq1011 (
    input  logic clk,
    input  logic rst_n,
    input  logic in_valid,
    output logic in_ready,
    input  logic in_bit,
    output logic out_valid,
    input  logic out_ready,
    output logic match
);
```

其余行为沿用上一版：仅当 `in_valid && in_ready` 在 `clk` 上升沿成立时接收一个输入 bit；检测允许重叠的序列 `1011`，若刚接收的 bit 使最近四个已接收 bit 为 `1011`，该 bit 对应的 `match` 为 1，否则为 0；输入 `1011011` 的输出依次为 `0001001`。
