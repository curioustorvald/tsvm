10 X=1337
20 Y=0.5*X
30 Z=Y
40 Y=Y-((Y^2)-X)/(2*Y)
50 IF NOT(Z==Y) THEN GOTO 30 : REM 'NOT(Z==Y)' can be rewritten to 'Z<>Y' 
100 PRINT "Square root of ";X;" is approximately ";Y
