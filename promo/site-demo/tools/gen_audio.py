import numpy as np, wave, sys
SR=44100; DUR=41.5
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
for t in [6.15,8.95,15.6,17.1,19.95,23.45,32.4,33.95]: put(t,click())
text="Make the cart total include the promo discount and respect quantity"
for i,c in enumerate(text):
    if c==' ': continue
    put(20.3+i/26, key(rng.choice([1500,1900,2400,1200])))
put(4.35,whoosh(.7,.35)); put(35.95,whoosh(.8,.35))
put(34.3,chime(784)); put(34.42,chime(1175,.6))
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
