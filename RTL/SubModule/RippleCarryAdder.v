module RippleCarryAdder #(
    parameter WIDTH = 8
) (
    input wire [WIDTH-1:0] a,
    input wire [WIDTH-1:0] b,
    input wire cin,
    output wire [WIDTH-1:0] sum,
    output wire cout
);
    wire [WIDTH:0] carry;
    assign carry[0] = cin;
    assign cout = carry[WIDTH];
    genvar i;
    generate
        for (i = 0; i < WIDTH; i = i + 1) begin : adder_chain
            FullAdder fa_inst (
                .a(a[i]),
                .b(b[i]),
                .cin(carry[i]),
                .sum(sum[i]),
                .cout(carry[i+1])
            );
        end
    endgenerate
endmodule