1 OPTIONBASE 1
2 GOTO STARTPOINT
100 LABEL PRINTA
110 PRINT "A"
120 RETURN
200 LABEL PRINTB
210 PRINT "B":PRINT "B"
220 RETURN
300 LABEL PRINTC
310 PRINT "C":PRINT 2+2
320 RETURN
1000 INPUT K:LABEL STARTPOINT
1001 IF K>3 OR K<1 THEN DO(PRINT "INPUT MUST BE 1,2 OR 3";GOTO STARTPOINT)
1010 ON K GOSUB PRINTA,PRINTB,PRINTC
1020 PRINT "BYE"
