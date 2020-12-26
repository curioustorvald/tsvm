1 OPTIONDEBUG 1:OPTIONTRACE 1
10 DEFUN APPLY(X,F)=F(X):REM bug- F<~X must return function and F(X) must return value but right now they both return a function?
20 DEFUN FUN(X)=X^2
30 K=APPLY(42,FUN)
100 PRINT K
110 PRINT TYPEOF K
120 RESOLVE K
