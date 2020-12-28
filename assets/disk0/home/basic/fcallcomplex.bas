1 optiontrace 1:optiondebug 1
10 defun fun(x)=2^x
20 defun apply(f,x)=f((x+1)/2)
30 k=apply(fun,6)
40 print k
50 print typeof k
60 unresolve k
70 resolve k
