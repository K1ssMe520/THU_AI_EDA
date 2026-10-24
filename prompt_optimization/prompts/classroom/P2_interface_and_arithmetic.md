实现可编译的 SystemVerilog 模块 `seq1011`。只输出一个 RTL 模块；不得输出 Markdown、解释、testbench 或外部模块。

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

功能定义如下。

1. 仅在 `in_valid && in_ready` 的 `clk` 上升沿接收 `in_bit`。
2. 检测可重叠的模式 `1011`。每个被接收的 bit 对应一个结果；当且仅当该 bit 结束的最近四个已接收 bit 为 `1011` 时，对应 `match=1`。输入 `1011011` 对应结果为 `0001001`。
3. 在上升沿 N 接收输入后，必须在 N+1 上升沿后提供该结果。无反压时，输入和输出均可每周期各传输一笔。
4. `out_valid && out_ready` 在上升沿传输一个结果。若 `out_valid=1 && out_ready=0`，`out_valid` 和 `match` 必须保持稳定。可以停止接收输入，但不得丢失、重复或改变结果顺序。
5. `rst_n=0` 是同步低有效复位；仅在 `clk` 上升沿生效。复位清空历史与在途输出，且使 `out_valid=0`。不得把 `rst_n` 加入敏感列表。

不得改变接口、引入外部依赖或实现异步复位。
