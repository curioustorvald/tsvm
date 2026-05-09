#!/usr/bin/env fish

for f in *.mod; python3 mod2taud.py $f assets/disk0/home/music/(basename $f .mod).taud; end
for f in *.s3m; python3 s3m2taud.py $f assets/disk0/home/music/(basename $f .s3m).taud; end
for f in *.it; python3 it2taud.py $f assets/disk0/home/music/(basename $f .it).taud; end
for f in *.xm; python3 xm2taud.py $f assets/disk0/home/music/(basename $f .xm).taud; end
for f in *.mon; python3 mon2taud.py $f assets/disk0/home/music/(basename $f .mon).taud; end
for f in *.MON; python3 mon2taud.py $f assets/disk0/home/music/(basename $f .MON).taud; end
