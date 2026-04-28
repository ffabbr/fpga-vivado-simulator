`timescale 1ns / 1ps
//////////////////////////////////////////////////////////////////////////////////
// Company: 
// Engineer: 
// 
// Create Date: 03/27/2026 08:44:12 AM
// Design Name: 
// Module Name: Thunderbird
// Project Name: 
// Target Devices: 
// Tool Versions: 
// Description: 
// 
// Dependencies: 
// 
// Revision:
// Revision 0.01 - File Created
// Additional Comments:
// 
//////////////////////////////////////////////////////////////////////////////////


module Thunderbird(
        input wire clock, 
        input wire reset, 
        input wire left, 
        input wire right,
        output wire [5:0] lights  
    );

    parameter S0 = 3'b000;
    parameter L1 = 3'b001;
    parameter L2 = 3'b010;
    parameter L3 = 3'b011;
    parameter R1 = 3'b100;
    parameter R2 = 3'b101;
    parameter R3 = 3'b111;
    
    reg [2:0] state_p;
    reg [2:0] state_n;
    wire new_clock;
    
    reg [5:0] run; 
    
    dim_led led1 (clock, reset, run[5], lights[5]);
    dim_led led2 (clock, reset, run[4], lights[4]);
    dim_led led3 (clock, reset, run[3], lights[3]);
    dim_led led4 (clock, reset, run[2], lights[2]);
    dim_led led5 (clock, reset, run[1], lights[1]);
    dim_led led6 (clock, reset, run[0], lights[0]);
    
    clk_div slow_clock (clock, reset, new_clock); 
    
    always @(posedge clock or posedge reset) begin 
        if (reset) state_p <= S0;
        else if (new_clock) state_p <= state_n;
    end
    
    always @(*) begin 
        case (state_p)
            S0: 
                if (right) state_n = R1;   
                else if (left && !right) state_n = L1;
                else state_n = S0;
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



endmodule


module clk_div(input clk, input rst, output clk_en); 
     reg [23:0] clk_count; 
     always @ (posedge clk) 
     // posedge defines a rising edge (transition from 0 to 1)  
         begin 
              if (rst) 
                clk_count <= 0; 
              else 
                 clk_count <= clk_count + 1; 
             end 
    assign clk_en = &clk_count; 
endmodule


module dim_led (
    input clock,
    input reset,
    input run,
    output led_out
);

    reg [10:0] clock_counter;      
    reg [10:0] brightness;   
    reg [15:0] adapted_clock;    

    always @(posedge clock or posedge reset) begin
        if (reset) begin
            clock_counter <= 0;
            brightness <= 0;
            adapted_clock <= 0;
        end
         
        else begin
            clock_counter <= clock_counter + 1;

            if (run && brightness < 16'b111111111111111) begin
                adapted_clock <= adapted_clock + 1;
                
                if (adapted_clock == 0) brightness <= brightness + 1;
                
            end 
            else begin
                brightness <= 0; 
                adapted_clock <= 0;
            end
        end
    end
    
    assign led_out = (clock_counter < brightness);
    

endmodule