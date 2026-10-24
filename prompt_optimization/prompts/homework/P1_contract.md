请实现 SystemVerilog 模块 `sync_fifo`，只输出可编译的 RTL 源码，不要 Markdown、解释或 testbench。

冻结规格如下，必须完整遵守：

```systemverilog
module sync_fifo (
    input logic clk, input logic rst_n,
    input logic wr_valid, output logic wr_ready, input logic [7:0] wr_data,
    output logic rd_valid, input logic rd_ready, output logic [7:0] rd_data
);
```

FIFO 深度固定为 4，数据宽度为 8 位，按先进先出顺序传输。`wr_valid && wr_ready` 的上升沿写入一项，`rd_valid && rd_ready` 的上升沿读出一项。写入前 FIFO 未满时 `wr_ready=1`；FIFO 已满时，即使同周期存在读取，`wr_ready` 仍必须为 0。读取前 FIFO 非空时 `rd_valid=1`；FIFO 为空时，即使同周期写入，也不得旁路输出，新数据从下一周期开始才可读。读端停顿，即 `rd_valid=1 && rd_ready=0` 时，`rd_valid` 和 `rd_data` 必须保持稳定。合法的同时读写必须保持占用数和数据顺序正确。`rst_n=0` 为同步低有效复位；复位后 FIFO 为空、`rd_valid=0`、`wr_ready=1`，无需清除存储阵列。

不要修改端口、不要引入额外模块或外部依赖。
