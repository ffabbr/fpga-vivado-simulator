`timescale 1ns / 1ps
//////////////////////////////////////////////////////////////////////////////////
// Company: 
// Engineer: 
// 
// Create Date: 04/27/2026 01:35:18 PM
// Design Name: 
// Module Name: Thunderbird_test
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


module Thunderbird_test();

    reg clock;
    reg reset;
    reg left;
    reg right;
    
    wire [5:0] lights;
    
    Thunderbird auto (
        clock, 
        reset, 
        left, 
        right, 
        lights
    );
    
    always begin
        clock = 1; #50;
        clock = 0; #50;
    end
    
    initial begin
        clock = 0;
        reset = 1;  
        left = 0;
        right = 0;
        
        #50;
        reset = 0;
        
        #100;
        right = 1;
        #1000000000;
        
        $finish;
    end
endmodule
