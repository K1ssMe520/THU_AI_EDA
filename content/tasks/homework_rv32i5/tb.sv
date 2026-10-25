`timescale 1ns/1ps

// =============================================================================
// 教师测试平台：RV32I 五级流水线处理器（module rv32i5）
// -----------------------------------------------------------------------------
// 自包含：指令存储器、数据存储器、指令编码器、程序装配（两遍标记解析）全部在
// 本文件内实现，不依赖外部 hex / include / package。
//
// 覆盖场景（每个 test 独立复位、独立装入程序、独立预置 DMEM）：
//   t01_reset        同步复位（释放后 PC=0、寄存器清零、halted/exit_code=0、无 DMEM 写、
//                    运行中复位、停机后复位、复位屏蔽在途 store）
//   t02_alu_r        R 型 ALU 全类型（ADD/SUB/AND/OR/XOR/SLL/SRL/SRA/SLT/SLTU）
//                    + x0 写丢弃
//   t03_alu_imm      I 型 ALU 全类型（ADDI/ANDI/ORI/XORI/SLTI/SLTIU）
//                    + 立即数移位 SLLI/SRLI/SRAI + x0 写丢弃
//   t04_upper        LUI/AUIPC（AUIPC 取自身 PC）+ x0 写丢弃
//   t05_forward      EX/MEM、MEM/WB 前递；连续相关；间隔 3 条时的 WB→ID 写优先
//   t06_load_store   LB/LH/LW/LBU/LHU 符号/零扩展；SB/SH/SW 字节使能；小端顺序
//   t06b_neg_imm     访存/JALR 负立即数符号扩展与 dmem_wdata 复制
//   t07_load_use     load-use 暂停 1 拍；load→branch；load→store
//   t08_store_fwd    store data 前递（EX/MEM、MEM/WB、load→store）
//   t09_branch       BEQ/BNE/BLT/BGE/BLTU/BGEU Taken/Not Taken、前向/后向循环、
//                    Taken 后两级年轻指令不产生副作用、循环内相关前递
//   t10_jump         JAL/JALR 链接地址、JALR 目标（x0 基址 / 非零立即数 / 链接返回）、
//                    Taken 后被冲刷的年轻 ECALL 不得停机
//   t11_halt         ECALL 停机协议：load 后 ECALL 的提交顺序、exit_code=最终 x10、
//                    ECALL 自身不写寄存器/不访存、停机期间 PC/寄存器/DMEM 稳定、
//                    停机后复位清零
//   t12_stall_cycles load-use 恰好暂停 1 拍（两个同构程序 halted 周期差必须为 1）
//   t13_dft          8 点 DFT 真实程序：输入 x[n]=1..8，输出 8 个频点的实部/虚部
//                    并打印每个频点的幅值，供工作台绘制频谱
//
// 输出：CHECK: <test> — <detail>（失败）、AI_EDA_TRACE|...（逐检查点）、
//       LAB_RESULT: PASS / FAIL。
// =============================================================================

module tb_homework_rv32i5;

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

  rv32i5 dut (.*);

  // ===========================================================================
  // 3. 存储器模型
  // ===========================================================================
  localparam integer IMEM_WORDS = 1024;   // 4 KiB 指令空间（字索引 imem_addr[11:2]）
  localparam integer DMEM_BYTES = 4096;   // 4 KiB 数据空间（字节寻址）
  localparam [31:0]  NOP_WORD   = 32'h0000_0013;

  logic [31:0] imem [0:IMEM_WORDS-1];
  logic [7:0]  dmem [0:DMEM_BYTES-1];

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

  string cur_test;

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
    if (dmem_valid === 1'b1) begin
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
  // ===========================================================================
  function automatic [31:0] enc_r(input [6:0] f7, input [4:0] rs2, input [4:0] rs1,
                                  input [2:0] f3, input [4:0] rd);
    enc_r = {f7, rs2, rs1, f3, rd, 7'b0110011};
  endfunction

  function automatic [31:0] enc_i(input integer imm, input [4:0] rs1,
                                  input [2:0] f3, input [4:0] rd, input [6:0] opcode);
    logic [31:0] u;
    begin
      u = imm;
      enc_i = {u[11:0], rs1, f3, rd, opcode};
    end
  endfunction

  function automatic [31:0] enc_s(input integer imm, input [4:0] rs2,
                                  input [4:0] rs1, input [2:0] f3);
    logic [31:0] u;
    begin
      u = imm;
      enc_s = {u[11:5], rs2, rs1, f3, u[4:0], 7'b0100011};
    end
  endfunction

  function automatic [31:0] enc_b(input integer imm, input [4:0] rs2,
                                  input [4:0] rs1, input [2:0] f3);
    logic [31:0] u;
    begin
      u = imm;
      enc_b = {u[12], u[10:5], rs2, rs1, f3, u[4:1], u[11], 7'b1100011};
    end
  endfunction

  function automatic [31:0] enc_u(input [31:0] imm, input [4:0] rd, input [6:0] opcode);
    enc_u = {imm[31:12], rd, opcode};
  endfunction

  function automatic [31:0] enc_j(input integer imm, input [4:0] rd);
    logic [31:0] u;
    begin
      u = imm;
      enc_j = {u[20], u[10:1], u[11], u[19:12], rd, 7'b1101111};
    end
  endfunction

  // ===========================================================================
  // 8. 程序装配（两遍：第 1 遍只记录标号地址，第 2 遍带正确偏移发射指令）
  // ===========================================================================
  localparam integer PROG_MAX = 192;

  logic [31:0] prog [0:PROG_MAX-1];
  integer prog_len = 0;
  integer pass_no  = 1;
  integer label_addr [0:31];

  localparam integer L0 = 0;
  localparam integer L1 = 1;
  localparam integer L2 = 2;
  localparam integer L3 = 3;
  localparam integer L4 = 4;
  localparam integer L5 = 5;
  localparam integer L6 = 6;
  localparam integer L7 = 7;
  localparam integer L8 = 8;
  localparam integer L9 = 9;
  localparam integer L10 = 10;
  localparam integer L11 = 11;
  localparam integer L12 = 12;
  localparam integer L13 = 13;
  localparam integer L14 = 14;
  localparam integer L20 = 20;
  localparam integer L21 = 21;
  localparam integer L22 = 22;
  localparam integer L23 = 23;
  localparam integer L24 = 24;
  localparam integer L25 = 25;
  localparam integer L26 = 26;
  localparam integer L27 = 27;

  task automatic emit(input [31:0] word);
    begin
      if (pass_no == 2) begin
        if (prog_len < PROG_MAX) begin
          prog[prog_len] = word;
        end else begin
          fail("program", $sformatf("程序长度超过 PROG_MAX=%0d", PROG_MAX));
        end
      end
      prog_len = prog_len + 1;
    end
  endtask

  task automatic mark(input integer id);
    begin
      if (pass_no == 1) label_addr[id] = prog_len * 4;
    end
  endtask

  // ------------------------------- R 型 --------------------------------------
  task automatic e_add (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b000, rd)); endtask
  task automatic e_sub (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0100000, rs2, rs1, 3'b000, rd)); endtask
  task automatic e_sll (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b001, rd)); endtask
  task automatic e_slt (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b010, rd)); endtask
  task automatic e_sltu(input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b011, rd)); endtask
  task automatic e_xor (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b100, rd)); endtask
  task automatic e_srl (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b101, rd)); endtask
  task automatic e_sra (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0100000, rs2, rs1, 3'b101, rd)); endtask
  task automatic e_or  (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b110, rd)); endtask
  task automatic e_and (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b111, rd)); endtask

  // ------------------------------ I 型 ALU -----------------------------------
  task automatic e_addi (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b000, rd, 7'b0010011)); endtask
  task automatic e_slti (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b010, rd, 7'b0010011)); endtask
  task automatic e_sltiu(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b011, rd, 7'b0010011)); endtask
  task automatic e_xori (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b100, rd, 7'b0010011)); endtask
  task automatic e_ori  (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b110, rd, 7'b0010011)); endtask
  task automatic e_andi (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b111, rd, 7'b0010011)); endtask
  task automatic e_slli (input [4:0] rd, input [4:0] rs1, input integer shamt); emit(enc_i(shamt, rs1, 3'b001, rd, 7'b0010011)); endtask
  task automatic e_srli (input [4:0] rd, input [4:0] rs1, input integer shamt); emit(enc_i(shamt, rs1, 3'b101, rd, 7'b0010011)); endtask
  task automatic e_srai (input [4:0] rd, input [4:0] rs1, input integer shamt); emit(enc_i(32'h400 + shamt, rs1, 3'b101, rd, 7'b0010011)); endtask

  // --------------------------- 上位立即数 ------------------------------------
  task automatic e_lui  (input [4:0] rd, input [31:0] imm); emit(enc_u(imm, rd, 7'b0110111)); endtask
  task automatic e_auipc(input [4:0] rd, input [31:0] imm); emit(enc_u(imm, rd, 7'b0010111)); endtask

  // ------------------------------ Load ---------------------------------------
  task automatic e_lb (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b000, rd, 7'b0000011)); endtask
  task automatic e_lh (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b001, rd, 7'b0000011)); endtask
  task automatic e_lw (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b010, rd, 7'b0000011)); endtask
  task automatic e_lbu(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b100, rd, 7'b0000011)); endtask
  task automatic e_lhu(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b101, rd, 7'b0000011)); endtask

  // ------------------------------ Store --------------------------------------
  task automatic e_sb(input [4:0] rs2, input [4:0] rs1, input integer imm); emit(enc_s(imm, rs2, rs1, 3'b000)); endtask
  task automatic e_sh(input [4:0] rs2, input [4:0] rs1, input integer imm); emit(enc_s(imm, rs2, rs1, 3'b001)); endtask
  task automatic e_sw(input [4:0] rs2, input [4:0] rs1, input integer imm); emit(enc_s(imm, rs2, rs1, 3'b010)); endtask

  // ------------------------------ Branch -------------------------------------
  task automatic e_beq (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b000)); endtask
  task automatic e_bne (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b001)); endtask
  task automatic e_blt (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b100)); endtask
  task automatic e_bge (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b101)); endtask
  task automatic e_bltu(input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b110)); endtask
  task automatic e_bgeu(input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b111)); endtask

  // ------------------------------ Jump ---------------------------------------
  task automatic e_jal (input [4:0] rd, input integer lbl); emit(enc_j(label_addr[lbl] - (prog_len * 4), rd)); endtask
  task automatic e_jalr(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b000, rd, 7'b1100111)); endtask
  // rd = x0 基址 + 目标标号的绝对地址（目标地址 < 2048，落在 I 型立即数范围内）
  task automatic e_addi_abs(input [4:0] rd, input integer lbl, input integer delta); emit(enc_i(label_addr[lbl] + delta, 5'd0, 3'b000, rd, 7'b0010011)); endtask

  task automatic e_ecall(); emit(32'h0000_0073); endtask
  task automatic e_nop(); emit(NOP_WORD); endtask

  // ===========================================================================
  // 9. 程序装载 / DMEM 预置 / 复位与运行控制
  // ===========================================================================
  task automatic load_program();
    integer i;
    begin
      for (i = 0; i < IMEM_WORDS; i = i + 1) imem[i] = NOP_WORD;
      for (i = 0; i < prog_len; i = i + 1) begin
        if (i < IMEM_WORDS) imem[i] = prog[i];
      end
      emit_trace("load_program", $sformatf("instrs=%0d", prog_len));
    end
  endtask

  task automatic init_dmem();
    integer i;
    begin
      for (i = 0; i < DMEM_BYTES; i = i + 1) dmem[i] = 8'hA5;
    end
  endtask

  task automatic set_dmem_word(input integer addr, input [31:0] value);
    integer base;
    begin
      base = addr & 32'hFFFF_FFFC;
      dmem[base[11:0]]             = value[7:0];
      dmem[base[11:0] + 12'd1]     = value[15:8];
      dmem[base[11:0] + 12'd2]     = value[23:16];
      dmem[base[11:0] + 12'd3]     = value[31:24];
    end
  endtask

  task automatic reset_dut();
    begin
      rst_n = 1'b0;
      repeat (3) @(posedge clk);
      #1;
    end
  endtask

  task automatic release_reset();
    begin
      @(negedge clk);
      rst_n = 1'b1;
      #1;
      // 复位释放后、第一个取指时钟沿之前，PC 必须为 0（Spec §4：复位释放后从 PC 0 开始取指）
      checks_run = checks_run + 1;
      if (imem_addr !== 32'd0) begin
        fail(cur_test, $sformatf("复位释放后 PC(imem_addr) 应为 0，得到 0x%08x", imem_addr));
      end
      emit_trace("reset_release", "rst_n=1");
    end
  endtask

  task automatic check_reset_state(input string name, input integer wr_expect);
    integer i;
    begin
      checks_run = checks_run + 1;
      if (halted !== 1'b0) begin
        fail(name, $sformatf("复位期间 halted 应为 0，得到 %b", halted));
      end
      checks_run = checks_run + 1;
      if (exit_code !== 32'd0) begin
        fail(name, $sformatf("复位期间 exit_code 应为 0，得到 0x%08x", exit_code));
      end
      checks_run = checks_run + 1;
      if (dmem_valid !== 1'b0) begin
        fail(name, $sformatf("复位期间 dmem_valid 应为 0，得到 %b", dmem_valid));
      end
      checks_run = checks_run + 1;
      if (dmem_write_count !== wr_expect) begin
        fail(name, $sformatf("复位期间出现 DMEM 写：写次数 %0d -> %0d", wr_expect, dmem_write_count));
      end
      for (i = 0; i < 32; i = i + 1) begin
        dbg_reg_addr = i[4:0];
        #1;
        checks_run = checks_run + 1;
        if (dbg_reg_data !== 32'd0) begin
          fail(name, $sformatf("复位后 x%0d 应为 0，得到 0x%08x", i, dbg_reg_data));
        end
      end
      emit_trace("check_reset", $sformatf("regs_zero_halted=0_exit_0_writes=%0d",
                                          dmem_write_count - wr_expect));
    end
  endtask

  task automatic begin_test(input string name);
    begin
      cur_test = name;
      tests_run = tests_run + 1;
      run_timed_out = 0;
      run_cycles = 0;
      wc_test_start = dmem_write_count;
      mw_test_start = dmem_write_cycles;
      mr_test_start = dmem_read_cycles;
      fail_test_start = failures;
      checks_test_start = checks_run;
      reset_dut();
      load_program();
      init_dmem();
      emit_trace("test_start", $sformatf("instrs=%0d", prog_len));
    end
  endtask

  task automatic end_test();
    begin
      emit_trace("test_end", $sformatf("checks=%0d_failures=%0d_cycles=%0d_ok=%0d",
                                       checks_run - checks_test_start,
                                       failures - fail_test_start,
                                       run_cycles,
                                       (failures == fail_test_start) ? 1 : 0));
    end
  endtask

  task automatic run_program(input integer max_cycles, input integer cycle_budget);
    integer t;
    begin
      t = 0;
      while (halted !== 1'b1 && t < max_cycles) begin
        @(posedge clk);
        #1;
        t = t + 1;
        // 运行期不变量：x0 恒读 0；取指地址 4 字节对齐
        dbg_reg_addr = 5'd0;
        #1;
        checks_run = checks_run + 1;
        if (dbg_reg_data !== 32'd0) begin
          fail(cur_test, $sformatf("运行中 x0 读出 0x%08x，应为 0", dbg_reg_data));
        end
        checks_run = checks_run + 1;
        if (imem_addr[1:0] !== 2'b00) begin
          fail(cur_test, $sformatf("imem_addr=0x%08x 未按 4 字节对齐", imem_addr));
        end
        // halted=0 期间 exit_code 必须为 0（Spec §4）
        checks_run = checks_run + 1;
        if (halted !== 1'b1 && exit_code !== 32'd0) begin
          fail(cur_test, $sformatf("halted=0 但 exit_code=0x%08x，应为 0", exit_code));
        end
      end
      run_cycles = t;
      if (halted !== 1'b1) begin
        run_timed_out = 1;
        fail(cur_test, $sformatf("等待 halted 超时（%0d 周期），imem_addr=0x%08x",
                                 max_cycles, imem_addr));
        emit_trace("timeout", $sformatf("max_cycles=%0d_pc=0x%08x",
                                        max_cycles, imem_addr));
      end else begin
        dbg_reg_addr = 5'd10;
        #1;
        emit_trace("halted", $sformatf("run_cycles=%0d_budget=%0d_x10=0x%08x_exit_code=0x%08x",
                                       t, cycle_budget, dbg_reg_data, exit_code));
        checks_run = checks_run + 1;
        if (t > cycle_budget) begin
          fail(cur_test, $sformatf("执行 %0d 周期超过预算 %0d，疑似没有实现每级一拍的五级流水线",
                                   t, cycle_budget));
        end
      end
    end
  endtask

  // ===========================================================================
  // 10. 检查 task
  // ===========================================================================
  task automatic check_halted();
    begin
      checks_run = checks_run + 1;
      if (halted !== 1'b1) begin
        fail(cur_test, $sformatf("halted 应为 1，得到 %b", halted));
      end else begin
        emit_trace("check_halted", "halted=1");
      end
    end
  endtask

  task automatic check_reg(input integer idx, input [31:0] exp);
    logic [31:0] got;
    begin
      dbg_reg_addr = idx[4:0];
      #1;
      got = dbg_reg_data;
      checks_run = checks_run + 1;
      if (got !== exp) begin
        fail(cur_test, $sformatf("x%0d 期望 0x%08x 得到 0x%08x", idx, exp, got));
        emit_trace("check_reg", $sformatf("x%0d_exp=0x%08x_got=0x%08x_FAIL", idx, exp, got));
      end else begin
        emit_trace("check_reg", $sformatf("x%0d=0x%08x", idx, got));
      end
    end
  endtask

  task automatic check_x0();
    begin
      check_reg(0, 32'd0);
    end
  endtask

  task automatic check_mem_word(input integer addr, input [31:0] exp);
    logic [31:0] got;
    logic [11:0] base;
    begin
      base = addr[11:0] & 12'hFFC;
      got = {dmem[base + 12'd3], dmem[base + 12'd2], dmem[base + 12'd1], dmem[base]};
      checks_run = checks_run + 1;
      if (got !== exp) begin
        fail(cur_test, $sformatf("DMEM[0x%03x] 期望 0x%08x 得到 0x%08x", addr, exp, got));
        emit_trace("check_mem", $sformatf("addr=0x%03x_exp=0x%08x_got=0x%08x_FAIL",
                                          addr, exp, got));
      end else begin
        emit_trace("check_mem", $sformatf("addr=0x%03x=0x%08x", addr, got));
      end
    end
  endtask

  task automatic check_mem_byte(input integer addr, input [7:0] exp);
    logic [7:0] got;
    begin
      got = dmem[addr[11:0]];
      checks_run = checks_run + 1;
      if (got !== exp) begin
        fail(cur_test, $sformatf("DMEM[0x%03x] 期望 0x%02x 得到 0x%02x", addr, exp, got));
        emit_trace("check_mem_byte", $sformatf("addr=0x%03x_exp=0x%02x_got=0x%02x_FAIL",
                                               addr, exp, got));
      end else begin
        emit_trace("check_mem_byte", $sformatf("addr=0x%03x=0x%02x", addr, got));
      end
    end
  endtask

  task automatic check_exit_code(input [31:0] exp);
    begin
      checks_run = checks_run + 1;
      if (exit_code !== exp) begin
        fail(cur_test, $sformatf("exit_code 期望 0x%08x 得到 0x%08x", exp, exit_code));
        emit_trace("check_exit", $sformatf("exp=0x%08x_got=0x%08x_FAIL", exp, exit_code));
      end else begin
        emit_trace("check_exit", $sformatf("exit_code=0x%08x", exit_code));
      end
    end
  endtask

  // 检查本 test 的 DMEM 读/写事务数（dmem_valid 每个有效 load/store 恰好一个周期）
  task automatic check_mem_op_count(input integer exp_reads, input integer exp_writes);
    integer rd;
    integer wr;
    begin
      rd = dmem_read_cycles - mr_test_start;
      wr = dmem_write_cycles - mw_test_start;
      checks_run = checks_run + 1;
      if (rd !== exp_reads) begin
        fail(cur_test, $sformatf("DMEM 读事务数期望 %0d 得到 %0d", exp_reads, rd));
      end
      checks_run = checks_run + 1;
      if (wr !== exp_writes) begin
        fail(cur_test, $sformatf("DMEM 写事务数期望 %0d 得到 %0d", exp_writes, wr));
      end
      if (rd === exp_reads && wr === exp_writes) begin
        emit_trace("check_dmem_ops", $sformatf("reads=%0d_writes=%0d", rd, wr));
      end
    end
  endtask

  task automatic check_no_dmem_ops();
    begin
      check_mem_op_count(0, 0);
    end
  endtask

  // 停机保持性：halted 保持、exit_code=最终 x10、PC/架构寄存器/DMEM 稳定、无 DMEM 事务
  logic [31:0] reg_snapshot [0:31];
  logic [31:0] mem_snapshot [0:255];
  integer      wc_snapshot;
  logic [31:0] pc_snapshot;
  logic [31:0] exit_snapshot;

  task automatic check_halt_stability();
    integer i;
    logic [31:0] word_v;
    begin
      pc_snapshot   = imem_addr;
      exit_snapshot = exit_code;
      wc_snapshot   = dmem_write_count;
      for (i = 0; i < 32; i = i + 1) begin
        dbg_reg_addr = i[4:0];
        #1;
        reg_snapshot[i] = dbg_reg_data;
      end
      for (i = 0; i < 256; i = i + 1) begin
        mem_snapshot[i] = {dmem[i*4 + 3], dmem[i*4 + 2], dmem[i*4 + 1], dmem[i*4]};
      end

      // exit_code 必须等于停机时的 x10
      checks_run = checks_run + 1;
      if (exit_snapshot !== reg_snapshot[10]) begin
        fail(cur_test, $sformatf("exit_code=0x%08x 应等于停机时 x10=0x%08x",
                                 exit_snapshot, reg_snapshot[10]));
      end else begin
        emit_trace("check_exit_x10", $sformatf("exit_code=0x%08x", exit_snapshot));
      end

      // halted 之后保持若干周期
      repeat (5) begin
        @(posedge clk);
        #1;
        checks_run = checks_run + 1;
        if (halted !== 1'b1) begin
          fail(cur_test, $sformatf("halted 拉高后未保持为 1，得到 %b", halted));
        end
        checks_run = checks_run + 1;
        if (dmem_valid !== 1'b0) begin
          fail(cur_test, $sformatf("停机期间 dmem_valid 应为 0，得到 %b", dmem_valid));
        end
        checks_run = checks_run + 1;
        if (exit_code !== exit_snapshot) begin
          fail(cur_test, $sformatf("停机期间 exit_code 不稳定：0x%08x -> 0x%08x",
                                   exit_snapshot, exit_code));
        end
      end

      // 架构寄存器稳定
      for (i = 0; i < 32; i = i + 1) begin
        dbg_reg_addr = i[4:0];
        #1;
        checks_run = checks_run + 1;
        if (dbg_reg_data !== reg_snapshot[i]) begin
          fail(cur_test, $sformatf("停机期间 x%0d 不稳定：0x%08x -> 0x%08x",
                                   i, reg_snapshot[i], dbg_reg_data));
        end
      end

      // DMEM 稳定
      for (i = 0; i < 256; i = i + 1) begin
        word_v = {dmem[i*4 + 3], dmem[i*4 + 2], dmem[i*4 + 1], dmem[i*4]};
        checks_run = checks_run + 1;
        if (word_v !== mem_snapshot[i]) begin
          fail(cur_test, $sformatf("停机期间 DMEM[0x%03x] 不稳定", i*4));
        end
      end

      checks_run = checks_run + 1;
      if (dmem_write_count !== wc_snapshot) begin
        fail(cur_test, "停机期间仍然发生 DMEM 写");
      end
      checks_run = checks_run + 1;
      if (imem_addr !== pc_snapshot) begin
        fail(cur_test, $sformatf("停机期间 imem_addr 不稳定：0x%08x -> 0x%08x",
                                 pc_snapshot, imem_addr));
      end
      emit_trace("check_stability", "halted_pc_regs_dmem_stable");
    end
  endtask

  // 编码器自检（与 RISC-V 标准已知机器码比对）
  task automatic check_encodings();
    begin
      cur_test = "enc";
      reset_dut();
      checks_run = checks_run + 1;
      if (enc_r(7'b0000000, 5'd2, 5'd1, 3'b000, 5'd3) !== 32'h0020_81B3)
        fail(cur_test, "R 型 ADD 编码错误");
      checks_run = checks_run + 1;
      if (enc_i(-8, 5'd1, 3'b000, 5'd1, 7'b0010011) !== 32'hFF80_8093)
        fail(cur_test, "I 型 ADDI（负立即数）编码错误");
      checks_run = checks_run + 1;
      if (enc_i(2047, 5'd2, 3'b000, 5'd2, 7'b0010011) !== 32'h7FF1_0113)
        fail(cur_test, "I 型 ADDI（正立即数）编码错误");
      checks_run = checks_run + 1;
      if (enc_s(8, 5'd2, 5'd1, 3'b010) !== 32'h0020_A423)
        fail(cur_test, "S 型 SW 编码错误");
      checks_run = checks_run + 1;
      if (enc_b(8, 5'd0, 5'd0, 3'b000) !== 32'h0000_0463)
        fail(cur_test, "B 型 BEQ（正偏移）编码错误");
      checks_run = checks_run + 1;
      if (enc_b(-4, 5'd0, 5'd0, 3'b000) !== 32'hFE00_0EE3)
        fail(cur_test, "B 型 BEQ（负偏移）编码错误");
      checks_run = checks_run + 1;
      if (enc_j(8, 5'd0) !== 32'h0080_006F)
        fail(cur_test, "J 型 JAL（正偏移）编码错误");
      checks_run = checks_run + 1;
      if (enc_j(-4, 5'd0) !== 32'hFFDF_F06F)
        fail(cur_test, "J 型 JAL（负偏移）编码错误");
      checks_run = checks_run + 1;
      if (enc_u(32'h1234_5000, 5'd1, 7'b0110111) !== 32'h1234_50B7)
        fail(cur_test, "U 型 LUI 编码错误");
      checks_run = checks_run + 1;
      if (enc_i(0, 5'd1, 3'b000, 5'd0, 7'b1100111) !== 32'h0000_8067)
        fail(cur_test, "JALR(ret) 编码错误");
      emit_trace("check_encoding", "rv32i_encoders_selfchecked");
    end
  endtask

  // ===========================================================================
  // 11. 各 test 的程序（两遍装配：pass 1 记录标号，pass 2 发射最终机器码）
  // ===========================================================================

  // ---------------------------- t01: 复位协议 --------------------------------
  // 死循环 + store：用于"运行中复位"及"复位屏蔽在途 store"
  task automatic build_t01_loop();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 512);   // x1 = 0x200
        mark(L1);
        e_addi(5'd1, 5'd1, 4);     // x1 += 4
        e_sw  (5'd1, 5'd1, 0);     // mem[x1] = x1
        e_jal (5'd0, L1);          // 无限循环
      end
    end
  endtask

  // 正常停机程序：x10 = 0
  task automatic build_t01_halt();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 5);
        e_addi(5'd2, 5'd0, -1);
        e_addi(5'd10, 5'd0, 0);
        e_ecall();
      end
    end
  endtask

  task automatic test_t01_reset();
    integer wc0;
    begin
      cur_test = "t01_reset";
      tests_run = tests_run + 1;
      run_timed_out = 0;
      run_cycles = 0;
      wc_test_start = dmem_write_count;
      mw_test_start = dmem_write_cycles;
      mr_test_start = dmem_read_cycles;
      fail_test_start = failures;
      checks_test_start = checks_run;

      // ---- 阶段 1：复位后装入死循环程序，跑一段，验证"运行中复位" ----
      build_t01_loop();
      reset_dut();
      load_program();
      init_dmem();
      emit_trace("test_start", $sformatf("instrs=%0d", prog_len));
      wc0 = dmem_write_count;
      check_reset_state("t01_reset", wc0);
      release_reset();

      repeat (30) @(posedge clk);
      #1;
      checks_run = checks_run + 1;
      if (halted !== 1'b0) begin
        fail(cur_test, "死循环程序不应停机（halted 应为 0）");
      end
      dbg_reg_addr = 5'd1;
      #1;
      checks_run = checks_run + 1;
      if (dbg_reg_data === 32'h0000_0200) begin
        fail(cur_test, "死循环程序没有推进（x1 仍等于初值 0x200）");
      end
      checks_run = checks_run + 1;
      if (dmem_write_count <= wc0) begin
        fail(cur_test, "死循环程序没有产生任何 DMEM 写，无法验证复位屏蔽在途 store");
      end
      emit_trace("loop_progress", $sformatf("x1=0x%08x_writes=%0d",
                                            dbg_reg_data, dmem_write_count - wc0));

      // ---- 阶段 2：运行中同步复位 ----
      wc0 = dmem_write_count;
      reset_dut();
      check_reset_state("t01_mid_reset", wc0);

      // ---- 阶段 3：复位后装入停机程序，正常跑完 ----
      build_t01_halt();
      load_program();
      wc0 = dmem_write_count;
      check_reset_state("t01_reset2", wc0);
      mw_test_start = dmem_write_cycles;   // 计数只针对本阶段
      mr_test_start = dmem_read_cycles;
      release_reset();
      run_program(200, 2*prog_len + 60);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(1, 32'd5);
        check_reg(2, 32'hFFFF_FFFF);
        check_reg(10, 32'd0);
        check_exit_code(32'd0);
        check_halt_stability();
        check_no_dmem_ops();
      end

      // ---- 阶段 4：停机后复位，halted/exit_code 清零 ----
      wc0 = dmem_write_count;
      reset_dut();
      check_reset_state("t01_after_halt_reset", wc0);
      end_test();
    end
  endtask

  // ------------------------- t02: R 型 ALU 全类型 -----------------------------
  task automatic build_t02_alu_r();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, -8);          // x1 = 0xFFFFFFF8
        e_addi(5'd2, 5'd0, 3);           // x2 = 3
        e_add (5'd3, 5'd1, 5'd2);        // 0xFFFFFFFB
        e_sub (5'd4, 5'd2, 5'd1);        // 11
        e_and (5'd5, 5'd1, 5'd2);        // 0
        e_or  (5'd6, 5'd1, 5'd2);        // 0xFFFFFFFB
        e_xor (5'd7, 5'd1, 5'd2);        // 0xFFFFFFFB
        e_sll (5'd8, 5'd2, 5'd1);        // 3 << 24 = 0x03000000
        e_srl (5'd9, 5'd1, 5'd2);        // 0x1FFFFFFF
        e_sra (5'd11, 5'd1, 5'd2);       // 0xFFFFFFFF
        e_slt (5'd12, 5'd1, 5'd2);       // 1
        e_sltu(5'd13, 5'd1, 5'd2);       // 0
        e_lui (5'd14, 32'h8000_0000);    // x14 = 0x80000000
        e_addi(5'd15, 5'd0, -1);         // x15 = 0xFFFFFFFF
        e_slt (5'd16, 5'd14, 5'd15);     // 1
        e_sltu(5'd17, 5'd14, 5'd15);     // 1
        e_slt (5'd18, 5'd15, 5'd14);     // 0
        e_sltu(5'd19, 5'd15, 5'd14);     // 0
        e_sub (5'd20, 5'd14, 5'd15);     // 0x80000001
        e_add (5'd21, 5'd15, 5'd15);     // 0xFFFFFFFE
        e_addi(5'd0, 5'd0, 5);           // 写 x0 丢弃
        e_add (5'd0, 5'd1, 5'd2);        // 写 x0 丢弃
        e_slli(5'd22, 5'd2, 31);         // 0x80000000
        e_srli(5'd23, 5'd14, 31);        // 1
        e_srai(5'd24, 5'd14, 31);        // 0xFFFFFFFF
        e_srai(5'd25, 5'd2, 1);          // 1
        e_srai(5'd26, 5'd15, 4);         // 0xFFFFFFFF
        e_srli(5'd27, 5'd15, 4);         // 0x0FFFFFFF
        e_addi(5'd10, 5'd0, 66);         // exit_code = 66（非零）
        e_ecall();
      end
    end
  endtask

  task automatic test_t02_alu_r();
    begin
      build_t02_alu_r();
      begin_test("t02_alu_r");
      release_reset();
      run_program(400, prog_len + 16);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(3,  32'hFFFF_FFFB);
        check_reg(4,  32'd11);
        check_reg(5,  32'd0);
        check_reg(6,  32'hFFFF_FFFB);
        check_reg(7,  32'hFFFF_FFFB);
        check_reg(8,  32'h0300_0000);
        check_reg(9,  32'h1FFF_FFFF);
        check_reg(11, 32'hFFFF_FFFF);
        check_reg(12, 32'd1);
        check_reg(13, 32'd0);
        check_reg(14, 32'h8000_0000);
        check_reg(15, 32'hFFFF_FFFF);
        check_reg(16, 32'd1);
        check_reg(17, 32'd1);
        check_reg(18, 32'd0);
        check_reg(19, 32'd0);
        check_reg(20, 32'h8000_0001);
        check_reg(21, 32'hFFFF_FFFE);
        check_reg(22, 32'h8000_0000);
        check_reg(23, 32'd1);
        check_reg(24, 32'hFFFF_FFFF);
        check_reg(25, 32'd1);
        check_reg(26, 32'hFFFF_FFFF);
        check_reg(27, 32'h0FFF_FFFF);
        check_reg(10, 32'd66);
        check_exit_code(32'd66);
        check_halt_stability();
        check_no_dmem_ops();
      end
      end_test();
    end
  endtask

  // ------------------------- t03: I 型 ALU 与移位 -----------------------------
  task automatic build_t03_alu_imm();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi (5'd1, 5'd0, -2048);      // 0xFFFFF800
        e_addi (5'd2, 5'd0, 2047);       // 0x000007FF
        e_addi (5'd3, 5'd1, -1);         // 0xFFFFF7FF
        e_andi (5'd4, 5'd2, 240);        // 0x0F0
        e_ori  (5'd5, 5'd1, 2047);       // 0xFFFFFFFF
        e_xori (5'd6, 5'd2, -1);         // 0xFFFFF800
        e_slti (5'd7, 5'd1, 0);          // 1
        e_slti (5'd8, 5'd2, 0);          // 0
        e_sltiu(5'd9, 5'd1, -1);         // 1
        e_sltiu(5'd11, 5'd2, -1);        // 1
        e_slti (5'd12, 5'd1, -2048);     // 0
        e_sltiu(5'd13, 5'd1, -2048);     // 0
        e_slli (5'd14, 5'd2, 4);         // 0x7FF0
        e_srli (5'd15, 5'd1, 12);        // 0x000FFFFF
        e_srai (5'd16, 5'd1, 12);        // 0xFFFFFFFF
        e_slli (5'd17, 5'd0, 5);         // 0
        e_srli (5'd18, 5'd2, 0);         // 0x7FF
        e_srai (5'd19, 5'd2, 0);         // 0x7FF
        e_addi (5'd0, 5'd0, 123);        // 写 x0 丢弃
        e_ori  (5'd0, 5'd0, -1);         // 写 x0 丢弃
        e_addi (5'd20, 5'd0, 0);
        e_addi (5'd21, 5'd0, 1);
        e_addi (5'd10, 5'd0, 67);        // exit_code = 67
        e_ecall();
      end
    end
  endtask

  task automatic test_t03_alu_imm();
    begin
      build_t03_alu_imm();
      begin_test("t03_alu_imm");
      release_reset();
      run_program(400, prog_len + 16);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(1,  32'hFFFF_F800);
        check_reg(2,  32'h0000_07FF);
        check_reg(3,  32'hFFFF_F7FF);
        check_reg(4,  32'h0000_00F0);
        check_reg(5,  32'hFFFF_FFFF);
        check_reg(6,  32'hFFFF_F800);
        check_reg(7,  32'd1);
        check_reg(8,  32'd0);
        check_reg(9,  32'd1);
        check_reg(11, 32'd1);
        check_reg(12, 32'd0);
        check_reg(13, 32'd0);
        check_reg(14, 32'h0000_7FF0);
        check_reg(15, 32'h000F_FFFF);
        check_reg(16, 32'hFFFF_FFFF);
        check_reg(17, 32'd0);
        check_reg(18, 32'h0000_07FF);
        check_reg(19, 32'h0000_07FF);
        check_reg(20, 32'd0);
        check_reg(21, 32'd1);
        check_reg(10, 32'd67);
        check_exit_code(32'd67);
        check_halt_stability();
        check_no_dmem_ops();
      end
      end_test();
    end
  endtask

  // --------------------------- t04: LUI / AUIPC ------------------------------
  task automatic build_t04_upper();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_lui  (5'd1, 32'h1234_5000);    // x1 = 0x12345000
        e_auipc(5'd2, 32'h0);            // x2 = pc = 4
        e_auipc(5'd3, 32'h0000_1000);    // x3 = 8 + 0x1000 = 0x1008
        e_auipc(5'd4, 32'hFFFF_F000);    // x4 = 12 + 0xFFFFF000 = 0xFFFFF00C
        e_lui  (5'd0, 32'h7777_7000);    // 写 x0 丢弃
        e_auipc(5'd0, 32'h0000_4000);    // 写 x0 丢弃
        e_addi (5'd5, 5'd0, 7);          // x0 读出恒为 0
        e_lui  (5'd6, 32'h8000_0000);    // 0x80000000
        e_auipc(5'd7, 32'h8000_0000);    // x7 = 32 + 0x80000000
        e_addi (5'd10, 5'd0, 68);        // exit_code = 68
        e_ecall();
      end
    end
  endtask

  task automatic test_t04_upper();
    begin
      build_t04_upper();
      begin_test("t04_upper");
      release_reset();
      run_program(400, prog_len + 16);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(1, 32'h1234_5000);
        check_reg(2, 32'h0000_0004);
        check_reg(3, 32'h0000_1008);
        check_reg(4, 32'hFFFF_F00C);
        check_reg(5, 32'h0000_0007);
        check_reg(6, 32'h8000_0000);
        check_reg(7, 32'h8000_0020);
        check_reg(10, 32'd68);
        check_exit_code(32'd68);
        check_halt_stability();
        check_no_dmem_ops();
      end
      end_test();
    end
  endtask

  // ------------------- t05: ALU 相关前递（EX/MEM、MEM/WB） -------------------
  task automatic build_t05_forward();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 10);
        e_addi(5'd2, 5'd1, 5);           // 距离 1：EX/MEM 前递 -> 15
        e_addi(5'd3, 5'd2, 5);           // 距离 1 -> 20
        e_add (5'd4, 5'd3, 5'd1);        // EX/MEM + 距离 3（WB→ID 写优先）-> 30
        e_sub (5'd5, 5'd4, 5'd2);        // 距离 1 -> 15
        e_addi(5'd6, 5'd0, 1);
        e_add (5'd7, 5'd6, 5'd6);        // 两个源都 EX/MEM 前递 -> 2
        e_addi(5'd8, 5'd0, 42);
        e_addi(5'd9, 5'd0, 0);           // 填充
        e_addi(5'd11, 5'd0, 0);          // 填充
        e_add (5'd12, 5'd8, 5'd0);       // x8 距离 3：WB→ID 写优先 -> 42
        e_add (5'd13, 5'd8, 5'd12);      // 84
        e_xor (5'd14, 5'd13, 5'd12);     // 84 ^ 42 = 126
        e_addi(5'd15, 5'd0, -1);
        e_add (5'd16, 5'd15, 5'd15);     // 距离 1：EX/MEM -> 0xFFFFFFFE
        e_sub (5'd17, 5'd15, 5'd15);     // 距离 1 -> 0
        e_slt (5'd18, 5'd15, 5'd16);     // -1 < -2 ? -> 0
        e_slt (5'd19, 5'd16, 5'd15);     // -2 < -1 ? -> 1
        e_addi(5'd20, 5'd0, 100);
        e_add (5'd21, 5'd20, 5'd20);     // 距离 1 -> 200
        e_sub (5'd22, 5'd21, 5'd20);     // 距离 1 -> 100
        e_addi(5'd23, 5'd0, 5);          // 连续两次写 x23
        e_addi(5'd23, 5'd0, 7);
        e_add (5'd24, 5'd23, 5'd0);      // 必须看到最新值 7（EX/MEM 优先于 MEM/WB）
        e_addi(5'd10, 5'd0, 69);         // exit_code = 69
        e_ecall();
      end
    end
  endtask

  task automatic test_t05_forward();
    begin
      build_t05_forward();
      begin_test("t05_forward");
      release_reset();
      run_program(400, prog_len + 16);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(2,  32'd15);
        check_reg(3,  32'd20);
        check_reg(4,  32'd30);
        check_reg(5,  32'd15);
        check_reg(7,  32'd2);
        check_reg(12, 32'd42);
        check_reg(13, 32'd84);
        check_reg(14, 32'd126);
        check_reg(16, 32'hFFFF_FFFE);
        check_reg(17, 32'd0);
        check_reg(18, 32'd0);
        check_reg(19, 32'd1);
        check_reg(21, 32'd200);
        check_reg(22, 32'd100);
        check_reg(23, 32'd7);
        check_reg(24, 32'd7);      // EX/MEM 前递优先级高于 MEM/WB
        check_reg(10, 32'd69);
        check_exit_code(32'd69);
        check_halt_stability();
        check_no_dmem_ops();
      end
      end_test();
    end
  endtask

  // ------------------------- t06: load / store 全类型 -------------------------
  // DMEM 预置：0x100 = 0x80FF7F01, 0x104 = 0x7FFF8000，其余 0xA5 毒化
  task automatic build_t06_load_store();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 256);         // 基址 0x100
        e_lw  (5'd2, 5'd1, 0);           // 0x80FF7F01
        e_lb  (5'd3, 5'd1, 0);           // 0x00000001
        e_lb  (5'd4, 5'd1, 1);           // 0x0000007F
        e_lb  (5'd5, 5'd1, 2);           // 0xFFFFFFFF
        e_lb  (5'd6, 5'd1, 3);           // 0xFFFFFF80
        e_lbu (5'd7, 5'd1, 2);           // 0x000000FF
        e_lbu (5'd8, 5'd1, 3);           // 0x00000080
        e_lh  (5'd9, 5'd1, 0);           // 0x00007F01
        e_lh  (5'd11, 5'd1, 2);          // 0xFFFFFF80
        e_lhu (5'd12, 5'd1, 2);          // 0x0000FF80
        e_lh  (5'd13, 5'd1, 4);          // 0xFFFF8000
        e_lh  (5'd14, 5'd1, 6);          // 0x00007FFF
        e_lhu (5'd15, 5'd1, 4);          // 0x00008000
        e_lw  (5'd16, 5'd1, 4);          // 0x7FFF8000
        e_sw  (5'd2, 5'd1, 8);           // [0x108] = 01 7F FF 80
        e_sb  (5'd2, 5'd1, 12);          // [0x10C] = 01
        e_sb  (5'd2, 5'd1, 15);          // [0x10F] = 01
        e_sh  (5'd2, 5'd1, 14);          // [0x10E..0x10F] = 01 7F
        e_sh  (5'd2, 5'd1, 22);          // [0x116..0x117] = 01 7F
        e_sb  (5'd0, 5'd1, 24);          // [0x118] = 00
        e_lw  (5'd17, 5'd1, 8);          // 0x80FF7F01
        e_lbu (5'd18, 5'd1, 12);         // 0x01
        e_lbu (5'd19, 5'd1, 13);         // 0xA5（毒化未被覆盖）
        e_lw  (5'd20, 5'd1, 12);         // 0x7F01A501
        e_lw  (5'd21, 5'd1, 20);         // 0x7F01A5A5
        e_lw  (5'd22, 5'd1, 24);         // 0x00A5A5A5
        e_lb  (5'd23, 5'd1, 26);         // 0xFFFFFFA5
        e_lhu (5'd24, 5'd1, 24);         // 0x0000A500
        e_addi(5'd10, 5'd0, 70);         // exit_code = 70
        e_ecall();
      end
    end
  endtask

  task automatic test_t06_load_store();
    begin
      build_t06_load_store();
      begin_test("t06_load_store");
      set_dmem_word(32'h100, 32'h80FF_7F01);
      set_dmem_word(32'h104, 32'h7FFF_8000);
      release_reset();
      run_program(500, 2*prog_len + 60);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(2,  32'h80FF_7F01);
        check_reg(3,  32'h0000_0001);
        check_reg(4,  32'h0000_007F);
        check_reg(5,  32'hFFFF_FFFF);
        check_reg(6,  32'hFFFF_FF80);
        check_reg(7,  32'h0000_00FF);
        check_reg(8,  32'h0000_0080);
        check_reg(9,  32'h0000_7F01);
        check_reg(11, 32'hFFFF_80FF);
        check_reg(12, 32'h0000_80FF);
        check_reg(13, 32'hFFFF_8000);
        check_reg(14, 32'h0000_7FFF);
        check_reg(15, 32'h0000_8000);
        check_reg(16, 32'h7FFF_8000);
        check_reg(17, 32'h80FF_7F01);
        check_reg(18, 32'h0000_0001);
        check_reg(19, 32'h0000_00A5);
        check_reg(20, 32'h7F01_A501);
        check_reg(21, 32'h7F01_A5A5);
        check_reg(22, 32'hA5A5_A500);
        check_reg(23, 32'hFFFF_FFA5);
        check_reg(24, 32'h0000_A500);
        // 预置字未被覆盖
        check_mem_word(32'h100, 32'h80FF_7F01);
        check_mem_word(32'h104, 32'h7FFF_8000);
        // store 结果：字节使能 / 小端顺序
        check_mem_word(32'h108, 32'h80FF_7F01);
        check_mem_word(32'h10C, 32'h7F01_A501);
        check_mem_byte(32'h10D, 8'hA5);
        check_mem_word(32'h110, 32'hA5A5_A5A5);
        check_mem_word(32'h114, 32'h7F01_A5A5);
        check_mem_word(32'h118, 32'hA5A5_A500);
        check_mem_byte(32'h119, 8'hA5);
        // 未访问区域保持毒化
        check_mem_word(32'h0FC, 32'hA5A5_A5A5);
        check_mem_word(32'h11C, 32'hA5A5_A5A5);
        check_mem_word(32'h120, 32'hA5A5_A5A5);
        check_exit_code(32'd70);
        check_mem_op_count(22, 6);   // 22 次 load，6 次 store
        check_halt_stability();
      end
      end_test();
    end
  endtask

  // ------------------- t06b: 负立即数符号扩展 --------------------------------
  // 用与 0x10FC/0x10F8 不同的 poison 值区分零扩展错误地址。
  task automatic build_t06b_neg_imm();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 1024);         // 基址 0x400
        e_lw  (5'd2, 5'd1, -4);           // 0x3FC = 0x11223344
        e_lh  (5'd3, 5'd1, -2);           // 0x3FE = 0x1122
        e_lb  (5'd4, 5'd1, -3);           // 0x3FD = 0x33
        e_lui (5'd5, 32'h5566_7000);
        e_addi(5'd5, 5'd5, 32'h788);      // x5 = 0x55667788
        e_sw  (5'd5, 5'd1, -8);           // [0x3F8] = 88 77 66 55
        e_lui (5'd6, 32'h0000_7000);
        e_addi(5'd6, 5'd6, 32'h788);      // x6 = 0x7788
        e_sh  (5'd6, 5'd1, -6);           // [0x3FA..0x3FB] = 88 77
        e_lw  (5'd8, 5'd1, -8);           // [0x3F8] = 0x77887788
        e_addi(5'd10, 5'd0, 76);
        e_ecall();
      end
    end
  endtask

  task automatic test_t06b_neg_imm();
    begin
      build_t06b_neg_imm();
      begin_test("t06b_neg_imm");
      set_dmem_word(32'h3FC, 32'h1122_3344);
      set_dmem_word(32'hFFC, 32'hDEAD_BEEF);
      release_reset();
      run_program(300, 2*prog_len + 40);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(2, 32'h1122_3344);
        check_reg(3, 32'h0000_1122);
        check_reg(4, 32'h0000_0033);
        check_reg(8, 32'h7788_7788);
        check_mem_word(32'h3F8, 32'h7788_7788);
        check_mem_word(32'h3FC, 32'h1122_3344);
        check_mem_word(32'hFF8, 32'hA5A5_A5A5);
        check_mem_word(32'hFFC, 32'hDEAD_BEEF);
        check_exit_code(32'd76);
        check_mem_op_count(4, 2);
        check_halt_stability();
      end
      end_test();
    end
  endtask

  // ----------------------------- t07: load-use -------------------------------
  // DMEM 预置：0x100 = 0x12345678, 0x104 = 0xFFFFFFF9, 0x108 = 0x00008000
  task automatic build_t07_load_use();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 256);
        e_lw  (5'd2, 5'd1, 0);           // x2 = 0x12345678
        e_add (5'd3, 5'd2, 5'd2);        // load-use：暂停 1 拍 -> 0x2468ACF0
        e_lw  (5'd5, 5'd1, 4);           // x5 = 0xFFFFFFF9 (-7)
        e_blt (5'd5, 5'd0, L1);          // load-use（branch 源）：暂停 1 拍 -> Taken
        e_addi(5'd8, 5'd0, 111);         // 被冲刷
        e_addi(5'd8, 5'd0, 222);         // 被冲刷
        mark(L1);
        e_addi(5'd9, 5'd0, 9);
        e_lw  (5'd11, 5'd1, 8);          // x11 = 0x00008000
        e_sw  (5'd11, 5'd1, 12);         // load->store rs2 依赖（可暂停也可 MEM 前递）
        e_lw  (5'd12, 5'd1, 12);         // x12 = 0x00008000
        e_addi(5'd13, 5'd12, 1);         // load-use -> 0x8001
        e_addi(5'd10, 5'd0, 71);         // exit_code = 71
        e_ecall();
      end
    end
  endtask

  task automatic test_t07_load_use();
    begin
      build_t07_load_use();
      begin_test("t07_load_use");
      set_dmem_word(32'h100, 32'h1234_5678);
      set_dmem_word(32'h104, 32'hFFFF_FFF9);
      set_dmem_word(32'h108, 32'h0000_8000);
      release_reset();
      run_program(500, 2*prog_len + 60);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(2,  32'h1234_5678);
        check_reg(3,  32'h2468_ACF0);
        check_reg(5,  32'hFFFF_FFF9);
        check_reg(8,  32'h0000_0000);   // Taken 后的两条年轻指令不产生副作用
        check_reg(9,  32'd9);
        check_reg(11, 32'h0000_8000);
        check_reg(12, 32'h0000_8000);
        check_reg(13, 32'h0000_8001);
        check_reg(10, 32'd71);
        check_mem_word(32'h10C, 32'h0000_8000);
        check_exit_code(32'd71);
        check_mem_op_count(4, 1);       // 4 次 load，1 次 store
        check_halt_stability();
      end
      end_test();
    end
  endtask

  // --------------------------- t08: store data 前递 ---------------------------
  task automatic build_t08_store_fwd();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 512);         // 基址 0x200
        e_addi(5'd2, 5'd0, 1963);        // x2 = 0x7AB
        e_sw  (5'd2, 5'd1, 0);           // EX/MEM->MEM/WB 前递 -> [0x200] = 0x7AB
        e_addi(5'd3, 5'd0, -3);          // x3 = 0xFFFFFFFD
        e_addi(5'd4, 5'd3, 2);           // 距离 1 -> 0xFFFFFFFF
        e_sw  (5'd4, 5'd1, 4);           // [0x204] = 0xFFFFFFFF
        e_sw  (5'd3, 5'd1, 8);           // [0x208] = 0xFFFFFFFD
        e_lw  (5'd5, 5'd1, 0);           // x5 = 0x7AB
        e_sw  (5'd5, 5'd1, 12);          // load->store -> [0x20C] = 0x7AB
        e_lw  (5'd6, 5'd1, 4);           // x6 = 0xFFFFFFFF
        e_add (5'd7, 5'd6, 5'd5);        // 0x7AA
        e_sb  (5'd7, 5'd1, 16);          // [0x210] 低字节 = 0xAA
        e_sh  (5'd7, 5'd1, 20);          // [0x214..0x215] = AA 07
        e_sw  (5'd7, 5'd1, 24);          // [0x218] = 0x7AA
        e_lw  (5'd8, 5'd1, 16);          // 0xA5A5A5AA
        e_lw  (5'd9, 5'd1, 20);          // 0xA5A507AA
        e_lw  (5'd11, 5'd1, 24);         // 0x000007AA
        e_addi(5'd10, 5'd0, 72);         // exit_code = 72
        e_ecall();
      end
    end
  endtask

  task automatic test_t08_store_fwd();
    begin
      build_t08_store_fwd();
      begin_test("t08_store_fwd");
      release_reset();
      run_program(500, 2*prog_len + 60);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(2,  32'h0000_07AB);
        check_reg(3,  32'hFFFF_FFFD);
        check_reg(4,  32'hFFFF_FFFF);
        check_reg(5,  32'h0000_07AB);
        check_reg(6,  32'hFFFF_FFFF);
        check_reg(7,  32'h0000_07AA);
        check_reg(8,  32'hA5A5_A5AA);
        check_reg(9,  32'hA5A5_07AA);
        check_reg(11, 32'h0000_07AA);
        check_mem_word(32'h200, 32'h0000_07AB);
        check_mem_word(32'h204, 32'hFFFF_FFFF);
        check_mem_word(32'h208, 32'hFFFF_FFFD);
        check_mem_word(32'h20C, 32'h0000_07AB);
        check_mem_word(32'h210, 32'hA5A5_A5AA);
        check_mem_word(32'h214, 32'hA5A5_07AA);
        check_mem_word(32'h218, 32'h0000_07AA);
        check_mem_word(32'h21C, 32'hA5A5_A5A5);
        check_reg(10, 32'd72);
        check_exit_code(32'd72);
        check_mem_op_count(5, 7);       // 5 次 load，7 次 store
        check_halt_stability();
      end
      end_test();
    end
  endtask

  // ------------------------------ t09: 分支 ----------------------------------
  task automatic build_t09_branch();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, -1);          // x1 = 0xFFFFFFFF (-1)
        e_addi(5'd2, 5'd0, 1);
        e_addi(5'd3, 5'd0, 0);
        e_addi(5'd4, 5'd0, 2);
        e_addi(5'd5, 5'd0, 0);           // 被冲刷计数（应为 0）
        e_addi(5'd6, 5'd0, 0);           // 正常执行计数（应为 12）
        e_addi(5'd7, 5'd0, 0);           // 循环 1 累加
        e_addi(5'd8, 5'd0, 10);          // 循环 1 计数
        e_addi(5'd12, 5'd0, 0);          // 循环 2 累加
        e_addi(5'd13, 5'd0, 0);          // 循环 2 计数
        e_addi(5'd9, 5'd0, 0);
        // BEQ taken（后随两条必被冲刷的年轻指令）
        e_beq (5'd1, 5'd1, L1);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd5, 5'd5, 1);
        mark(L1);
        e_addi(5'd9, 5'd9, 1);           // x9 = 1
        // BEQ not taken（后随两条正常执行）
        e_beq (5'd1, 5'd2, L2);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd6, 5'd6, 1);
        mark(L2);
        e_addi(5'd9, 5'd9, 1);           // x9 = 2
        // BNE taken
        e_bne (5'd1, 5'd2, L3);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd5, 5'd5, 1);
        mark(L3);
        // BNE not taken
        e_bne (5'd1, 5'd1, L4);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd6, 5'd6, 1);
        mark(L4);
        // BLT taken: -1 < 1
        e_blt (5'd1, 5'd2, L5);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd5, 5'd5, 1);
        mark(L5);
        // BLT not taken: 1 < -1
        e_blt (5'd2, 5'd1, L6);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd6, 5'd6, 1);
        mark(L6);
        // BGE taken: 1 >= -1
        e_bge (5'd2, 5'd1, L7);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd5, 5'd5, 1);
        mark(L7);
        // BGE not taken: -1 >= 1
        e_bge (5'd1, 5'd2, L8);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd6, 5'd6, 1);
        mark(L8);
        // BLTU taken: 1 < 0xFFFFFFFF
        e_bltu(5'd2, 5'd1, L9);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd5, 5'd5, 1);
        mark(L9);
        // BLTU not taken: 0xFFFFFFFF < 1
        e_bltu(5'd1, 5'd2, L10);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd6, 5'd6, 1);
        mark(L10);
        // BGEU taken: 0xFFFFFFFF >= 1
        e_bgeu(5'd1, 5'd2, L11);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd5, 5'd5, 1);
        mark(L11);
        // BGEU not taken: 1 >= 0xFFFFFFFF
        e_bgeu(5'd2, 5'd1, L12);
        e_addi(5'd6, 5'd6, 1);
        e_addi(5'd6, 5'd6, 1);
        mark(L12);
        // 后向循环 1：x7 = 10+9+...+1 = 55
        mark(L13);
        e_add (5'd7, 5'd7, 5'd8);
        e_addi(5'd8, 5'd8, -1);
        e_bne (5'd8, 5'd0, L13);
        e_addi(5'd9, 5'd9, 1);           // x9 = 3
        // 后向循环 2：x12 = 5*3 = 15
        e_addi(5'd13, 5'd0, 5);
        mark(L14);
        e_addi(5'd12, 5'd12, 3);
        e_addi(5'd13, 5'd13, -1);
        e_bne (5'd13, 5'd0, L14);
        e_addi(5'd9, 5'd9, 7);           // x9 = 10
        e_addi(5'd10, 5'd0, 73);         // exit_code = 73
        e_ecall();
      end
    end
  endtask

  task automatic test_t09_branch();
    begin
      build_t09_branch();
      begin_test("t09_branch");
      release_reset();
      run_program(1200, 500);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(1,  32'hFFFF_FFFF);
        check_reg(2,  32'd1);
        check_reg(3,  32'd0);
        check_reg(4,  32'd2);
        check_reg(5,  32'd0);      // 所有 Taken 后的年轻指令都被冲刷
        check_reg(6,  32'd12);     // 6 个 Not Taken 分支各 2 条有效 addi
        check_reg(7,  32'd55);
        check_reg(8,  32'd0);
        check_reg(9,  32'd10);
        check_reg(12, 32'd15);
        check_reg(13, 32'd0);
        check_reg(10, 32'd73);
        check_exit_code(32'd73);
        check_no_dmem_ops();
        check_halt_stability();
      end
      end_test();
    end
  endtask

  // ------------------------------ t10: JAL / JALR ----------------------------
  // 程序布局（与 build 顺序严格一致）：
  //  0 jal x1, FN            x1 = 4
  //  1 addi x5, x5, 0x55     （返回后执行一次 -> 0x55）
  //  2 jal x0, L_MAIN2       x0 链接丢弃
  //  3 ecall                 （必须被冲刷，不得停机）
  //  4 addi x9, x9, 1        （必须被冲刷）
  //  5 L_MAIN2: addi x11, x0, 42
  //  6 addi x7, x0, addr(L_J1)
  //  7 jalr x6, 0(x7)        x6 = 32, 目标 L_J1
  //  8 addi x9, x9, 10       （必须被冲刷）
  //  9 addi x9, x9, 100      （必须被冲刷）
  // 10 L_J1: addi x12, x0, 7
  // 11 addi x7, x0, addr(L_J2)-8
  // 12 jalr x8, 8(x7)        x8 = 52, 目标 L_J2
  // 13 addi x9, x9, 1000     （必须被冲刷）
  // 14 addi x9, x9, 10000    （必须被冲刷）
  // 15 L_J2: addi x13, x0, 9
  // 16 addi x7, x0, addr(L_J3)+1   奇数 rs1+imm
  // 17 jalr x16, 0(x7)      目标 = (奇数) & ~1 = addr(L_J3)；x16 = 72
  // 18 addi x9, x9, 100000  （必须被冲刷）
  // 19 addi x9, x9, 1000000 （必须被冲刷）
  // 20 L_J3: addi x17, x0, 11
  // 21 auipc x14, 0          x14 = 84
  // 22 auipc x15, 0x10000    x15 = 0x10058
  // 23 addi x10, x0, 74
  // 24 ecall
  // 25 FN: addi x3, x0, 3
  // 26 addi x4, x0, 4
  // 27 jalr x0, 0(x1)        返回 x1 = 4
  task automatic build_t10_jump();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_jal (5'd1, L1);                // FN
        e_addi(5'd5, 5'd5, 85);          // 0x55，返回后执行一次
        e_jal (5'd0, L2);                // L_MAIN2
        e_ecall();                       // 被冲刷
        e_addi(5'd9, 5'd9, 1);           // 被冲刷
        mark(L2);                        // L_MAIN2
        e_addi(5'd11, 5'd0, 42);
        e_addi_abs(5'd7, L3, 0);         // x7 = addr(L_J1)
        e_jalr(5'd6, 5'd7, 0);           // 目标 L_J1
        e_addi(5'd9, 5'd9, 10);          // 被冲刷
        e_addi(5'd9, 5'd9, 100);         // 被冲刷
        mark(L3);                        // L_J1
        e_addi(5'd12, 5'd0, 7);
        e_addi_abs(5'd7, L4, -8);        // x7 = addr(L_J2) - 8
        e_jalr(5'd8, 5'd7, 8);           // 目标 L_J2
        e_addi(5'd9, 5'd9, 1000);        // 被冲刷
        e_addi(5'd9, 5'd9, 10000);       // 被冲刷
        mark(L4);                        // L_J2
        e_addi(5'd13, 5'd0, 9);
        e_addi_abs(5'd7, L5, 1);         // x7 = addr(L_J3) + 1（奇数）
        e_jalr(5'd16, 5'd7, 0);          // 目标 = (奇数) & ~1 = L_J3
        e_addi(5'd9, 5'd9, 100000);      // 被冲刷
        e_addi(5'd9, 5'd9, 1000000);     // 被冲刷
        mark(L5);                        // L_J3
        e_addi(5'd17, 5'd0, 11);
        e_auipc(5'd14, 32'h0);
        e_auipc(5'd15, 32'h0001_0000);
        e_addi_abs(5'd20, L6, 4);        // x20 = addr(L6) + 4
        e_jalr(5'd18, 5'd20, -4);        // 负立即数：目标回到 L6
        e_addi(5'd21, 5'd0, 777);        // Taken 后年轻指令，必须被冲刷
        mark(L6);
        e_addi(5'd19, 5'd0, 13);
        e_addi(5'd10, 5'd0, 74);         // exit_code = 74
        e_ecall();
        mark(L1);                        // FN（函数体）
        e_addi(5'd3, 5'd0, 3);
        e_addi(5'd4, 5'd0, 4);
        e_jalr(5'd0, 5'd1, 0);           // 返回
      end
    end
  endtask

  task automatic test_t10_jump();
    begin
      build_t10_jump();
      begin_test("t10_jump");
      release_reset();
      run_program(600, 2*prog_len + 60);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(1,  32'h0000_0004);   // JAL 链接地址
        check_reg(3,  32'd3);
        check_reg(4,  32'd4);
        check_reg(5,  32'h0000_0055);   // 只在返回后执行一次
        check_reg(6,  32'h0000_0020);   // JALR 链接地址 = idx7*4+4
        check_reg(7,  32'h0000_0051);   // addr(L_J3) + 1 = 80 + 1
        check_reg(8,  32'h0000_0034);   // JALR 链接地址 = idx12*4+4
        check_reg(9,  32'd0);           // 所有 Taken 后的年轻指令都不产生副作用
        check_reg(11, 32'd42);
        check_reg(12, 32'd7);
        check_reg(13, 32'd9);
        check_reg(14, 32'h0000_0054);   // AUIPC 取自身 PC = idx21*4
        check_reg(15, 32'h0001_0058);
        check_reg(16, 32'h0000_0048);   // JALR 链接地址 = idx17*4+4 = 72
        check_reg(17, 32'd11);          // JALR bit0 被清零后才到达 L_J3
        check_reg(19, 32'd13);          // 负立即数 JALR 到达 L6
        check_reg(21, 32'd0);           // 被 JALR 冲刷的年轻指令不得执行
        check_reg(10, 32'd74);
        check_exit_code(32'd74);
        check_no_dmem_ops();
        check_halt_stability();
      end
      end_test();
    end
  endtask

  // ------------------------------ t11: 停机协议 ------------------------------
  // 0 addi x1, x0, 0x180
  // 1 lw   x10, 0(x1)    x10 = DMEM[0x180] = 0xAB
  // 2 ecall              ECALL 必须等更老的 load 提交后才停机，exit_code = 0xAB
  // 3 addi x9, x9, 1     （必须被丢弃）
  // 4 addi x9, x9, 2     （必须被丢弃）
  // 5 sw   x1, 0(x0)     （必须被丢弃，不得访问 DMEM）
  task automatic build_t11_halt();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 384);
        e_lw  (5'd10, 5'd1, 0);
        e_ecall();
        e_addi(5'd9, 5'd9, 1);
        e_addi(5'd9, 5'd9, 2);
        e_sw  (5'd1, 5'd0, 0);
      end
    end
  endtask

  task automatic test_t11_halt();
    begin
      build_t11_halt();
      begin_test("t11_halt");
      set_dmem_word(32'h180, 32'h0000_00AB);
      release_reset();
      run_program(300, 2*prog_len + 60);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(1,  32'h0000_0180);
        check_reg(10, 32'h0000_00AB);
        check_reg(9,  32'd0);            // ECALL 之后的年轻指令全部丢弃
        check_exit_code(32'h0000_00AB);  // 非零 exit_code
        check_mem_word(32'h180, 32'h0000_00AB);
        check_mem_word(32'h0000, 32'hA5A5_A5A5); // 被丢弃的 store 没有写
        check_mem_op_count(1, 0);        // 只有 1 次 load，没有 store
        check_halt_stability();
      end

      // 停机后复位：halted / exit_code 清零，架构寄存器清零
      wc_test_start = dmem_write_count;
      reset_dut();
      check_reset_state("t11_after_halt_reset", wc_test_start);
      end_test();
    end
  endtask

  // --------------------- t12: load-use 恰好暂停 1 拍 -------------------------
  // 两个程序指令数相同、结构相同，唯一差别是第 3 条 add 是否依赖前一条 load。
  // 五级流水线正确实现下，两者 halted 周期差必须恰好为 1（最多暂停 1 拍）。
  task automatic build_t12_load_dep();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd2, 5'd0, 256);
        e_lw  (5'd1, 5'd2, 0);
        e_add (5'd3, 5'd1, 5'd1);        // load-use：必须恰好暂停 1 拍
        e_addi(5'd10, 5'd0, 75);
        e_ecall();
      end
    end
  endtask

  task automatic build_t12_load_indep();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd2, 5'd0, 256);
        e_lw  (5'd1, 5'd2, 0);
        e_add (5'd3, 5'd2, 5'd2);        // 无依赖：不应暂停
        e_addi(5'd10, 5'd0, 75);
        e_ecall();
      end
    end
  endtask

  task automatic test_t12_stall_cycles();
    integer cyc_dep;
    integer cyc_indep;
    integer ok_dep;
    integer ok_indep;
    begin
      cur_test = "t12_stall_cycles";
      tests_run = tests_run + 1;
      run_timed_out = 0;
      run_cycles = 0;
      fail_test_start = failures;
      checks_test_start = checks_run;
      emit_trace("test_start", "load_use_cycle_compare");

      // ---- A：存在 load-use 依赖 ----
      build_t12_load_dep();
      reset_dut();
      load_program();
      init_dmem();
      set_dmem_word(32'h100, 32'h1234_5678);
      mw_test_start = dmem_write_cycles;
      mr_test_start = dmem_read_cycles;
      wc_test_start = dmem_write_count;
      release_reset();
      run_program(200, 100);
      cyc_dep = run_cycles;
      ok_dep = (run_timed_out == 0) ? 1 : 0;
      if (ok_dep == 1) begin
        check_halted();
        check_x0();
        check_reg(3, 32'h2468_ACF0);
        check_reg(10, 32'd75);
        check_exit_code(32'd75);
      end

      // ---- B：无依赖（其余完全相同） ----
      build_t12_load_indep();
      reset_dut();
      load_program();
      init_dmem();
      set_dmem_word(32'h100, 32'h1234_5678);
      release_reset();
      run_program(200, 100);
      cyc_indep = run_cycles;
      ok_indep = (run_timed_out == 0) ? 1 : 0;
      if (ok_indep == 1) begin
        check_halted();
        check_x0();
        check_reg(3, 32'h0000_0200);
        check_reg(10, 32'd75);
        check_exit_code(32'd75);
      end

      if (ok_dep == 1 && ok_indep == 1) begin
        checks_run = checks_run + 1;
        if ((cyc_dep - cyc_indep) !== 1) begin
          fail(cur_test, $sformatf("load-use 应恰好暂停 1 拍：依赖版 %0d 周期，独立版 %0d 周期，差 %0d",
                                   cyc_dep, cyc_indep, cyc_dep - cyc_indep));
          emit_trace("check_stall", $sformatf("dep=%0d_indep=%0d_delta=%0d_FAIL",
                                              cyc_dep, cyc_indep, cyc_dep - cyc_indep));
        end else begin
          emit_trace("check_stall", $sformatf("dep=%0d_indep=%0d_delta=1",
                                              cyc_dep, cyc_indep));
        end
      end
      end_test();
    end
  endtask

  // ------------------------- t13: 8 点 DFT 真实程序 --------------------------
  // 数据布局：
  //   0x300..0x31F  x[0..7]（1..8）
  //   0x340..0x35F  X[k].re（Q8）
  //   0x360..0x37F  X[k].im（Q8）
  //   0x380..0x39F  cos(2πm/8) Q8
  //   0x3A0..0x3BF  sin(2πm/8) Q8
  task automatic build_t13_dft();
    integer p;
    begin
      for (p = 1; p <= 2; p = p + 1) begin
        pass_no = p;
        prog_len = 0;
        e_addi(5'd1, 5'd0, 32'h300);     // x base
        e_addi(5'd11, 5'd0, 32'h380);    // cos base
        e_addi(5'd12, 5'd0, 32'h3A0);    // sin base
        e_addi(5'd30, 5'd0, 32'h340);    // real output base
        e_addi(5'd31, 5'd0, 32'h360);    // imag output base
        e_addi(5'd2, 5'd0, 0);           // k
        mark(L20);                       // OUTER
        e_addi(5'd4, 5'd0, 0);           // sum_re
        e_addi(5'd5, 5'd0, 0);           // sum_im
        e_addi(5'd3, 5'd0, 0);           // n
        e_addi(5'd13, 5'd0, 0);          // m = (k*n)&7
        mark(L21);                       // INNER
        e_slli(5'd6, 5'd3, 2);
        e_add (5'd6, 5'd1, 5'd6);
        e_lw  (5'd8, 5'd6, 0);           // x[n]
        e_slli(5'd14, 5'd13, 2);
        e_add (5'd14, 5'd11, 5'd14);
        e_lw  (5'd7, 5'd14, 0);          // cos[m]
        e_jal (5'd15, L22);              // mul(x, cos)
        e_add (5'd4, 5'd4, 5'd9);        // sum_re += product
        e_slli(5'd14, 5'd13, 2);
        e_add (5'd14, 5'd12, 5'd14);
        e_lw  (5'd7, 5'd14, 0);          // sin[m]
        e_slli(5'd6, 5'd3, 2);
        e_add (5'd6, 5'd1, 5'd6);
        e_lw  (5'd8, 5'd6, 0);           // reload x[n]
        e_jal (5'd15, L22);              // mul(x, sin)
        e_sub (5'd5, 5'd5, 5'd9);        // sum_im -= product
        e_addi(5'd3, 5'd3, 1);
        e_add (5'd13, 5'd13, 5'd2);
        e_andi(5'd13, 5'd13, 7);
        e_addi(5'd17, 5'd0, 8);
        e_blt (5'd3, 5'd17, L21);
        e_slli(5'd6, 5'd2, 2);
        e_add (5'd6, 5'd30, 5'd6);
        e_sw  (5'd4, 5'd6, 0);           // X[k].re
        e_slli(5'd6, 5'd2, 2);
        e_add (5'd6, 5'd31, 5'd6);
        e_sw  (5'd5, 5'd6, 0);           // X[k].im
        e_addi(5'd2, 5'd2, 1);
        e_addi(5'd17, 5'd0, 8);
        e_blt (5'd2, 5'd17, L20);
        e_addi(5'd10, 5'd0, 32'hDF);     // exit code 0xDF
        e_ecall();
        // 无符号/有符号 shift-add 乘法子程序：x9 = x7 * x8
        mark(L22);                       // MUL
        e_addi(5'd9, 5'd0, 0);
        e_addi(5'd16, 5'd0, 0);
        e_bge (5'd7, 5'd0, L23);
        e_sub (5'd7, 5'd0, 5'd7);
        e_addi(5'd16, 5'd0, 1);
        mark(L23);                       // MUL_POS
        e_beq (5'd7, 5'd0, L26);
        mark(L24);                       // MUL_LOOP
        e_andi(5'd17, 5'd7, 1);
        e_beq (5'd17, 5'd0, L25);
        e_add (5'd9, 5'd9, 5'd8);
        mark(L25);                       // MUL_SKIP
        e_slli(5'd8, 5'd8, 1);
        e_srli(5'd7, 5'd7, 1);
        e_bne (5'd7, 5'd0, L24);
        mark(L26);                       // MUL_DONE
        e_beq (5'd16, 5'd0, L27);
        e_sub (5'd9, 5'd0, 5'd9);
        mark(L27);                       // MUL_RET
        e_jalr(5'd0, 5'd15, 0);
      end
    end
  endtask

  task automatic test_t13_dft();
    integer k;
    integer n;
    integer m;
    integer re;
    integer im;
    integer mag;
    integer exp_mag;
    integer xin [0:7];
    integer cosq [0:7];
    integer sinq [0:7];
    integer exp_re [0:7];
    integer exp_im [0:7];
    begin
      xin[0] = 1; xin[1] = 2; xin[2] = 3; xin[3] = 4;
      xin[4] = 5; xin[5] = 6; xin[6] = 7; xin[7] = 8;
      cosq[0] = 256;  cosq[1] = 181;  cosq[2] = 0;    cosq[3] = -181;
      cosq[4] = -256; cosq[5] = -181; cosq[6] = 0;    cosq[7] = 181;
      sinq[0] = 0;    sinq[1] = 181;  sinq[2] = 256;  sinq[3] = 181;
      sinq[4] = 0;    sinq[5] = -181; sinq[6] = -256; sinq[7] = -181;
      for (k = 0; k < 8; k = k + 1) begin
        exp_re[k] = 0;
        exp_im[k] = 0;
        for (n = 0; n < 8; n = n + 1) begin
          m = (k * n) & 7;
          exp_re[k] = exp_re[k] + xin[n] * cosq[m];
          exp_im[k] = exp_im[k] - xin[n] * sinq[m];
        end
      end
      build_t13_dft();
      begin_test("t13_dft");
      for (k = 0; k < 8; k = k + 1) begin
        set_dmem_word(32'h300 + 4*k, xin[k]);
        set_dmem_word(32'h380 + 4*k, cosq[k]);
        set_dmem_word(32'h3A0 + 4*k, sinq[k]);
      end
      release_reset();
      run_program(20000, 15000);
      if (!run_timed_out) begin
        check_halted();
        check_x0();
        check_reg(10, 32'h0000_00DF);
        check_exit_code(32'h0000_00DF);
        for (k = 0; k < 8; k = k + 1) begin
          check_mem_word(32'h340 + 4*k, exp_re[k]);
          check_mem_word(32'h360 + 4*k, exp_im[k]);
          re = {dmem[32'h340 + 4*k + 3], dmem[32'h340 + 4*k + 2],
                dmem[32'h340 + 4*k + 1], dmem[32'h340 + 4*k]};
          im = {dmem[32'h360 + 4*k + 3], dmem[32'h360 + 4*k + 2],
                dmem[32'h360 + 4*k + 1], dmem[32'h360 + 4*k]};
          mag = (re < 0 ? -re : re) + (im < 0 ? -im : im);
          exp_mag = (exp_re[k] < 0 ? -exp_re[k] : exp_re[k])
                  + (exp_im[k] < 0 ? -exp_im[k] : exp_im[k]);
          checks_run = checks_run + 1;
          $display("AI_EDA_TRACE|cycle=%0d|test=t13_dft|event=bin|k=%0d|re=%0d|im=%0d|mag=%0d|expected_mag=%0d",
                   cycle_count, k, re, im, mag, exp_mag);
          if (mag !== exp_mag) begin
            fail(cur_test, $sformatf("DFT 频点 %0d 幅值期望 %0d 得到 %0d", k, exp_mag, mag));
          end
        end
        check_halt_stability();
      end
      end_test();
    end
  endtask

  // ===========================================================================
  // 12. 主流程
  // ===========================================================================
  initial begin
    cur_test = "power_on";
    rst_n = 1'b0;
    dbg_reg_addr = 5'd0;

    // 上电复位期间（第一个复位上升沿之前）dmem_valid 必须为 0（Spec §4）
    #1;
    checks_run = checks_run + 1;
    if (dmem_valid !== 1'b0) begin
      fail("power_on_reset", $sformatf("上电复位期间 dmem_valid 应为 0，得到 %b", dmem_valid));
    end
    emit_trace("power_on", "rst_n_low_before_first_edge");

    check_encodings();

    test_t01_reset();
    test_t02_alu_r();
    test_t03_alu_imm();
    test_t04_upper();
    test_t05_forward();
    test_t06_load_store();
    test_t06b_neg_imm();
    test_t07_load_use();
    test_t08_store_fwd();
    test_t09_branch();
    test_t10_jump();
    test_t11_halt();
    test_t12_stall_cycles();
    test_t13_dft();

    repeat (2) @(posedge clk);
    #1;

    if (failures == 0) begin
      $display("LAB_RESULT: PASS (%0d tests, %0d checks)", tests_run, checks_run);
    end else begin
      $display("LAB_RESULT: FAIL (%0d failures / %0d checks)", failures, checks_run);
      $fatal(1);
    end
    $finish;
  end

endmodule

// =============================================================================
// Agent 模式选项卡别名：与 stream_filter 项目的 tb_agent_stream_filter 命名一致。
// 教师作业验收仍使用 Spec 规定的顶层 tb_homework_rv32i5（本文件首个模块）。
// iverilog -g2012 -s tb_agent_rv32i5 tb.sv rtl.sv 即可用别名运行。
// =============================================================================
module tb_agent_rv32i5;
  tb_homework_rv32i5 u_teacher_tb();
endmodule
