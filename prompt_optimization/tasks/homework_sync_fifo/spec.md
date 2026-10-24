# 课后任务：4×8 同步 ready-valid FIFO

实现唯一模块 `sync_fifo`。提交物必须是 SystemVerilog RTL，模块端口必须与下列定义完全一致：

```systemverilog
module sync_fifo (
    input  logic clk,
    input  logic rst_n,
    input  logic wr_valid,
    output logic wr_ready,
    input  logic [7:0] wr_data,
    output logic rd_valid,
    input  logic rd_ready,
    output logic [7:0] rd_data
);
```

功能与协议：

1. FIFO 深度固定为 4，数据宽度为 8 位，先进先出。
2. `wr_valid && wr_ready` 的上升沿写入一项；`rd_valid && rd_ready` 的上升沿读出一项。
3. `wr_ready=1` 当且仅当写入**前** FIFO 未满；FIFO 满时，即便同一周期存在读取，`wr_ready` 仍为 0。
4. `rd_valid=1` 当且仅当读取**前** FIFO 非空。空 FIFO 在同一周期写入时不得旁路输出；新数据从下一周期开始可读。
5. 当 `rd_valid=1 && rd_ready=0` 时，`rd_valid` 与 `rd_data` 必须保持稳定。
6. 空、满与中间状态下均允许合法的同时读写；同时读写时 FIFO 占用数不变且顺序正确。
7. `rst_n=0` 为同步低有效复位。复位后 FIFO 为空，`rd_valid=0`、`wr_ready=1`。无需清除存储阵列内容。

输出要求：只输出一个名为 `sync_fifo` 的模块，不要输出 testbench、解释文字或 Markdown 围栏。
