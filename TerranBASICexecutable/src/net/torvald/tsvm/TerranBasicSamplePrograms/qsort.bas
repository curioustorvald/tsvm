10 QSORT = [XS] ~> IF (LEN(XS) < 1) THEN NIL ELSE QSORT(FILTER([X] ~> X <  HEAD XS, TAIL XS)) # {HEAD XS} # QSORT(FILTER([X] ~> X >= HEAD XS, TAIL XS))
100 L={7,9,4,5,2,3,1,8,6}
110 PRINT L
120 PRINT QSORT(L)