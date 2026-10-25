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

