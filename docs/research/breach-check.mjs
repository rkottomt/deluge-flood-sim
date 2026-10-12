// Weir-flow + linear-downcutting breach model (Walder & O'Connor-type), explicit RK2.
// Lake: V(s) = V0 * (s/d)^p, s = lake level above final breach base (m), d = initial depth above base.
// Breach: bottom elevation above base zb(t) = max(0, zb0 - k t); bottom width b = max(b0, r*(zc - zb)) ; side slope m (H:V)
// Q = 1.7*b*H^1.5 + 1.35*m*H^2.5, H = max(0, s - zb)   (SI broad-crested weir, Fread BREACH coefficients)
function run({V0, d, p=1.5, kmh=30, r=2, m=1, zb0=null, b0=1, dt=1, tmax=6*3600}) {
  const k = kmh/3600; let s = d; const zc = d; zb0 = zb0 ?? d - 0.5; // start with 0.5 m overtopping head
  let t=0, Qp=0, tp=0, V=V0, out=[];
  const Vof = s => V0*Math.pow(Math.max(s,0)/d, p);
  const sof = V => d*Math.pow(Math.max(V,0)/V0, 1/p);
  const Q = (s,t) => { const zb=Math.max(0, zb0-k*t); const b=Math.max(b0, r*(zc-zb)); const H=Math.max(0,s-zb); return 1.7*b*H**1.5 + 1.35*m*H**2.5; };
  while (t<tmax && V>1e-4*V0) {
    const q1=Q(s,t); const V1=V-q1*dt/2; const s1=sof(V1); const q2=Q(s1,t+dt/2);
    V -= q2*dt; s = sof(V); t+=dt;
    if (q2>Qp){Qp=q2;tp=t;}
    if (t%60===0) out.push([t,q2]);
  }
  const t50 = out.find(([tt,q])=>tt>tp && q<0.5*Qp)?.[0];
  return {Qp:Math.round(Qp), tp_min:+(tp/60).toFixed(1), drained:+(1-V/V0).toFixed(3), t_half_after_peak_min: t50? +(t50/60).toFixed(1):null};
}
const cases = {
  'Thame lower (V=0.36e6,d=12)': {V0:0.36e6, d:12},
  'Thame lower (V=0.36e6,d=30)': {V0:0.36e6, d:30},
  'Gongbatongsha (V=0.12e6,d=9)': {V0:0.12e6, d:9},
  'Dig Tsho (V=5e6,d=18)': {V0:5e6, d:18},
  'South Lhonak (V=50e6,d=40?)': {V0:50e6, d:40},
  'Tsho Rolpa (V=86e6,d=30?)': {V0:86e6, d:30},
};
for (const kmh of [10,30,100]) for (const [n,c] of Object.entries(cases)) console.log(kmh+' m/h', n, JSON.stringify(run({...c,kmh})));
