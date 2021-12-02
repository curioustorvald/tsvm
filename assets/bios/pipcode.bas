10 print("polling radar...")
20 s=cput(1,"POLL")
30 if s><0 then goto 900
40 l=cget(1,0)
41 print("length: "+l+", pixels: "+l/3)
50 for i=0 to l step 3
60 m=peek(i)*160+peek(i+1)
62 p=peek(i+2)
63 poke(-1048576-m,p)
70 next
899 end
900 print("Polling failed: "+s)
