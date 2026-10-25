`timescale 1ns/1ps

// 仅用于功耗 / 活动采样，不承担功能验收（与 tb_homework_rv32i5 相互独立）。
// 顶层命名与 stream_filter 项目的 tb_power_agent_stream_filter 保持一致。
// 程序为一个包含 ALU、load/store、条件分支与 JAL 的死循环，用于产生持续的
// 流水线翻转活动；固定周期数后结束，不依赖 halted。
module tb_power_agent_rv32i5;
  logic clk   = 1'b0;
  logic rst_n = 1'b0;

  logic [31:0] imem_addr;
  logic [31:0] imem_rdata;
  logic        dmem_valid;
  logic        dmem_we;
  logic [31:0] dmem_addr;
  logic [31:0] dmem_wdata;
  logic [3:0]  dmem_be;
  logic [31:0] dmem_rdata;
  logic [4:0]  dbg_reg_addr = 5'd0;
  logic [31:0] dbg_reg_data;
  logic        halted;
  logic [31:0] exit_code;

`ifdef RV32I_FEATURE_PORTS
  wire imem_valid;
  wire imem_ready = 1'b1;
  wire dmem_ready = 1'b1;
  wire [2:0] dbg_features;
  wire dbg_retire_valid;
  wire [31:0] dbg_retire_pc, dbg_retire_insn;
  wire dbg_bp_resolve, dbg_bp_mispredict;
  wire dbg_ooo_issue, dbg_ooo_bypass;
`endif

  rv32i5 dut (.*);
  always #5 clk = ~clk;

  localparam integer IMEM_WORDS = 64;
  localparam integer DMEM_BYTES = 4096;

  logic [31:0] imem [0:IMEM_WORDS-1];
  logic [7:0]  dmem [0:DMEM_BYTES-1];
  logic [11:0] dmem_word_base;

  assign dmem_word_base = {dmem_addr[11:2], 2'b00};
  assign imem_rdata = imem[imem_addr[7:2]];
  assign dmem_rdata = {
    dmem[dmem_word_base + 12'd3],
    dmem[dmem_word_base + 12'd2],
    dmem[dmem_word_base + 12'd1],
    dmem[dmem_word_base + 12'd0]
  };

  // 与教师 TB 一致的数据存储器写模型：dmem_valid && dmem_we 的上升沿逐字节写入
  always @(posedge clk) begin
    if (dmem_valid === 1'b1 && dmem_we === 1'b1) begin
      if (dmem_be[0] === 1'b1) dmem[dmem_word_base]          <= dmem_wdata[7:0];
      if (dmem_be[1] === 1'b1) dmem[dmem_word_base + 12'd1] <= dmem_wdata[15:8];
      if (dmem_be[2] === 1'b1) dmem[dmem_word_base + 12'd2] <= dmem_wdata[23:16];
      if (dmem_be[3] === 1'b1) dmem[dmem_word_base + 12'd3] <= dmem_wdata[31:24];
    end
  end

  // 活动程序（机器码由教师 TB 的同一套 RV32I 编码规则生成）：
  //   addi x1, x0, 0x200
  //   addi x2, x0, 0
  //   addi x3, x0, 300
  // LOOP:
  //   addi x2, x2, 1
  //   add  x4, x2, x1
  //   sw   x4, 0(x1)
  //   lw   x5, 0(x1)
  //   add  x6, x5, x4
  //   xor  x7, x6, x2
  //   slli x8, x7, 3
  //   srli x9, x8, 1
  //   or   x11, x9, x7
  //   and  x12, x11, x6
  //   slt  x13, x12, x2
  //   blt  x2, x3, LOOP
  //   addi x2, x0, 0
  //   jal  x0, LOOP
  task automatic load_activity_program();
    integer i;
    begin
      for (i = 0; i < IMEM_WORDS; i = i + 1) imem[i] = 32'h0000_0013; // NOP
      imem[0]  = 32'h2000_0093;
      imem[1]  = 32'h0000_0113;
      imem[2]  = 32'h12C0_0193;
      imem[3]  = 32'h0011_0113;
      imem[4]  = 32'h0011_0233;
      imem[5]  = 32'h0040_A023;
      imem[6]  = 32'h0000_A283;
      imem[7]  = 32'h0042_8333;
      imem[8]  = 32'h0023_43B3;
      imem[9]  = 32'h0033_9413;
      imem[10] = 32'h0014_5493;
      imem[11] = 32'h0074_E5B3;
      imem[12] = 32'h0065_F633;
      imem[13] = 32'h0026_26B3;
      imem[14] = 32'hFC31_4AE3;
      imem[15] = 32'h0000_0113;
      imem[16] = 32'hFCDF_F06F;
    end
  endtask

  string  vcd_path;
  integer i;

  initial begin
    if (!$value$plusargs("vcd=%s", vcd_path)) vcd_path = "activity.vcd";
    $dumpfile(vcd_path);
    $dumpvars(0, dut);

    for (i = 0; i < DMEM_BYTES; i = i + 1) dmem[i] = 8'h00;
    load_activity_program();

    repeat (3) @(posedge clk);
    @(negedge clk);
    rst_n = 1'b1;

    // 固定活动窗口，避免依赖 halted（也保证损坏的 RTL 不会挂死仿真）
    repeat (800) @(posedge clk);
    $display("POWER_TB_DONE|cycles=800|halted=%b|exit_code=%0d", halted, exit_code);
    $finish;
  end
endmodule
