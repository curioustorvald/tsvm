10 GOTO 1000
100 REM subroutine to draw a segment. Size is stored to 'Q'
110 PRINT SPC(20-Q);
120 FOR Q1=1 TO Q*2-1
130 PRINT "*";
140 NEXT : PRINT
150 RETURN
1000 FOR Q=1 TO 20
1010 GOSUB 100
1020 NEXT
