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

