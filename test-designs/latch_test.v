module latch_test(
    input wire clk,
    input wire reset,
    input wire btn,
    output reg led
);

    // Press btn: LED turns on and STAYS on
    // Press reset: LED turns off
    always @(posedge clk or posedge reset) begin
        if (reset)
            led <= 0;
        else if (btn)
            led <= 1;
    end

endmodule
