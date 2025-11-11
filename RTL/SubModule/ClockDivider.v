module ClockDivider #(
    parameter DIVISION_RATIO = 4
) (
    input wire clk_in,
    input wire rst_n,
    output reg clk_out
);
    localparam COUNTER_WIDTH = $clog2(DIVISION_RATIO);
    reg [COUNTER_WIDTH-1:0] counter;
    
    always @(posedge clk_in or negedge rst_n) begin
        if (!rst_n) begin
            counter <= {COUNTER_WIDTH{1'b0}};
            clk_out <= 1'b0;
        end else begin
            if (counter == (DIVISION_RATIO/2 - 1)) begin
                clk_out <= ~clk_out;
                counter <= {COUNTER_WIDTH{1'b0}};
            end else begin
                counter <= counter + 1'b1;
            end
        end
    end
endmodule