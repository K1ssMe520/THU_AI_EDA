module ArrayMultiplier #(
    parameter WIDTH_A = 8,
    parameter WIDTH_B = 8,
    parameter OUTPUT_WIDTH = WIDTH_A + WIDTH_B
) (
    input wire [WIDTH_A-1:0] a,
    input wire [WIDTH_B-1:0] b,
    output wire [OUTPUT_WIDTH-1:0] product
);
    wire [WIDTH_A-1:0] partial_products [WIDTH_B-1:0];
    wire [OUTPUT_WIDTH-1:0] sum_array [WIDTH_B:0];
    
    assign sum_array[0] = {OUTPUT_WIDTH{1'b0}};
    genvar i, j;
    generate
        // Generate partial products
        for (i = 0; i < WIDTH_B; i = i + 1) begin : pp_gen
            assign partial_products[i] = a & {WIDTH_A{b[i]}};
        end
        // Array of adders
        for (i = 0; i < WIDTH_B; i = i + 1) begin : adder_array
            wire [OUTPUT_WIDTH-1:0] extended_pp = 
                {{(OUTPUT_WIDTH-WIDTH_A-i){1'b0}}, 
                 partial_products[i], 
                 {i{1'b0}}};
            
            RippleCarryAdder #(
                .WIDTH(OUTPUT_WIDTH)
            ) rca_inst (
                .a(sum_array[i]),
                .b(extended_pp),
                .cin(1'b0),
                .sum(sum_array[i+1]),
                .cout() // Unused in this simple implementation
            );
        end
    endgenerate
    assign product = sum_array[WIDTH_B];
endmodule