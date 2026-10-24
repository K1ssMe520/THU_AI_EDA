# 课堂演示任务：ready-valid 重叠序列检测器

实现唯一模块 `seq1011`。提交物必须是 SystemVerilog RTL，端口必须完全一致：

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

功能与协议：

1. 仅在 `in_valid && in_ready` 的上升沿接收一个串行输入 bit。
2. 检测允许重叠的模式 `1011`。若刚接收的 bit 使最近四个已接收 bit 为 `1011`，该 bit 对应的 `match` 为 1；否则为 0。输入 `1011011` 的对应输出必须为 `0001001`。
3. 每笔已接收输入恰好产生一笔输出。无反压时，输入于上升沿 `N` 被接收，则其结果在 `N+1` 后以 `out_valid=1` 可见；无反压时允许每周期接收和输出一笔。
4. `out_valid && out_ready` 的上升沿完成一次输出传输。`out_valid=1 && out_ready=0` 时，`out_valid` 和 `match` 必须保持稳定；不得丢失、重复或重排输出。
5. `rst_n=0` 是同步低有效复位：仅在 `clk` 上升沿生效，清空检测历史和所有在途输出，并令 `out_valid=0`。

输出要求：只输出一个名为 `seq1011` 的模块，不要输出 testbench、解释文字或 Markdown 围栏。
