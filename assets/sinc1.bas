1 GOTO 1000
100 LABEL SINCQ:REM gets Sinc(Q)
110 Q=SIN(I)/I
120 RETURN
200 LABEL TOSPC
201 REM Converts 0-1 value into screen line
202 REM input is Q, results are stored to SQ
210 SQ="I":REM currently empty string literals can't be used because of bug
220 FOR X=1 TO 10 MAX 10+Q*20
230 SQ=SQ+(IF X==FIX(10+Q*20) THEN "@" ELSE IF X==10 THEN ":" ELSE " ")
240 NEXT
250 RETURN
1000 FOR I=1 TO 20
1010 GOSUB SINCQ
1020 GOSUB TOSPC
1030 PRINT(SQ)
1040 NEXT
