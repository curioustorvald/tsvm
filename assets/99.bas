1 FOR I = 99 TO 1
2   MODE = 1
3   GOSUB 12
4   PRINT(I+" bottle"+BOTTLES$+" of beer on the wall, "+i+" bottle"+BOTTLES$+" of beer.")
5   MODE = 2
6   GOSUB 12
7   PRINT("Take one down and pass it around, "+(i-1)+" bottle"+BOTTLES$+" of beer on the wall.")
8 NEXT
9 PRINT "No more bottles of beer on the wall, no more bottles of beer."
10 PRINT "Go to the store and buy some more. 99 bottles of beer on the wall."
11 GOTO 999
12 IF I == MODE THEN BOTTLES$ = "" ELSE BOTTLES$ = "s"
13 RETURN
