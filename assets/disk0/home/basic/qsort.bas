1 REM qsort [] = []
2 REM qsort xs = qsort [x | x<-tail xs, x<head xs] ++ [head xs] ++ qsort [x | x<-tail xs, x>=head xs]
10 DEFUN LESS(P,X)=X<P
11 DEFUN GTEQ(P,X)=X>=P
12 DEFUN QSORT(XS)=IF LEN(XS)<1 THEN NIL ELSE QSORT(FILTER(LESS<~HEAD(XS),TAIL(XS))) # HEAD(XS)!NIL # QSORT(FILTER(GTEQ<~HEAD(XS),TAIL(XS)))
100 L=7!9!4!5!2!3!1!8!6!NIL
110 PRINT L
120 PRINT QSORT(L)
