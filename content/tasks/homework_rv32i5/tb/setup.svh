  // ===========================================================================
  // 1. 时钟与复位（10 ns 周期，同步低有效复位）
  // ===========================================================================
  logic clk   = 1'b0;
  logic rst_n = 1'b0;
  always #5 clk = ~clk;

  // ===========================================================================
  // 2. DUT 端口信号与例化
  // ===========================================================================
  logic [31:0] imem_addr;
  logic [31:0] imem_rdata;
  logic        dmem_valid;
  logic        dmem_we;
  logic [31:0] dmem_addr;
  logic [31:0] dmem_wdata;
  logic [3:0]  dmem_be;
  logic [31:0] dmem_rdata;
  logic [4:0]  dbg_reg_addr;
  logic [31:0] dbg_reg_data;
  logic        halted;
  logic [31:0] exit_code;
  localparam integer IMEM_WORDS = 1024;
  localparam integer DMEM_BYTES = 4096;
  localparam [31:0] NOP_WORD = 32'h0000_0013;
  logic [31:0] imem [0:IMEM_WORDS-1];
  logic [7:0] dmem [0:DMEM_BYTES-1];
  string cur_test;

`ifdef RV32I_FEATURE_PORTS
  wire imem_valid;
  wire [2:0] dbg_features;
  wire dbg_retire_valid;
  wire [31:0] dbg_retire_pc, dbg_retire_insn;
  wire dbg_bp_resolve, dbg_bp_mispredict;
  wire dbg_ooo_issue, dbg_ooo_bypass;
`else
  wire imem_valid = 1'b1;
  wire [2:0] dbg_features = 3'b000;
  wire dbg_retire_valid = 1'b0;
  wire [31:0] dbg_retire_pc = 32'b0, dbg_retire_insn = 32'b0;
  wire dbg_bp_resolve = 1'b0, dbg_bp_mispredict = 1'b0;
  wire dbg_ooo_issue = 1'b0, dbg_ooo_bypass = 1'b0;
