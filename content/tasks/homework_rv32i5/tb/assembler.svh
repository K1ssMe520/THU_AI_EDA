  // ===========================================================================
  function automatic [31:0] enc_r(input [6:0] f7, input [4:0] rs2, input [4:0] rs1,
                                  input [2:0] f3, input [4:0] rd);
    enc_r = {f7, rs2, rs1, f3, rd, 7'b0110011};
  endfunction

  function automatic [31:0] enc_i(input integer imm, input [4:0] rs1,
                                  input [2:0] f3, input [4:0] rd, input [6:0] opcode);
    logic [31:0] u;
    begin
      u = imm;
      enc_i = {u[11:0], rs1, f3, rd, opcode};
    end
  endfunction

  function automatic [31:0] enc_s(input integer imm, input [4:0] rs2,
                                  input [4:0] rs1, input [2:0] f3);
    logic [31:0] u;
    begin
      u = imm;
      enc_s = {u[11:5], rs2, rs1, f3, u[4:0], 7'b0100011};
    end
  endfunction

  function automatic [31:0] enc_b(input integer imm, input [4:0] rs2,
                                  input [4:0] rs1, input [2:0] f3);
    logic [31:0] u;
    begin
      u = imm;
      enc_b = {u[12], u[10:5], rs2, rs1, f3, u[4:1], u[11], 7'b1100011};
    end
  endfunction

  function automatic [31:0] enc_u(input [31:0] imm, input [4:0] rd, input [6:0] opcode);
    enc_u = {imm[31:12], rd, opcode};
  endfunction

  function automatic [31:0] enc_j(input integer imm, input [4:0] rd);
    logic [31:0] u;
    begin
      u = imm;
      enc_j = {u[20], u[10:1], u[11], u[19:12], rd, 7'b1101111};
    end
  endfunction

  // ===========================================================================
  // 8. 程序装配（两遍：第 1 遍只记录标号地址，第 2 遍带正确偏移发射指令）
  // ===========================================================================
  localparam integer PROG_MAX = 192;

  logic [31:0] prog [0:PROG_MAX-1];
  integer prog_len = 0;
  integer pass_no  = 1;
  integer label_addr [0:31];

  localparam integer L0 = 0;
  localparam integer L1 = 1;
  localparam integer L2 = 2;
  localparam integer L3 = 3;
  localparam integer L4 = 4;
  localparam integer L5 = 5;
  localparam integer L6 = 6;
  localparam integer L7 = 7;
  localparam integer L8 = 8;
  localparam integer L9 = 9;
  localparam integer L10 = 10;
  localparam integer L11 = 11;
  localparam integer L12 = 12;
  localparam integer L13 = 13;
  localparam integer L14 = 14;
  localparam integer L20 = 20;
  localparam integer L21 = 21;
  localparam integer L22 = 22;
  localparam integer L23 = 23;
  localparam integer L24 = 24;
  localparam integer L25 = 25;
  localparam integer L26 = 26;
  localparam integer L27 = 27;

  task automatic emit(input [31:0] word);
    begin
      if (pass_no == 2) begin
        if (prog_len < PROG_MAX) begin
          prog[prog_len] = word;
        end else begin
          fail("program", $sformatf("程序长度超过 PROG_MAX=%0d", PROG_MAX));
        end
      end
      prog_len = prog_len + 1;
    end
  endtask

  task automatic mark(input integer id);
    begin
      if (pass_no == 1) label_addr[id] = prog_len * 4;
    end
  endtask

  // ------------------------------- R 型 --------------------------------------
  task automatic e_add (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b000, rd)); endtask
  task automatic e_sub (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0100000, rs2, rs1, 3'b000, rd)); endtask
  task automatic e_sll (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b001, rd)); endtask
  task automatic e_slt (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b010, rd)); endtask
  task automatic e_sltu(input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b011, rd)); endtask
  task automatic e_xor (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b100, rd)); endtask
  task automatic e_srl (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b101, rd)); endtask
  task automatic e_sra (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0100000, rs2, rs1, 3'b101, rd)); endtask
  task automatic e_or  (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b110, rd)); endtask
  task automatic e_and (input [4:0] rd, input [4:0] rs1, input [4:0] rs2); emit(enc_r(7'b0000000, rs2, rs1, 3'b111, rd)); endtask

  // ------------------------------ I 型 ALU -----------------------------------
  task automatic e_addi (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b000, rd, 7'b0010011)); endtask
  task automatic e_slti (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b010, rd, 7'b0010011)); endtask
  task automatic e_sltiu(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b011, rd, 7'b0010011)); endtask
  task automatic e_xori (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b100, rd, 7'b0010011)); endtask
  task automatic e_ori  (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b110, rd, 7'b0010011)); endtask
  task automatic e_andi (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b111, rd, 7'b0010011)); endtask
  task automatic e_slli (input [4:0] rd, input [4:0] rs1, input integer shamt); emit(enc_i(shamt, rs1, 3'b001, rd, 7'b0010011)); endtask
  task automatic e_srli (input [4:0] rd, input [4:0] rs1, input integer shamt); emit(enc_i(shamt, rs1, 3'b101, rd, 7'b0010011)); endtask
  task automatic e_srai (input [4:0] rd, input [4:0] rs1, input integer shamt); emit(enc_i(32'h400 + shamt, rs1, 3'b101, rd, 7'b0010011)); endtask

  // --------------------------- 上位立即数 ------------------------------------
  task automatic e_lui  (input [4:0] rd, input [31:0] imm); emit(enc_u(imm, rd, 7'b0110111)); endtask
  task automatic e_auipc(input [4:0] rd, input [31:0] imm); emit(enc_u(imm, rd, 7'b0010111)); endtask

  // ------------------------------ Load ---------------------------------------
  task automatic e_lb (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b000, rd, 7'b0000011)); endtask
  task automatic e_lh (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b001, rd, 7'b0000011)); endtask
  task automatic e_lw (input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b010, rd, 7'b0000011)); endtask
  task automatic e_lbu(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b100, rd, 7'b0000011)); endtask
  task automatic e_lhu(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b101, rd, 7'b0000011)); endtask

  // ------------------------------ Store --------------------------------------
  task automatic e_sb(input [4:0] rs2, input [4:0] rs1, input integer imm); emit(enc_s(imm, rs2, rs1, 3'b000)); endtask
  task automatic e_sh(input [4:0] rs2, input [4:0] rs1, input integer imm); emit(enc_s(imm, rs2, rs1, 3'b001)); endtask
  task automatic e_sw(input [4:0] rs2, input [4:0] rs1, input integer imm); emit(enc_s(imm, rs2, rs1, 3'b010)); endtask

  // ------------------------------ Branch -------------------------------------
  task automatic e_beq (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b000)); endtask
  task automatic e_bne (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b001)); endtask
  task automatic e_blt (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b100)); endtask
  task automatic e_bge (input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b101)); endtask
  task automatic e_bltu(input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b110)); endtask
  task automatic e_bgeu(input [4:0] rs1, input [4:0] rs2, input integer lbl); emit(enc_b(label_addr[lbl] - (prog_len * 4), rs2, rs1, 3'b111)); endtask

  // ------------------------------ Jump ---------------------------------------
  task automatic e_jal (input [4:0] rd, input integer lbl); emit(enc_j(label_addr[lbl] - (prog_len * 4), rd)); endtask
  task automatic e_jalr(input [4:0] rd, input [4:0] rs1, input integer imm); emit(enc_i(imm, rs1, 3'b000, rd, 7'b1100111)); endtask
  // rd = x0 基址 + 目标标号的绝对地址（目标地址 < 2048，落在 I 型立即数范围内）
  task automatic e_addi_abs(input [4:0] rd, input integer lbl, input integer delta); emit(enc_i(label_addr[lbl] + delta, 5'd0, 3'b000, rd, 7'b0010011)); endtask

  task automatic e_ecall(); emit(32'h0000_0073); endtask
  task automatic e_nop(); emit(NOP_WORD); endtask

