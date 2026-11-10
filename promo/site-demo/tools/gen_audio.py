import numpy as np, wave, sys, json, pathlib
CUES=json.loads((pathlib.Path(__file__).parent/'cues.json').read_text())
SR=44100; DUR=CUES['dur']
rng=np.random.default_rng(7)
def env(n,a,d): 
    t=np.arange(n)/SR; return np.minimum(t/a,1)*np.exp(-t/d)
def click(f=1800,vol=1.0):
    n=int(.09*SR); t=np.arange(n)/SR
    s=(np.sin(2*np.pi*f*t)*env(n,.0005,.012)+rng.standard_normal(n)*env(n,.0003,.004)*.6)
    s2=np.zeros(n+int(.05*SR)); s2[:n]+=s
    t2=int(.045*SR); s2[t2:t2+n]+=s*.55*np.cos(0)  # up-click
    return s2*vol*.5
def key(f):
    n=int(.04*SR); t=np.arange(n)/SR
    return (np.sin(2*np.pi*f*t)*env(n,.0003,.006)*.5+rng.standard_normal(n)*env(n,.0002,.003)*.5)*.22
def whoosh(d=.7,vol=.5):
    n=int(d*SR); x=rng.standard_normal(n)
    # crude lowpass sweep
    out=np.zeros(n); y=0
    for i in range(n):
        a=.02+.25*np.sin(np.pi*i/n)**2
        y+=a*(x[i]-y); out[i]=y
    w=np.sin(np.pi*np.arange(n)/n)**2
    return out*w*vol*2.2
def chime(f=880,vol=.5):
    n=int(1.6*SR); t=np.arange(n)/SR
    s=sum(np.sin(2*np.pi*f*m*t)*a for m,a in [(1,1),(2,.3),(3,.1)])*np.exp(-t/.45)
    s*=np.minimum(t/.004,1); return s*vol*.35
sfx=np.zeros(int(DUR*SR))
def put(t,s):
    i=int(t*SR); sfx[i:i+len(s)]+=s[:len(sfx)-i]
for t in CUES['clicks']: put(t,click())
for st,txt,cps in CUES['typing']:
    for i,c in enumerate(txt):
        if c==' ': continue
        put(st+i/cps, key(rng.choice([1500,1900,2400,1200])))
for t,v in CUES['whoosh']: put(t,whoosh(.7,v))
for t,f,v in CUES['chimes']: put(t,chime(f,v))
sfx=np.tanh(sfx*1.2)*.9
# music bed: quiet pad
t=np.arange(len(sfx))/SR
bed=np.zeros_like(t)
for f,a in [(110,1),(164.8,.7),(220,.6),(277.2,.35),(329.6,.3),(415.3,.15)]:
    lfo=1+.08*np.sin(2*np.pi*(.07+f/9000)*t)
    bed+=np.sin(2*np.pi*f*t+np.sin(2*np.pi*.1*t))*a*lfo
bed*= np.minimum(t/3,1)*np.minimum((DUR-t)/3,1)
bed*=.6/np.abs(bed).max()
def wr(name,x):
    x=np.clip(x,-1,1); st=np.stack([x,x],1)
    w=wave.open(name,'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((st*32767).astype('<i2').tobytes()); w.close()
wr(sys.argv[1]+'/sfx.wav',sfx); wr(sys.argv[1]+'/bed.wav',bed)
