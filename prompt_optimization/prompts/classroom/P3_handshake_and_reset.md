实现 SystemVerilog 模块 `seq1011`。最终输出只能包含该模块的 RTL 源码；不要输出 Markdown、解释、testbench 或外部模块。

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

输入握手：仅当 `in_valid && in_ready` 在 `clk` 上升沿成立时接收一个输入 bit。

输出握手：通过 `out_valid && out_ready` 传输结果；`out_valid=1` 表示 `match` 有效。

功能：检测允许重叠的序列 `1011`；若刚接收的 bit 使最近四个已接收 bit 为 `1011`，该 bit 对应的 `match` 为 1，否则为 0。

复位：`rst_n` 是低有效复位，复位时清空检测历史与在途输出，并使 `out_valid=0`。
