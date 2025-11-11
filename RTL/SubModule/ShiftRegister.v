module ShiftRegister #(
    parameter WIDTH = 8,
    parameter SHIFT_DIRECTION = 1, // 0: left, 1: right
    parameter RESET_VALUE = {WIDTH{1'b0}}
) (
    input wire clk,
    input wire rst_n,
    input wire en,
    input wire shift_in,
    input wire [WIDTH-1:0] parallel_in,
    input wire load,
    output wire shift_out,
    output reg [WIDTH-1:0] parallel_out
);
    assign shift_out = (SHIFT_DIRECTION == 1) ? parallel_out[0] : parallel_out[WIDTH-1];
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            parallel_out <= RESET_VALUE;
        end else if (en) begin
            if (load) begin
                parallel_out <= parallel_in;
            end else begin
                if (SHIFT_DIRECTION == 1) begin
                    // Right shift
                    parallel_out <= {shift_in, parallel_out[WIDTH-1:1]};
                end else begin
                    // Left shift
                    parallel_out <= {parallel_out[WIDTH-2:0], shift_in};
                end
            end
        end
    end
endmodule