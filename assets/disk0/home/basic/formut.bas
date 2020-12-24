1 k=0
2 goto 100
20 k=1
30 a=10
40 return
100 for a=5 to 1 step -1
110 print a
120 if a==3 and k==0 then gosub 20
130 next
140 print "=="
150 print a
1000 rem expected output according to gw-basic:
1001 rem 5 4 3 9 8 7 6 5 4 3 2 1 == 0
