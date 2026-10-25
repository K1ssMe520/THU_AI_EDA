"""Execute benchmark assembly with an independent one-cycle ISA model."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TB = ROOT / "content/tasks/homework_rv32i5"


@unittest.skipUnless(shutil.which("iverilog") and shutil.which("vvp"), "Icarus not installed")
class TeacherProgramTests(unittest.TestCase):
    def test_benchmark_assembly_and_checksums(self):
        with tempfile.TemporaryDirectory(prefix="rv32i-teacher-") as temporary:
            work = Path(temporary)
            harness = work / "bench.sv"
            harness.write_text('''`timescale 1ns/1ps
module tb_homework_rv32i5;
`include "tb/setup.svh"
`include "tb/assembler.svh"
`include "tb/harness.svh"
`include "tb/extensions.svh"
`include "tb/benchmarks.svh"
initial begin
  cur_test = "selftest"; rst_n = 0; dbg_reg_addr = 0;
  #1; run_benchmarks();
  if (failures) $fatal(1,"benchmark self-test failed");
  $display("TEACHER_PROGRAM_SELFTEST_PASS"); $finish;
end
endmodule
''', encoding="utf-8")
            executable = work / "simulation"
            compile_result = subprocess.run([
                "iverilog", "-g2012", "-I", str(TB), "-s", "tb_homework_rv32i5",
                "-o", str(executable), str(harness),
                str(ROOT / "tests/fixtures/rv32i_reference.sv"),
            ], capture_output=True, text=True, timeout=30)
            self.assertEqual(compile_result.returncode, 0, compile_result.stderr)
            simulation = subprocess.run(["vvp", str(executable)], capture_output=True, text=True, timeout=30)
            self.assertEqual(simulation.returncode, 0, simulation.stdout[-5000:] + simulation.stderr)
            self.assertIn("TEACHER_PROGRAM_SELFTEST_PASS", simulation.stdout)
            self.assertIn("benchmark=teaching_crc32_64bytes", simulation.stdout)
            self.assertIn("benchmark=teaching_array_sum64|cycles=324|instructions=324", simulation.stdout)


if __name__ == "__main__":
    unittest.main()
