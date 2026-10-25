// Simulation-only one-cycle ISA interpreter for validating teacher programs.
// It is deliberately not a student RTL solution and is never used by grading.
module rv32i5 (
  input clk, rst_n,
  output reg [31:0] imem_addr,
  input [31:0] imem_rdata,
  output reg dmem_valid, dmem_we,
  output reg [31:0] dmem_addr, dmem_wdata,
  output reg [3:0] dmem_be,
  input [31:0] dmem_rdata,
  input [4:0] dbg_reg_addr,
  output [31:0] dbg_reg_data,
  output reg halted,
  output reg [31:0] exit_code
);
  reg [31:0] regs[0:31];
  reg [31:0] next_pc, result, lhs, rhs, imm, word;
  reg write_rd;
  integer i;
  wire [6:0] op = imem_rdata[6:0];
  wire [2:0] f3 = imem_rdata[14:12];
  wire [4:0] rd = imem_rdata[11:7];
  assign dbg_reg_data = dbg_reg_addr == 0 ? 0 : regs[dbg_reg_addr];
  always @* begin
    lhs = regs[imem_rdata[19:15]];
    rhs = regs[imem_rdata[24:20]];
    imm = {{20{imem_rdata[31]}}, imem_rdata[31:20]};
    next_pc = imem_addr + 4;
    result = 0; write_rd = 0;
    dmem_valid = 0; dmem_we = 0; dmem_be = 0;
    dmem_addr = lhs + imm; dmem_wdata = rhs;
    word = dmem_rdata >> (8 * dmem_addr[1:0]);
    case (op)
      7'h37: begin result = {imem_rdata[31:12],12'b0}; write_rd = 1; end
      7'h17: begin result = imem_addr + {imem_rdata[31:12],12'b0}; write_rd = 1; end
      7'h13: begin
        write_rd = 1;
        case (f3)
          0: result = lhs + imm;
          1: result = lhs << imem_rdata[24:20];
          2: result = $signed(lhs) < $signed(imm);
          3: result = lhs < imm;
          4: result = lhs ^ imm;
          5: result = imem_rdata[30] ? $signed(lhs) >>> imem_rdata[24:20] : lhs >> imem_rdata[24:20];
          6: result = lhs | imm;
          7: result = lhs & imm;
        endcase
      end
      7'h33: begin
        write_rd = 1;
        case (f3)
          0: result = imem_rdata[30] ? lhs - rhs : lhs + rhs;
          1: result = lhs << rhs[4:0];
          2: result = $signed(lhs) < $signed(rhs);
          3: result = lhs < rhs;
          4: result = lhs ^ rhs;
          5: result = imem_rdata[30] ? $signed(lhs) >>> rhs[4:0] : lhs >> rhs[4:0];
          6: result = lhs | rhs;
          7: result = lhs & rhs;
        endcase
      end
      7'h03: begin
        write_rd = 1; dmem_valid = rst_n && !halted;
        case (f3)
          0: result = {{24{word[7]}},word[7:0]};
          1: result = {{16{word[15]}},word[15:0]};
          2: result = word;
          4: result = {24'b0,word[7:0]};
          5: result = {16'b0,word[15:0]};
        endcase
      end
      7'h23: begin
        imm = {{20{imem_rdata[31]}},imem_rdata[31:25],imem_rdata[11:7]};
        dmem_addr = lhs + imm;
        dmem_valid = rst_n && !halted; dmem_we = 1;
        case (f3)
          0: begin dmem_be = 1 << dmem_addr[1:0]; dmem_wdata = {4{rhs[7:0]}}; end
          1: begin dmem_be = dmem_addr[1] ? 12 : 3; dmem_wdata = {2{rhs[15:0]}}; end
          2: dmem_be = 15;
        endcase
      end
      7'h63: begin
        imm = {{19{imem_rdata[31]}},imem_rdata[31],imem_rdata[7],imem_rdata[30:25],imem_rdata[11:8],1'b0};
        case (f3)
          0: if (lhs == rhs) next_pc = imem_addr + imm;
          1: if (lhs != rhs) next_pc = imem_addr + imm;
          4: if ($signed(lhs) < $signed(rhs)) next_pc = imem_addr + imm;
          5: if ($signed(lhs) >= $signed(rhs)) next_pc = imem_addr + imm;
          6: if (lhs < rhs) next_pc = imem_addr + imm;
          7: if (lhs >= rhs) next_pc = imem_addr + imm;
        endcase
      end
      7'h6f: begin
        imm = {{11{imem_rdata[31]}},imem_rdata[31],imem_rdata[19:12],imem_rdata[20],imem_rdata[30:21],1'b0};
        result = imem_addr + 4; write_rd = 1; next_pc = imem_addr + imm;
      end
      7'h67: begin result = imem_addr + 4; write_rd = 1; next_pc = (lhs + imm) & 32'hfffffffe; end
    endcase
  end
  always @(posedge clk) begin
    if (!rst_n) begin
      imem_addr <= 0; halted <= 0; exit_code <= 0;
      for (i=0;i<32;i=i+1) regs[i] <= 0;
    end else if (!halted) begin
      if (imem_rdata == 32'h00000073) begin halted <= 1; exit_code <= regs[10]; end
      else imem_addr <= next_pc;
      if (write_rd && rd != 0) regs[rd] <= result;
      regs[0] <= 0;
    end
  end
endmodule
