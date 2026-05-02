#!/usr/bin/env fish

for f in *.mod; python3 mod2taud.py $f assets/disk0/(basename $f .mod).taud; end
for f in *.s3m; python3 s3m2taud.py $f assets/disk0/(basename $f .s3m).taud; end
for f in *.it; python3 it2taud.py $f assets/disk0/(basename $f .it).taud; end
for f in *.xm; python3 xm2taud.py $f assets/disk0/(basename $f .xm).taud; end
