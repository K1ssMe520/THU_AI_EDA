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

