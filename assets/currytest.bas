10 DEFUN F(K,T)=ABS(T)==K
11 CF=CURRY(F,32)
20 PRINT TYPEOF(F):REM must be usrdefun
21 PRINT TYPEOF(CF):REM also must be usrdefun
30 PRINT CF(24):PRINT CF(-32)
31 REM Expected printout: false true
