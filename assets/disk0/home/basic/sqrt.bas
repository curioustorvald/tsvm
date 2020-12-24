1 REM Calculates a square root using newtonian method
20 INPUT X
30 Y = 0.5 * X
40 Z = Y
50 Y = Y-(((Y^2)-X)/(2*Y))
60 IF Z <> Y THEN GOTO 40
100 PRINT "Square root of ";X;" is approximately ";Y
