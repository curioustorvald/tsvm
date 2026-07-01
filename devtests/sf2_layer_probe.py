#!/usr/bin/env python3
"""sf2_layer_probe.py — measure SoundFont *layering* depth in real .sf2 files.

A single MIDI note can excite several samples simultaneously in SF2: all preset
zones AND all instrument zones whose key/vel rectangles contain the note sound
at once (SF2 has no "first zone wins" — that is a midi2taud invention). Raw
"how many zones overlap" wildly overstates musical layering, because real banks
contain three kinds of non-timbral multiplicity:

  * EXACT DUPLICATE zones (a bank-merge artifact; same sampleID + same gens —
    the spec doubles amplitude),
  * STEREO pairs (two samples, hard-panned -500/+500 or true L/R sampleLink —
    one mono voice once mixed down),
  * DETUNE STACKS (the same sample at a different coarse/fine tune for a fatter
    sound — distinct pitched layers).

So we report four depths at each preset's busiest (key,vel) point:
  M1 zones      raw simultaneous zones (what a compliant synth mixes)
  M2 samples    distinct sampleIDs
  M3 pitched    distinct (sampleID, coarseTune, fineTune) — real pitched layers
  M4 voices     M3 after collapsing stereo pairs to one mono voice
                == minimum mono voices a faithful Taud rendering needs per note
"""
import struct, sys, collections

GEN_INSTRUMENT=41; GEN_SAMPLEID=53; GEN_KEYRANGE=43; GEN_VELRANGE=44
GEN_PAN=17; GEN_COARSE=51; GEN_FINE=52
_SIGNED={GEN_PAN,GEN_COARSE,GEN_FINE}

def _u16(b,o): return struct.unpack_from('<H',b,o)[0]
def _amt(op,raw): return (raw-0x10000 if raw>=0x8000 else raw) if op in _SIGNED else raw

def read_chunks(path):
    f=open(path,'rb');hdr=f.read(12)
    if hdr[:4]!=b'RIFF' or hdr[8:12]!=b'sfbk': sys.exit(f"{path}: not sfbk")
    end=8+struct.unpack_from('<I',hdr,4)[0]; pdta={}; pos=12
    while pos+8<=end:
        f.seek(pos);ch=f.read(8)
        if len(ch)<8: break
        cid,sz=ch[:4],struct.unpack_from('<I',ch,4)[0]
        if cid==b'LIST':
            lt=f.read(4);inner,ie=pos+12,pos+8+sz
            while inner+8<=ie:
                f.seek(inner);sh=f.read(8);scid,ssz=sh[:4],struct.unpack_from('<I',sh,4)[0]
                if lt==b'pdta': pdta[scid.decode('latin-1')]=f.read(ssz)
                inner+=8+ssz+(ssz&1)
        pos+=8+sz+(sz&1)
    f.close();return pdta

def parse_bags(bag,gen,b0,b1,terminal):
    glob,zones={},[]; nbags=len(bag)//4; ngen=len(gen)//4
    for bi in range(b0,b1):
        g0=_u16(bag,bi*4); g1=_u16(bag,(bi+1)*4) if bi+1<nbags else ngen
        gens={}
        for gi in range(g0,min(g1,ngen)):
            op,raw=struct.unpack_from('<HH',gen,gi*4); gens[op]=_amt(op,raw)
        if terminal in gens: zones.append(gens)
        elif bi==b0 and not zones: glob=gens
    return glob,zones

class S: __slots__=('name','link','stype')

def _zones_at(eff):
    """Given effective zone tuples, return list of busiest points' zone-lists."""
    keys=sorted({z['klo'] for z in eff}|{z['khi'] for z in eff})
    vels=sorted({z['vlo'] for z in eff}|{z['vhi'] for z in eff})
    best=[]; bestn=-1
    for k in keys:
        for v in vels:
            here=[z for z in eff if z['klo']<=k<=z['khi'] and z['vlo']<=v<=z['vhi']]
            if len(here)>bestn: bestn=len(here); best=here
    return best

def _depths(here, samples):
    if not here: return (0,0,0,0)
    m1=len(here)
    m2=len({z['sid'] for z in here})
    pitched={(z['sid'],z['coarse'],z['fine']) for z in here}
    m3=len(pitched)
    # collapse stereo pairs into single mono voices
    voices=[]; used=[False]*len(here)
    for i in range(len(here)):
        if used[i]: continue
        zi=here[i]; paired=False
        for j in range(i+1,len(here)):
            if used[j]: continue
            zj=here[j]
            if zi['sid']==zj['sid']: continue
            same_tune = zi['coarse']==zj['coarse'] and zi['fine']==zj['fine']
            linked = (zi['stype'] in (2,4) and zj['stype'] in (2,4)
                      and zi['stype']!=zj['stype']
                      and zi['link']==zj['sididx'] and zj['link']==zi['sididx'])
            panned = ((zi['pan']<=-450 and zj['pan']>=450) or
                      (zi['pan']>=450 and zj['pan']<=-450))
            if same_tune and (linked or panned):
                used[j]=True; paired=True
                voices.append(('stereo',min(zi['sid'],zj['sid']),zi['coarse'],zi['fine']))
                break
        if not paired:
            voices.append((zi['sid'],zi['coarse'],zi['fine']))
        used[i]=True
    m4=len(set(voices))
    return (m1,m2,m3,m4)

