实现可编译的 SystemVerilog 模块 `seq1011`。最终输出只能包含一个 RTL 模块；不要输出 Markdown、解释、testbench 或外部模块。

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

仅当 `in_valid && in_ready` 在 `clk` 上升沿为真时接收 `in_bit`。检测允许重叠的 `1011`；每个被接收 bit 必须产生一笔且仅一笔结果。该 bit 结束的最近四个已接收 bit 为 `1011` 时，结果 `match=1`，否则为 0。输入 `1011011` 对应结果为 `0001001`。在上升沿 N 接收的 bit，必须在 N+1 上升沿后以 `out_valid=1` 和对应 `match` 提供。无反压时支持每周期接收和输出一笔。

输出只在 `out_valid && out_ready` 的上升沿被消费。若 `out_valid=1 && out_ready=0`，`out_valid` 和 `match` 必须保持稳定；可以暂停输入，但不得丢失、重复或重排结果。

`rst_n` 是同步低有效复位。只有 `clk` 上升沿采样到 `rst_n=0` 时才清空模式历史和在途输出，并令 `out_valid=0`。`rst_n` 在两个时钟上升沿之间变化时，所有寄存器输出必须保持原值。时序块只能以 `posedge clk` 为敏感事件；禁止 `posedge clk or negedge rst_n` 等异步复位写法。不得修改接口。
