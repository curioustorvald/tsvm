10 A={{"O","X","O"},{"X","O","X"},{"X","X","O"}}
20 FOR Y=0 TO LEN(A)-1
30   FOR X=0 TO LEN(A(Y))-1
40     PRINT(A(Y,X);" ";)
50   NEXT
60   PRINT
70 NEXT
