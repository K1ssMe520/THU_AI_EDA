initial begin
  cur_test = "power_on";
  rst_n = 0;
  dbg_reg_addr = 0;
  #1;
  detect_capabilities();
  suite_begin();
  checks_run = checks_run + 1;
  if (dmem_valid !== 0) fail("power_on_reset", "dmem_valid must be 0 before the first reset edge");
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
  // Exact 1-bubble load-use timing is a baseline microarchitecture contract.
  if (declared_level == 0) test_t12_stall_cycles();
  test_t13_dft();
  suite_end("base");
  if (failures == suite_fail_start) verified_level = 0;
  if (declared_level >= 1) test_cache(); else suite_skip("cache");
  if (declared_level >= 2) test_predictor(); else suite_skip("predictor");
  if (declared_level >= 3) test_ooo(); else suite_skip("ooo");
  run_benchmarks();
  $display("AI_EDA_CAPABILITY|level=%0d|name=rv32i|declared=%0d|verified=%0d|expected=%0d|features=%0d",
           declared_level, declared_level, verified_level, expected_cpu_level, dbg_features);
  repeat (2) @(posedge clk);
  #1;
  if (failures == 0) $display("LAB_RESULT: PASS (%0d tests, %0d checks)", tests_run, checks_run);
  else begin
    $display("LAB_RESULT: FAIL (%0d failures / %0d checks)", failures, checks_run);
    $fatal(1);
  end
  $finish;
end
