module fp_multiplier (
    input clk,
    input rst_n,
    input [15:0] A,
    input [15:0] B,
    input Ready,
    output reg [15:0] C,
    output reg Valid
);

// Pipeline stage 0: Input registration
reg [15:0] A_reg, B_reg;
reg Ready_reg;

// Pipeline stage 1: Special case detection and mantissa extraction
reg sign_A_reg, sign_B_reg;
reg [4:0] exp_A_reg, exp_B_reg;
reg [9:0] mant_A_reg, mant_B_reg;
reg sign_C_reg;
reg C_is_nan_reg, C_is_inf_reg, C_is_zero_reg;
reg Ready_reg1;

// Pipeline stage 2: Multiplication and normalization
reg [21:0] product_sig_reg;
reg signed [5:0] exp_sum_unbiased_reg;
reg sign_C_reg2;
reg C_is_nan_reg2, C_is_inf_reg2, C_is_zero_reg2;
reg Ready_reg2;

// Pipeline stage 3: Rounding and final result
reg [15:0] computed_C_reg;
reg Ready_reg3;

// Extract components from A and B
wire sign_A = A_reg[15];
wire [4:0] exp_A = A_reg[14:10];
wire [9:0] mant_A = A_reg[9:0];
wire sign_B = B_reg[15];
wire [4:0] exp_B = B_reg[14:10];
wire [9:0] mant_B = B_reg[9:0];

// Special case detection
wire A_is_zero = (exp_A == 5'b0) && (mant_A == 10'b0);
wire A_is_inf = (exp_A == 5'b11111) && (mant_A == 10'b0);
wire A_is_nan = (exp_A == 5'b11111) && (mant_A != 10'b0);
wire B_is_zero = (exp_B == 5'b0) && (mant_B == 10'b0);
wire B_is_inf = (exp_B == 5'b11111) && (mant_B == 10'b0);
wire B_is_nan = (exp_B == 5'b11111) && (mant_B != 10'b0);

wire sign_C = sign_A ^ sign_B;
wire C_is_nan = A_is_nan || B_is_nan || (A_is_inf && B_is_zero) || (A_is_zero && B_is_inf);
wire C_is_inf = (A_is_inf || B_is_inf) && !C_is_nan;
wire C_is_zero = (A_is_zero || B_is_zero) && !C_is_nan;

