10 WRITER=[VALUE]~>{VALUE,{}}
20 UNIT=[VALUE]~>{VALUE,{}}
30 SQUARED=[X]~>{X*X,{""+X+" WAS SQUARED. "}}
40 HALVED=[X]~>{X/2,{""+X+" WAS HALVED. "}}
50 BIND=[WRITER,TRANSFORM]~>(WRITER() >>= ([VALUELOG]~>(TRANSFORM(VALUELOG(0)) >>= ([RESULTUPDATES]~>(MRET({RESULTUPDATES(0), VALUELOG(1) # RESULTUPDATES(1)}))))))
60 PIPELOG=[WRITER,TRANSFORMS]~>FOLD(BIND,WRITER,TRANSFORMS)
100 LOGOBJ=PIPELOG(UNIT(4),{SQUARED,HALVED})
110 PRINT(LOGOBJ)