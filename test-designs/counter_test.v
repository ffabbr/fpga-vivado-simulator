`timescale 1ns / 1ps

module counter_test(
    input wire clk,
    input wire reset,
    input wire inc,
    output reg [3:0] count
);

    always @(posedge clk or posedge reset) begin
        if (reset)
            count <= 4'b0000;
        else if (inc)
            count <= count + 1;
    end

endmodule
