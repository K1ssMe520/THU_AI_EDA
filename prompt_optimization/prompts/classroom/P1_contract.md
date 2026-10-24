编写一个可编译的 SystemVerilog 模块 `seq1011`。最终输出只能包含该模块的 RTL 源码；不得输出 Markdown、说明文字、testbench 或其他模块。

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

仅当 `in_valid && in_ready` 在 `clk` 上升沿成立时接收一个输入 bit。对每一个被接收的输入，都必须产生且只产生一个输出结果。检测允许重叠的序列 `1011`：若该输入使最近四个已接收 bit 恰为 `1011`，其结果 `match` 为 1，否则为 0。连续输入 `1011011` 的结果依次为 `0001001`。

接收发生在时钟上升沿 N 时，结果必须在 N+1 上升沿后以 `out_valid=1` 和对应的 `match` 给出。无反压时必须支持每周期接收一个输入并传输一个输出。输出仅在 `out_valid && out_ready` 的上升沿被消费；当 `out_valid=1 && out_ready=0` 时，`out_valid` 与 `match` 必须保持稳定。允许因输出反压暂停输入，但不得丢失、重复或重排结果。

`rst_n` 是同步低有效复位。仅在 `clk` 上升沿且 `rst_n=0` 时清空检测历史和所有在途输出，并使 `out_valid=0`。不得使用异步复位敏感列表，不得修改端口或引用外部模块。
