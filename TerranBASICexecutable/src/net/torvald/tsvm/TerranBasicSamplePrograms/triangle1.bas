10 GOTO 1000
100 REM subroutine to draw a segment. Size is stored to 'Q'
110 PRINT SPC(20-Q);
120 Q1=1 : REM loop counter for this subroutine
130 PRINT "*";
140 Q1=Q1+1
150 IF Q1<=Q*2-1 THEN GOTO 130
160 PRINT : RETURN : REM this line will take us back from the jump
1000 Q=1 : REM this is our loop counter
1010 GOSUB 100
1020 Q=Q+1
1030 IF Q<=20 THEN GOTO 1010