// Normal case signals
wire [10:0] sig_A_int = (exp_A == 5'b0) ? {1'b0, mant_A} : {1'b1, mant_A};
wire [10:0] sig_B_int = (exp_B == 5'b0) ? {1'b0, mant_B} : {1'b1, mant_B};
wire [21:0] product_sig = sig_A_int * sig_B_int;

// Unbiased exponents
wire signed [5:0] exp_A_unbiased = (exp_A == 5'b0) ? -6'sd14 : ($signed({1'b0, exp_A}) - 6'sd15);
wire signed [5:0] exp_B_unbiased = (exp_B == 5'b0) ? -6'sd14 : ($signed({1'b0, exp_B}) - 6'sd15);
wire signed [5:0] exp_sum_unbiased = exp_A_unbiased + exp_B_unbiased;

// Pipeline stage 0: Register inputs
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        A_reg <= 16'b0;
        B_reg <= 16'b0;
        Ready_reg <= 1'b0;
    end else begin
        A_reg <= A;
        B_reg <= B;
        Ready_reg <= Ready;
    end
end

// Pipeline stage 1: Extract and detect special cases
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        sign_A_reg <= 1'b0;
        sign_B_reg <= 1'b0;
        exp_A_reg <= 5'b0;
        exp_B_reg <= 5'b0;
        mant_A_reg <= 10'b0;
        mant_B_reg <= 10'b0;
        sign_C_reg <= 1'b0;
        C_is_nan_reg <= 1'b0;
        C_is_inf_reg <= 1'b0;
        C_is_zero_reg <= 1'b0;
        Ready_reg1 <= 1'b0;
    end else begin
        sign_A_reg <= sign_A;
        sign_B_reg <= sign_B;
        exp_A_reg <= exp_A;
        exp_B_reg <= exp_B;
        mant_A_reg <= mant_A;
        mant_B_reg <= mant_B;
        sign_C_reg <= sign_C;
        C_is_nan_reg <= C_is_nan;
        C_is_inf_reg <= C_is_inf;
        C_is_zero_reg <= C_is_zero;
        Ready_reg1 <= Ready_reg;
    end
end

// Pipeline stage 2: Multiplication and normalization
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        product_sig_reg <= 22'b0;
        exp_sum_unbiased_reg <= 6'b0;
        sign_C_reg2 <= 1'b0;
        C_is_nan_reg2 <= 1'b0;
        C_is_inf_reg2 <= 1'b0;
        C_is_zero_reg2 <= 1'b0;
        Ready_reg2 <= 1'b0;
    end else begin
        product_sig_reg <= product_sig;
        exp_sum_unbiased_reg <= exp_sum_unbiased;
        sign_C_reg2 <= sign_C_reg;
        C_is_nan_reg2 <= C_is_nan_reg;
        C_is_inf_reg2 <= C_is_inf_reg;
        C_is_zero_reg2 <= C_is_zero_reg;
        Ready_reg2 <= Ready_reg1;
    end
end

// Normalization logic (combinatorial)
reg [21:0] product_sig_shifted;
reg signed [5:0] exp_shifted;
reg G;
reg Sticky;

always @* begin
    integer L;
    integer shift_count;
    reg sticky_temp;
    integer i;
    
    // Find leading one
    L = 21;
    while (L >= 0 && product_sig_reg[L] == 1'b0) begin
        L = L - 1;
    end
    if (L < 0) L = 0;

    // Normalization
    if (L < 10) begin
        shift_count = 10 - L;
        product_sig_shifted = product_sig_reg << shift_count;
        exp_shifted = exp_sum_unbiased_reg - shift_count;
        G = 1'b0;
        Sticky = 1'b0;
    end else if (L > 10) begin
        shift_count = L - 10;
        product_sig_shifted = product_sig_reg >> shift_count;
        exp_shifted = exp_sum_unbiased_reg + shift_count;
        G = product_sig_reg[shift_count - 1];
        sticky_temp = 1'b0;
        for (i = 0; i < shift_count - 1; i = i + 1) begin
            sticky_temp = sticky_temp | product_sig_reg[i];
        end
        Sticky = sticky_temp;
    end else begin
        product_sig_shifted = product_sig_reg;
        exp_shifted = exp_sum_unbiased_reg;
        G = 1'b0;
        Sticky = 1'b0;
    end
end

// Significand after normalization
wire [10:0] S = product_sig_shifted[10:0];

// Round to nearest even
wire round_up = G && (Sticky || S[0]);
wire [11:0] S_rounded_temp = round_up ? {1'b0, S} + 1 : {1'b0, S};
wire [10:0] S_final = S_rounded_temp[11] ? 11'b10000000000 : S_rounded_temp[10:0];
wire signed [5:0] exp_final = S_rounded_temp[11] ? exp_shifted + 1 : exp_shifted;

// Check for underflow and overflow
wire [15:0] C_normal;
assign C_normal = (exp_final < -14) ? {sign_C_reg2, 5'b0, 10'b0} :
                  (exp_final > 15) ? {sign_C_reg2, 5'b11111, 10'b0} :
                  {sign_C_reg2, exp_final + 5'sd15, S_final[9:0]};

// Final computed C
wire [15:0] computed_C;
assign computed_C = C_is_nan_reg2 ? 16'h7E00 :
                    C_is_inf_reg2 ? {sign_C_reg2, 5'b11111, 10'b0} :
                    C_is_zero_reg2 ? {sign_C_reg2, 5'b0, 10'b0} :
                    C_normal;

// Pipeline stage 3: Final output
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        computed_C_reg <= 16'b0;
        Ready_reg3 <= 1'b0;
    end else begin
        computed_C_reg <= computed_C;
        Ready_reg3 <= Ready_reg2;
    end
end

// Final output assignment
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        Valid <= 1'b0;
        C <= 16'b0;
    end else begin
        Valid <= Ready_reg3;
        C <= computed_C_reg;
    end
end

endmodule