请实现 SystemVerilog 模块 `sync_fifo`，只输出一个可编译的 RTL 模块，不要 Markdown、解释或 testbench。

冻结契约如下：模块端口为 `clk`、同步低有效复位 `rst_n`、写端 `wr_valid/wr_ready/wr_data[7:0]`、读端 `rd_valid/rd_ready/rd_data[7:0]`。FIFO 深度固定为 4、按先进先出顺序传输。写入在 `wr_valid && wr_ready` 的上升沿发生，且 `wr_ready` 当且仅当写入前未满；满 FIFO 同周期读取时仍拒绝写入。读取在 `rd_valid && rd_ready` 的上升沿发生，且 `rd_valid` 当且仅当读取前非空；空 FIFO 同周期写入时不得旁路读取。读端反压时 rd_valid 和 rd_data 必须保持稳定；合法同时读写保持占用数不变与顺序正确；复位后 FIFO 为空、rd_valid 为 0、wr_ready 为 1。

实现前请在内部逐项核对：端口与信号方向、深度 4、写入和读取的握手条件、空满时 ready/valid 的组合行为、同周期读写、读端反压保持，以及同步低有效复位。不要把该检查过程输出。

最终 RTL 必须严格遵守该规格，不得改接口、加入旁路语义或依赖外部模块。
