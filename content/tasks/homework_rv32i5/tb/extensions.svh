// Extension suites prove externally observable behavior in addition to declared bits.
task automatic suite_begin();
  begin
    suite_fail_start = failures;
    suite_check_start = checks_run;
  end
endtask

task automatic suite_end(input string name);
  begin
    $display("AI_EDA_SUITE|name=%s|passed=%0d|skipped=0|checks=%0d",
             name, failures == suite_fail_start, checks_run - suite_check_start);
  end
endtask

task automatic suite_skip(input string name);
  $display("AI_EDA_SUITE|name=%s|passed=1|skipped=1|checks=0", name);
endtask

task automatic detect_capabilities();
  begin
    if (!$value$plusargs("expected_cpu_level=%d", expected_cpu_level)) expected_cpu_level = 0;
    case (dbg_features)
      3'b000: declared_level = 0;
      3'b001: declared_level = 1;
      3'b011: declared_level = 2;
      3'b111: declared_level = 3;
      default: begin
        declared_level = 0;
        fail("capability", "dbg_features must be 000, 001, 011, or 111");
      end
    endcase
    checks_run = checks_run + 1;
    if (declared_level < expected_cpu_level)
      fail("capability", $sformatf("expected level %0d but RTL declared level %0d", expected_cpu_level, declared_level));
  end
endtask

task automatic build_cache_probe();
  integer p;
  begin
    for (p = 1; p <= 2; p = p + 1) begin
      pass_no = p;
      prog_len = 0;
      e_addi(1, 0, 256);
      e_lw(3, 1, 0);
      e_lw(4, 1, 4);
      e_lw(5, 1, 8);
      e_lw(6, 1, 12);
      e_lw(7, 1, 0);
      e_addi(8, 0, 85);
      e_sb(8, 1, 1);
      e_lbu(9, 1, 1);
      e_lw(11, 1, 256); // Same direct-mapped cache index, different tag.
      e_lw(12, 1, 0);   // Must refill the evicted line, including the byte store.
      e_addi(10, 0, 0);
      e_ecall();
    end
  end
endtask

task automatic test_cache();
  integer reads, writes, first_reads;
  begin
    suite_begin();
    build_cache_probe();
    begin_test("cache_line_conflict");
    memory_wait = 3;
    set_dmem_word(256, 32'h44332211);
    set_dmem_word(260, 32'h88776655);
    set_dmem_word(264, 32'hccbbAA99);
    set_dmem_word(268, 32'h10203040);
    set_dmem_word(512, 32'hcafebabe);
    release_reset();
    run_program(1000, 1000);
    if (!run_timed_out) begin
      check_reg(3, 32'h44332211);
      check_reg(4, 32'h88776655);
      check_reg(5, 32'hccbbaa99);
      check_reg(6, 32'h10203040);
      check_reg(7, 32'h44332211);
      check_reg(9, 32'h55);
      check_reg(11, 32'hcafebabe);
      check_reg(12, 32'h44335511);
      check_mem_word(256, 32'h44335511);
      reads = dmem_read_cycles - mr_test_start;
      writes = dmem_write_cycles - mw_test_start;
      checks_run = checks_run + 2;
      if (reads !== 12) fail(cur_test, $sformatf("three 16-byte line fills require 12 bus reads, got %0d", reads));
      if (writes !== 1) fail(cur_test, "byte store must produce one write-through transaction");
      check_halt_stability();
    end
    end_test();
    memory_wait = 0;
    // Same loop revisits a warm instruction line. A fake pass-through cache is observable.
    build_branch_probe();
    begin_test("cache_instruction_reuse");
    first_reads = imem_transactions;
    release_reset();
    run_program(2000, 2000);
    checks_run = checks_run + 1;
    if (imem_transactions - first_reads > 20)
      fail(cur_test, "instruction loop did not reuse cached instruction lines");
    check_reg(1, 32'd64);
    end_test();
    suite_end("cache");
    if (failures == suite_fail_start && verified_level == 0) verified_level = 1;
  end
endtask

task automatic build_branch_probe();
  integer p;
  begin
    for (p = 1; p <= 2; p = p + 1) begin
      pass_no = p; prog_len = 0;
      e_addi(1, 0, 0);
      e_addi(2, 0, 64);
      mark(L0);
      e_addi(1, 1, 1);
      e_blt(1, 2, L0);
      e_addi(10, 0, 0);
      e_ecall();
    end
  end
endtask

task automatic test_predictor();
  begin
    suite_begin();
    build_branch_probe();
    begin_test("predictor_training");
    release_reset();
    run_program(2000, 2000);
    check_reg(1, 32'd64);
    checks_run = checks_run + 3;
    if (bp_resolve_count < 64) fail(cur_test, "missing branch-resolution evidence");
    if (bp_miss_count > 8) fail(cur_test, $sformatf("trained taken loop has %0d mispredicts (limit 8)", bp_miss_count));
    if (retired_count !== 132) fail(cur_test, $sformatf("retired count expected 132 got %0d", retired_count));
    $display("AI_EDA_PERF|benchmark=trained_branch64|cycles=%0d|instructions=132|branches=%0d|mispredicts=%0d", run_cycles, bp_resolve_count, bp_miss_count);
    end_test();
    // Existing branch/jump suites already check wrong-path ECALL and store suppression.
    suite_end("predictor");
    if (failures == suite_fail_start && verified_level == 1) verified_level = 2;
  end
endtask

task automatic build_ooo_probe();
  integer p, i;
  begin
    for (p = 1; p <= 2; p = p + 1) begin
      pass_no = p; prog_len = 0;
      e_addi(1, 0, 768);
      // The following ALU instructions are independent of the pending cache miss.
      e_lw(3, 1, 0);
      for (i = 4; i < 16; i = i + 1) e_addi(i[4:0], 0, i);
      e_add(16, 3, 15);
      e_addi(17, 0, 1);
      e_addi(17, 0, 2); // WAW: rename must preserve the youngest value.
      e_add(18, 17, 16);
      e_sw(18, 1, 4);
      e_addi(10, 0, 0);
      e_ecall();
    end
  end
endtask

task automatic test_ooo();
  begin
    suite_begin();
    build_ooo_probe();
    begin_test("ooo_load_overlap_rename");
    memory_wait = 12;
    set_dmem_word(768, 32'd100);
    release_reset();
    run_program(2000, 2000);
    check_reg(16, 32'd115);
    check_reg(17, 32'd2);
    check_reg(18, 32'd117);
    check_mem_word(772, 32'd117);
    checks_run = checks_run + 3;
    if (ooo_issue_count < 20) fail(cur_test, "missing issue evidence");
    if (ooo_bypass_count == 0 || ooo_overlap_count == 0)
      fail(cur_test, "no independent younger ALU execution while older load waits for external memory");
    if (retired_count !== 21) fail(cur_test, $sformatf("retired count expected 21 got %0d", retired_count));
    end_test();
    memory_wait = 0;
    suite_end("ooo");
    if (failures == suite_fail_start && verified_level == 2) verified_level = 3;
  end
endtask
