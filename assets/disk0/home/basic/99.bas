10 FOR I = 99 TO 1 STEP -1
20 MODE = 1
30 GOSUB 120
40 PRINT I;" bottle";BOTTLES;" of beer on the wall, ";i;" bottle";BOTTLES;" of beer."
50 MODE = 2
60 GOSUB 120
70 PRINT "Take one down and pass it around, ";(I-1);" bottle";BOTTLES;" of beer on the wall."
80 NEXT
90 PRINT "No more bottles of beer on the wall, no more bottles of beer."
100 PRINT "Go to the store and buy some more. 99 bottles of beer on the wall."
110 END
120 IF I == MODE THEN BOTTLES = "" ELSE BOTTLES = "s"
130 RETURN
