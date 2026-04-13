module clkdiv_test(
    input wire clk,
    input wire btn,
    output reg led
);

    reg [3:0] counter;
    wire tick;

    always @(posedge clk)
        counter <= counter + 1;

    assign tick = &counter;

    always @(posedge clk)
        if (tick && btn)
            led <= ~led;

endmodule
