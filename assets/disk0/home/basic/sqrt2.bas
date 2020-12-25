1 REM Calculates a square root using newtonian method
10 INPUT X
11 IF TYPEOF(X)=="num" THEN GOTO 20
12 PRINT "Please type in a number, please";
13 GOTO 10
20 Y = 0.5 * X
30 Z = Y
40 Y = Y-(((Y^2)-X)/(2*Y))
50 IF NOT(Z==Y) THEN GOTO 30
100 PRINT "Square root of ";X;" is approximately ";Y
