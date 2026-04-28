`timescale 1ns / 1ps

module Thunderbird(
    input  wire       clock,
    input  wire       reset,
    input  wire       left,
    input  wire       right,
    output wire [5:0] lights
);

    localparam S0 = 3'b000;
    localparam L1 = 3'b001;
    localparam L2 = 3'b010;
    localparam L3 = 3'b011;
    localparam R1 = 3'b100;
    localparam R2 = 3'b101;
    localparam R3 = 3'b110;

    reg [2:0] state_p;
    reg [2:0] state_n;
    reg [5:0] run;

    wire tick;

    clk_div slow_clock (
        .clk(clock),
        .rst(reset),
        .clk_en(tick)
    );

    always @(posedge clock or posedge reset) begin
        if (reset)
            state_p <= S0;
        else if (tick)
            state_p <= state_n;
    end

    always @(*) begin
        case (state_p)
            S0: begin
                if (right)
                    state_n = R1;
                else if (left)
                    state_n = L1;
                else
                    state_n = S0;
            end

            L1: state_n = L2;
            L2: state_n = L3;
            L3: state_n = S0;

            R1: state_n = R2;
            R2: state_n = R3;
            R3: state_n = S0;

            default: state_n = S0;
        endcase
    end

    always @(*) begin
        case (state_p)
            S0: run = 6'b000000;

            L1: run = 6'b001000;
            L2: run = 6'b011000;
            L3: run = 6'b111000;

            R1: run = 6'b000100;
            R2: run = 6'b000110;
            R3: run = 6'b000111;

            default: run = 6'b000000;
        endcase
    end

    dim_led led5 (.clock(clock), .reset(reset), .run(run[5]), .led_out(lights[5]));
    dim_led led4 (.clock(clock), .reset(reset), .run(run[4]), .led_out(lights[4]));
    dim_led led3 (.clock(clock), .reset(reset), .run(run[3]), .led_out(lights[3]));
    dim_led led2 (.clock(clock), .reset(reset), .run(run[2]), .led_out(lights[2]));
    dim_led led1 (.clock(clock), .reset(reset), .run(run[1]), .led_out(lights[1]));
    dim_led led0 (.clock(clock), .reset(reset), .run(run[0]), .led_out(lights[0]));

endmodule


module clk_div(
    input  wire clk,
    input  wire rst,
    output wire clk_en
);

    reg [23:0] clk_count;

    always @(posedge clk or posedge rst) begin
        if (rst)
            clk_count <= 24'd0;
        else
            clk_count <= clk_count + 24'd1;
    end

    assign clk_en = &clk_count;

endmodule


module dim_led(
    input  wire clock,
    input  wire reset,
    input  wire run,
    output wire led_out
);

    reg [10:0] pwm_counter;
    reg [10:0] brightness;
    reg [15:0] fade_counter;

    localparam [10:0] MAX_BRIGHTNESS = 11'd2047;

    always @(posedge clock or posedge reset) begin
        if (reset) begin
            pwm_counter  <= 11'd0;
            brightness   <= 11'd0;
            fade_counter <= 16'd0;
        end else begin
            pwm_counter <= pwm_counter + 11'd1;

            if (run) begin
                fade_counter <= fade_counter + 16'd1;

                if (fade_counter == 16'd0 && brightness < MAX_BRIGHTNESS)
                    brightness <= brightness + 11'd1;
            end else begin
                brightness   <= 11'd0;
                fade_counter <= 16'd0;
            end
        end
    end

    assign led_out = run && (pwm_counter < brightness);

endmodule