def analyse(path):
    pdta=read_chunks(path)
    for n in ('phdr','pbag','pgen','inst','ibag','igen','shdr'):
        if n not in pdta: sys.exit(f"{path}: missing {n}")
    shdr=pdta['shdr']; samples=[]
    for i in range(len(shdr)//46-1):
        off=i*46;s=S()
        s.name=shdr[off:off+20].split(b'\x00')[0].decode('latin-1','replace')
        s.link,s.stype=struct.unpack_from('<HH',shdr,off+42); samples.append(s)
    inst=pdta['inst'];ibag=pdta['ibag'];igen=pdta['igen']
    n_inst=len(inst)//22-1; izall=[]
    for i in range(n_inst):
        b0=_u16(inst,i*22+20);b1=_u16(inst,(i+1)*22+20)
        izall.append(parse_bags(ibag,igen,b0,b1,GEN_SAMPLEID))
    phdr=pdta['phdr'];pbag=pdta['pbag'];pgen=pdta['pgen']
    n_pre=len(phdr)//38-1
    results=[]
    for pi in range(n_pre):
        off=pi*38
        pname=phdr[off:off+20].split(b'\x00')[0].decode('latin-1','replace')
        pno,bank,bag0=struct.unpack_from('<HHH',phdr,off+20)
        bag1=_u16(phdr,(pi+1)*38+24)
        pg,pzs=parse_bags(pbag,pgen,bag0,bag1,GEN_INSTRUMENT)
        eff=[]
        for pzr in pzs:
            pz=dict(pg);pz.update(pzr); ii=pz.get(GEN_INSTRUMENT)
            if ii is None or not(0<=ii<n_inst): continue
            pk=pz.get(GEN_KEYRANGE,0x7F00);pv=pz.get(GEN_VELRANGE,0x7F00)
            pklo,pkhi=pk&0xFF,(pk>>8)&0xFF;pvlo,pvhi=pv&0xFF,(pv>>8)&0xFF
            ig,izs=izall[ii]
            for izr in izs:
                z=dict(ig);z.update(izr); si=z.get(GEN_SAMPLEID)
                if si is None or not(0<=si<len(samples)): continue
                ik=z.get(GEN_KEYRANGE,0x7F00);ivv=z.get(GEN_VELRANGE,0x7F00)
                klo=max(ik&0xFF,pklo);khi=min((ik>>8)&0xFF,pkhi)
                vlo=max(ivv&0xFF,pvlo);vhi=min((ivv>>8)&0xFF,pvhi)
                if klo>khi or vlo>vhi: continue
                eff.append(dict(klo=klo,khi=khi,vlo=vlo,vhi=vhi,sid=si,
                    sididx=si, stype=samples[si].stype, link=samples[si].link,
                    pan=z.get(GEN_PAN,0)+pz.get(GEN_PAN,0),
                    coarse=z.get(GEN_COARSE,0)+pz.get(GEN_COARSE,0),
                    fine=z.get(GEN_FINE,0)+pz.get(GEN_FINE,0)))
        here=_zones_at(eff)
        m=_depths(here,samples)
        results.append((bank,pno,pname,m,len(pzs)))
    return dict(path=path,n_pre=n_pre,n_inst=n_inst,n_smp=len(samples),results=results)

def main():
    for p in sys.argv[1:]:
        r=analyse(p)
        print("="*80); print("FILE:",p.split('/')[-1])
        print(f"  presets={r['n_pre']} instruments={r['n_inst']} samples={r['n_smp']}")
        for mi,lbl in [(0,'M1 zones (spec mix) '),(1,'M2 distinct samples'),
                       (2,'M3 pitched layers  '),(3,'M4 mono VOICES need')]:
            h=collections.Counter(x[3][mi] for x in r['results'])
            tot=sum(v for d,v in h.items() if d>=2)
            print(f"  {lbl}: "+", ".join(f"{d}:{h[d]}" for d in sorted(h))
                  +f"   [>=2: {tot} presets]")
        deep=sorted(r['results'],key=lambda x:-x[3][3])[:15]
        print("  deepest by M4 mono-voices (bank:pre name  M1/M2/M3/M4  pzones):")
        for bank,pno,name,m,npz in deep:
            if m[3]<2: continue
            print(f"    {bank:3d}:{pno:<3d} {name:<22.22s} "
                  f"{m[0]:2d}/{m[1]:2d}/{m[2]:2d}/{m[3]:<2d} pz={npz}")

if __name__=='__main__': main()