`endif
  wire imem_ready;
  wire dmem_ready;
  integer memory_wait = 0;
  integer iwait = 0, dwait = 0;
  integer imem_transactions = 0;
  integer retired_count = 0, bp_resolve_count = 0, bp_miss_count = 0;
  integer ooo_issue_count = 0, ooo_bypass_count = 0, ooo_overlap_count = 0;
  integer expected_cpu_level = 0, declared_level = 0, verified_level = -1;
  integer suite_fail_start, suite_check_start;
  logic iwas_waiting = 0, dwas_waiting = 0;
  logic [31:0] held_iaddr, held_daddr, held_wdata;
  logic [3:0] held_be;
  logic held_we;

  // Each word response is delayed independently. Legacy interfaces remain zero-wait.
  assign imem_ready = !dbg_features[0] || memory_wait == 0 || iwait >= memory_wait;
  assign dmem_ready = !dbg_features[0] || memory_wait == 0 || dwait >= memory_wait;
  always @(posedge clk) begin
    if (!rst_n) begin
      iwait <= 0;
      dwait <= 0;
      iwas_waiting <= 0;
      dwas_waiting <= 0;
      retired_count <= 0;
      bp_resolve_count <= 0;
      bp_miss_count <= 0;
      ooo_issue_count <= 0;
      ooo_bypass_count <= 0;
      ooo_overlap_count <= 0;
    end else begin
      if (imem_valid && !imem_ready) iwait <= iwait + 1;
      else iwait <= 0;
      if (dmem_valid && !dmem_ready) dwait <= dwait + 1;
      else dwait <= 0;
      if (imem_valid && imem_ready) imem_transactions <= imem_transactions + 1;
      if (dbg_features[0]) begin
        if (iwas_waiting && (!imem_valid || imem_addr !== held_iaddr))
          fail(cur_test, "I-memory request changed before ready");
        if (dwas_waiting && (!dmem_valid || dmem_addr !== held_daddr || dmem_we !== held_we
                            || (held_we && (dmem_wdata !== held_wdata || dmem_be !== held_be))))
          fail(cur_test, "D-memory request changed before ready");
        iwas_waiting <= imem_valid && !imem_ready;
        dwas_waiting <= dmem_valid && !dmem_ready;
        held_iaddr <= imem_addr;
        held_daddr <= dmem_addr;
        held_wdata <= dmem_wdata;
        held_be <= dmem_be;
        held_we <= dmem_we;
      end
      if (dbg_retire_valid) begin
        retired_count <= retired_count + 1;
        if (dbg_retire_pc[1:0] !== 0 || dbg_retire_insn !== imem[dbg_retire_pc[11:2]])
          fail(cur_test, "retire PC/instruction does not match the loaded program");
      end
      if (dbg_bp_resolve) bp_resolve_count <= bp_resolve_count + 1;
      if (dbg_bp_mispredict) begin
        bp_miss_count <= bp_miss_count + 1;
        if (!dbg_bp_resolve) fail(cur_test, "mispredict must coincide with branch resolution");
      end
      if (dbg_ooo_issue) ooo_issue_count <= ooo_issue_count + 1;
      if (dbg_ooo_bypass) begin
        ooo_bypass_count <= ooo_bypass_count + 1;
        if (dmem_valid && !dmem_ready) ooo_overlap_count <= ooo_overlap_count + 1;
      end
    end
  end

  rv32i5 dut (.*);

  // ===========================================================================
  // 3. 存储器模型
  // ===========================================================================
  logic [11:0] dmem_word_base;
  assign dmem_word_base = {dmem_addr[11:2], 2'b00};

  // 组合读指令存储器：imem_addr 直接按字地址索引（低 2 位恒 0）
  assign imem_rdata = imem[imem_addr[11:2]];

  // 组合读数据存储器：返回 {addr[31:2], 2'b00} 起始的小端 32-bit 字
  assign dmem_rdata = {
    dmem[dmem_word_base + 12'd3],
    dmem[dmem_word_base + 12'd2],
    dmem[dmem_word_base + 12'd1],
    dmem[dmem_word_base + 12'd0]
  };

  // ===========================================================================
  // 4. 统计量 / 全局状态
  // ===========================================================================
  integer failures  = 0;   // 失败检查总数
  integer checks_run = 0;  // 已执行检查总数
  integer cycle_count = 0; // 全局时钟周期计数
  integer dmem_write_count  = 0; // dmem_valid&&dmem_we 上升沿次数
  integer dmem_write_cycles = 0; // 有写事务的周期数
  integer dmem_read_cycles  = 0; // 有读事务的周期数
  integer run_cycles = 0;        // 单个 test 从复位释放到 halted 的周期数
  integer tests_run  = 0;
  integer run_timed_out = 0;
  integer wc_test_start = 0;
  integer mw_test_start = 0;
  integer mr_test_start = 0;
  integer fail_test_start = 0;
  integer checks_test_start = 0;

  always @(posedge clk) cycle_count <= cycle_count + 1;

  // ===========================================================================
  // 5. 基础工具 task / function
  // ===========================================================================
  task automatic fail(input string name, input string detail);
    begin
      failures = failures + 1;
      $display("CHECK: %s — %s", name, detail);
    end
  endtask

  task automatic emit_trace(input string event_name, input string detail);
    begin
      $display("AI_EDA_TRACE|cycle=%0d|test=%s|event=%s|halted=%0d|exit_code=%0d|detail=%s",
               cycle_count, cur_test, event_name, halted, exit_code, detail);
    end
  endtask

  // 字节使能合法性：SW=1111；SH 必须与 addr[1] 匹配；SB 必须是 addr[1:0] 对应的单 bit
  function automatic logic be_legal(input logic [3:0] be, input logic [1:0] addr_lo);
    begin
      if (be === 4'b1111) begin
        be_legal = 1'b1;
      end else if (be === 4'b0011 && addr_lo[1] === 1'b0) begin
        be_legal = 1'b1;
      end else if (be === 4'b1100 && addr_lo[1] === 1'b1) begin
        be_legal = 1'b1;
      end else if (be === (4'b0001 << addr_lo)) begin
        be_legal = 1'b1;
      end else begin
        be_legal = 1'b0;
      end
    end
  endfunction

  // ===========================================================================
  // 6. 数据存储器写模型
  //    在 dmem_valid && dmem_we 的时钟上升沿按 dmem_be 逐字节写入。
  //    复位不屏蔽外部存储器（这正是 DUT 必须在输出级屏蔽在途 store 的原因，
  //    因此复位期间若 DUT 仍然写，会真实落盘并被检查抓到）。
  // ===========================================================================
  always @(posedge clk) begin
    if (dmem_valid === 1'b1 && dmem_ready === 1'b1) begin
      // 负立即数测试要求地址保持 0x0000_07xx；若高 20 位异常，说明立即数被零扩展。
      if (cur_test == "t06b_neg_imm" && dmem_addr[31:12] !== 20'h0) begin
        fail(cur_test, $sformatf("负立即数访存地址未符号扩展：0x%08x", dmem_addr));
      end
      if (dmem_we === 1'b1) begin
        if (be_legal(dmem_be, dmem_addr[1:0]) !== 1'b1) begin
          fail(cur_test, $sformatf("非法字节使能：dmem_be=%b dmem_addr=0x%08x", dmem_be, dmem_addr));
        end
        // Spec §3.2：SB/SH 的 dmem_wdata 必须复制到所选 lane；直接探测存储接口。
        if (dmem_be === 4'b0011 || dmem_be === 4'b1100) begin
          if (dmem_wdata[15:0] !== dmem_wdata[31:16]) begin
            fail(cur_test, $sformatf("SH 未复制 dmem_wdata：0x%08x", dmem_wdata));
          end
        end else if (dmem_be !== 4'b1111 && be_legal(dmem_be, dmem_addr[1:0]) === 1'b1) begin
          if (!(dmem_wdata[7:0] === dmem_wdata[15:8]
             && dmem_wdata[15:8] === dmem_wdata[23:16]
             && dmem_wdata[23:16] === dmem_wdata[31:24])) begin
            fail(cur_test, $sformatf("SB 未复制 dmem_wdata：0x%08x", dmem_wdata));
          end
        end
        if (dmem_be[0] === 1'b1) dmem[dmem_word_base]             <= dmem_wdata[7:0];
        if (dmem_be[1] === 1'b1) dmem[dmem_word_base + 12'd1]    <= dmem_wdata[15:8];
        if (dmem_be[2] === 1'b1) dmem[dmem_word_base + 12'd2]    <= dmem_wdata[23:16];
        if (dmem_be[3] === 1'b1) dmem[dmem_word_base + 12'd3]    <= dmem_wdata[31:24];
        dmem_write_count  <= dmem_write_count + 1;
        dmem_write_cycles <= dmem_write_cycles + 1;
        emit_trace("mem_write", $sformatf("addr=0x%08x_data=0x%08x_be=%b",
                                         dmem_addr, dmem_wdata, dmem_be));
      end else begin
        dmem_read_cycles <= dmem_read_cycles + 1;
        emit_trace("mem_read", $sformatf("addr=0x%08x_rdata=0x%08x", dmem_addr, dmem_rdata));
      end
    end
  end

  // ===========================================================================
  // 7. 指令编码函数（标准 RV32I）
