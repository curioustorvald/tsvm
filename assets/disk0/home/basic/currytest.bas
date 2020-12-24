10 DEFUN F(K,T)=ABS(T)==K
20 CF=F<~32
30 PRINT CF(24) : REM will print 'false'
40 PRINT CF(-32) : REM will print 'true'
