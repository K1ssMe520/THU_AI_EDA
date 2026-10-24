实现低面积、可编译的 SystemVerilog 模块 `seq1011`。最终输出只能是一个 RTL 模块；不要输出 Markdown、解释、推导过程、testbench 或外部模块。

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

仅在 `in_valid && in_ready` 的 `clk` 上升沿接收 `in_bit`。每个被接收的 bit 必须产生且只产生一笔输出。检测可重叠模式 `1011`：当该 bit 结束的最近四个已接收 bit 为 `1011` 时，对应 `match=1`，否则为 0。输入 `1011011` 对应输出为 `0001001`。在上升沿 N 接收的输入，必须在 N+1 上升沿后以 `out_valid=1` 和对应 `match` 给出。无反压时必须支持每周期接收一笔并传输一笔。

输出仅在 `out_valid && out_ready` 的上升沿被消费。若 `out_valid=1 && out_ready=0`，`out_valid` 和 `match` 必须保持稳定；可暂停输入，但不得丢失、重复或重排输出。`rst_n` 是同步低有效复位：仅在 `clk` 上升沿且 `rst_n=0` 时清空模式历史与在途输出，并令 `out_valid=0`。禁止异步复位写法。

采用表示“已接收历史中同时是 `1011` 前缀的最长后缀”的最小状态机；完成一次 `1011` 匹配后必须保留后缀 `1`。输出握手缓冲与模式状态必须独立，确保反压时 `match` 不变。只在输入握手成功时更新模式状态。不要使用宽于必要的寄存器、计数器、存储阵列或时钟门控。
