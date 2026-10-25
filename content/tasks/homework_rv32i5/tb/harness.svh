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
    integer limit_cycles, allowed_cycles;
    begin
      t = 0;
      limit_cycles = dbg_features[0] ? max_cycles * 16 : max_cycles;
      allowed_cycles = dbg_features[0] ? cycle_budget * 16 : cycle_budget;
      while (halted !== 1'b1 && t < limit_cycles) begin
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
        if (t > allowed_cycles) begin
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
      if (!dbg_features[0] && rd !== exp_reads) begin
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
