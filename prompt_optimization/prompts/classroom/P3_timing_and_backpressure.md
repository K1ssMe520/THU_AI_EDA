实现可编译的 SystemVerilog 模块 `seq1011`。最终输出只能是一个 RTL 模块；不要输出 Markdown、解释、testbench 或外部模块。

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

模块在输入 ready-valid 接口上接收串行 bit。仅当 `in_valid && in_ready` 在 `clk` 上升沿为真时，才接收 `in_bit`。每个已接收 bit 恰好对应一笔输出。若该 bit 使最近四个已接收 bit 为 `1011`，对应输出的 `match=1`；否则 `match=0`。匹配必须支持重叠，因此输入 `1011011` 的输出依次为 `0001001`。

在上升沿 N 接收的输入，必须在 N+1 上升沿后以 `out_valid=1` 和对应 `match` 提供。无反压时，模块必须能够每周期接收一笔输入并传输一笔输出。`out_valid && out_ready` 在上升沿完成一次输出传输。若 `out_valid=1 && out_ready=0`，`out_valid` 和 `match` 必须保持不变；允许暂停输入，但不得丢失、重复或重排任何输入对应的结果。

`rst_n` 是同步低有效复位：仅在 `clk` 上升沿且 `rst_n=0` 时清空模式历史与所有在途输出，并使 `out_valid=0`。不得使用 `@(posedge clk or negedge rst_n)` 或任何异步复位写法。不得修改接口。
