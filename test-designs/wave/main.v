`timescale 1ns / 1ps
//////////////////////////////////////////////////////////////////////////////////
// Company: 
// Engineer: 
// 
// Create Date: 04/17/2026 09:12:34 AM
// Design Name: 
// Module Name: main
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


module main(
    input [31:0] A,
    input [31:0] B,
    input [3:0] AluOp,
    output[31:0] out,
    output zero
    );
    
    wire[31:0] ari_out;
    wire[31:0] logic_out;
    
//    arithmetic ari (A, B, AluOp, ari_out);
//    logic logi (A, B, AluOp, logic_out);
    
//    Multiplexer multi (ari_out, logic_out, AluOp[2], out);

    bad_ALU alu (A, B, AluOp, out);
    assign zero = ~|out;
    
    
endmodule


