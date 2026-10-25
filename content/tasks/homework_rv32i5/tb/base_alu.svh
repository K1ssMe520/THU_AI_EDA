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

      repeat (dbg_features[0] ? 300 : 30) @(posedge clk);
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
