10 F=[X]~>X*2 : G=[X]~>X^3 : RETN=[X]~>MRET(X)

100 PRINT:PRINT "First law: 'return a >>= k' equals to 'k a'"
110 K=[X]~>RETN(F(X)) : REM K is monad-returning function
120 A=42
130 KM=RETN(A)>>=K
140 KO=K(A)
150 PRINT("KM is ";TYPEOF(KM);", ";MJOIN(KM))
160 PRINT("KO is ";TYPEOF(KO);", ";MJOIN(KO))

200 PRINT:PRINT "Second law: 'm >>= return' equals to 'm'"
210 M=MRET(G(42))
220 MM=M>>=RETN
230 MO=M
240 PRINT("MM is ";TYPEOF(MM);", ";MJOIN(MM))
250 PRINT("MO is ";TYPEOF(MO);", ";MJOIN(MO))

300 PRINT:PRINT "Third law: 'm >>= (\x -> k x >>= h)' equals to '(m >>= k) >>= h'"
310 REM see line 110 for the definition of K
320 H=[X]~>RETN(G(X)) : REM H is monad-returning function
330 M=MRET(69)
340 M1=M>>=([X]~>K(X)>>=H)
350 M2=(M>>=K)>>=H
360 PRINT("M1 is ";TYPEOF(M1);", ";MJOIN(M1))
370 PRINT("M2 is ";TYPEOF(M2);", ";MJOIN(M2))
