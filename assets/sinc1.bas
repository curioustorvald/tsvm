1 ZEROLINE=10
2 AMP=20
3 GOTO 1000
100 LABEL SINCQ:REM gets Sinc(Q)
110 Q=IF I==0 THEN 1.0 ELSE SIN(I)/I
120 RETURN
200 LABEL PLOTLINE:REM Converts 0-1 value into screen line. input is Q, results are stored to SQ
210 SQ=CHR(0)
220 FOR X=1 TO ZEROLINE+AMP
230 SQ=SQ+(IF X==ROUND(ZEROLINE+Q*AMP) THEN "@" ELSE IF X==10 THEN "|" ELSE CHR(250))
240 NEXT
250 RETURN
1000 FOR I=0 TO 20
1010 GOSUB SINCQ
1020 GOSUB PLOTLINE
1030 PRINT(SQ)
1040 NEXT