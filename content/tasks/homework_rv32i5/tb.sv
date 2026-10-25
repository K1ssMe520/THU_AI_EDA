`timescale 1ns/1ps
// Shared RV32I teaching harness. Legacy baseline and all extension levels use this top.
// Teacher-only helpers are split by responsibility; compile with -I <this directory>.
module tb_homework_rv32i5;
`include "tb/setup.svh"
`include "tb/assembler.svh"
`include "tb/harness.svh"
`include "tb/base_alu.svh"
`include "tb/base_memory.svh"
`include "tb/base_control.svh"
`include "tb/dft.svh"
`include "tb/extensions.svh"
`include "tb/benchmarks.svh"
`include "tb/run.svh"
endmodule

module tb_agent_rv32i5;
  tb_homework_rv32i5 u_teacher_tb();
endmodule
