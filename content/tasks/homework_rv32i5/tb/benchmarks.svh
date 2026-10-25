// CoreMark-inspired integer/CRC/memory kernels, assembled directly as RV32I.
// These are teaching workloads, not the official CoreMark benchmark or score.
task automatic emit_perf(input string name, input integer instructions);
  begin
    $display("AI_EDA_PERF|benchmark=%s|cycles=%0d|instructions=%0d|dmem_reads=%0d|dmem_writes=%0d|branches=%0d|mispredicts=%0d|ooo_bypass=%0d|clock_hz=100000000",
             name, run_cycles, instructions, dmem_read_cycles - mr_test_start,
             dmem_write_cycles - mw_test_start, bp_resolve_count, bp_miss_count, ooo_bypass_count);
    if (dbg_features[0]) begin
      checks_run = checks_run + 1;
      if (retired_count !== instructions)
        fail(cur_test, $sformatf("reference instruction count %0d != retirement count %0d", instructions, retired_count));
    end
  end
endtask

task automatic build_crc32();
  integer p;
  begin
    for (p = 1; p <= 2; p = p + 1) begin
      pass_no = p; prog_len = 0;
      e_addi(1, 0, 256); e_addi(2, 0, 64); e_addi(3, 0, -1);
      e_lui(4, 32'hedb88000); e_addi(4, 4, 32'h320);
      mark(L0);
      e_lbu(5, 1, 0); e_xor(3, 3, 5); e_addi(6, 0, 8);
      mark(L1);
      e_andi(7, 3, 1); e_srli(3, 3, 1); e_beq(7, 0, L2);
      e_xor(3, 3, 4);
      mark(L2);
      e_addi(6, 6, -1); e_bne(6, 0, L1);
      e_addi(1, 1, 1); e_addi(2, 2, -1); e_bne(2, 0, L0);
      e_xori(10, 3, -1); e_ecall();
    end
  end
endtask

task automatic benchmark_crc32();
  integer i, j, xor_count;
  reg [31:0] crc;
  begin
    build_crc32();
    begin_test("bench_crc32_64bytes");
    memory_wait = dbg_features[0] ? 3 : 0;
    crc = 32'hffffffff; xor_count = 0;
    for (i = 0; i < 64; i = i + 1) begin
      dmem[256 + i] = (i * 37 + 11) & 255;
      crc = crc ^ dmem[256 + i];
      for (j = 0; j < 8; j = j + 1) begin
        if (crc[0]) begin
          crc = (crc >> 1) ^ 32'hedb88320;
          xor_count = xor_count + 1;
        end else crc = crc >> 1;
      end
    end
    release_reset();
    run_program(20000, 16000);
    if (!run_timed_out) begin
      check_exit_code(~crc);
      check_reg(3, crc);
      emit_perf("teaching_crc32_64bytes", 2951 + xor_count);
    end
    end_test();
    memory_wait = 0;
  end
endtask

task automatic build_array_sum();
  integer p;
  begin
    for (p = 1; p <= 2; p = p + 1) begin
      pass_no = p; prog_len = 0;
      e_addi(1, 0, 256); e_addi(2, 0, 64); e_addi(10, 0, 0);
      mark(L0);
      e_lw(3, 1, 0); e_add(10, 10, 3); e_addi(1, 1, 4);
      e_addi(2, 2, -1); e_bne(2, 0, L0); e_ecall();
    end
  end
endtask

task automatic benchmark_array_sum();
  integer i;
  begin
    build_array_sum();
    begin_test("bench_array_sum64");
    memory_wait = dbg_features[0] ? 3 : 0;
    for (i = 0; i < 64; i = i + 1) set_dmem_word(256 + i * 4, i + 1);
    release_reset();
    run_program(5000, 4000);
    if (!run_timed_out) begin
      check_exit_code(32'd2080);
      emit_perf("teaching_array_sum64", 324);
    end
    end_test();
    memory_wait = 0;
  end
endtask

task automatic run_benchmarks();
  begin
    suite_begin();
    benchmark_crc32();
    benchmark_array_sum();
    suite_end("performance_correctness");
  end
endtask
