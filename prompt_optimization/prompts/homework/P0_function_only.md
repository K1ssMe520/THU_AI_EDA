实现可编译的 SystemVerilog 模块 `sync_fifo`。只输出一个 RTL 模块；不要输出 Markdown、解释、testbench 或外部模块。

```systemverilog
module sync_fifo (
    input logic clk, input logic rst_n,
    input logic wr_valid, output logic wr_ready, input logic [7:0] wr_data,
    output logic rd_valid, input logic rd_ready, output logic [7:0] rd_data
);
```

FIFO 深度固定为 4，数据宽度为 8 位，按先进先出顺序传输。仅当 `wr_valid && wr_ready` 在上升沿成立时写入；写入前未满时 `wr_ready=1`，已满时即使同周期读取也必须为 0。仅当 `rd_valid && rd_ready` 在上升沿成立时读取；读取前非空时 `rd_valid=1`，为空时即使同周期写入也不得旁路读取。读端反压时 `rd_valid` 和 `rd_data` 必须稳定。合法同周期读写保持占用数不变且顺序正确。`rst_n` 为同步低有效复位；复位后 FIFO 为空、`rd_valid=0`、`wr_ready=1`，无需清除存储阵列。不得修改接口或实现异步复位。
