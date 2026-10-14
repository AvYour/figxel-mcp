function bez(x1,y1,x2,y2){const cx=3*x1,bx=3*(x2-x1)-cx,ax=1-cx-bx,cy=3*y1,by=3*(y2-y1)-cy,ay=1-cy-by;const sx=t=>((ax*t+bx)*t+cx)*t,sy=t=>((ay*t+by)*t+cy)*t;return x=>{if(x<=0)return 0;if(x>=1)return 1;let lo=0,hi=1,t=x;for(let i=0;i<80;i++){t=(lo+hi)/2;if(sx(t)<x)lo=t;else hi=t;}return sy(t);};}
const C={"expo-out (0.16,1,0.3,1)":[0.16,1,0.3,1],"M3 emph-decel (0.05,0.7,0.1,1)":[0.05,0.7,0.1,1],"M3 standard (0.2,0,0,1)":[0.2,0,0,1],"ease-in (0.7,0,0.84,0)":[0.7,0,0.84,0],"M3 emph-accel (0.3,0,0.8,0.15)":[0.3,0,0.8,0.15],"in-out DRAW (0.65,0,0.35,1)":[0.65,0,0.35,1],"WHIP (0.83,0,0.17,1)":[0.83,0,0.17,1],"SOFT (0.45,0,0.55,1)":[0.45,0,0.55,1],"cubic(0.7,0,0.3,1)":[0.7,0,0.3,1]};
const Ns=[3,5,8,10,15,20,30];
console.log("max share of total travel in one frame, by span in frames (30 fps)");
console.log("curve".padEnd(34)+Ns.map(n=>String(n).padStart(6)).join(""));
for(const[k,v]of Object.entries(C)){const f=bez(...v);const row=Ns.map(n=>{let m=0;for(let i=1;i<=n;i++){m=Math.max(m,f(i/n)-f((i-1)/n));}return (m*100).toFixed(0)+"%";});console.log(k.padEnd(34)+row.map(s=>s.padStart(6)).join(""));}
// last-visible-frame size for an ease-in exit that ends on a cut: value at (n-1)/n
console.log("\nshare of travel still to go on the LAST frame before the end key (ease-in exits): 1 - f((n-1)/n)");
for(const k of ["ease-in (0.7,0,0.84,0)","M3 emph-accel (0.3,0,0.8,0.15)","SOFT (0.45,0,0.55,1)","in-out DRAW (0.65,0,0.35,1)"]){const f=bez(...C[k]);console.log(k.padEnd(34)+Ns.map(n=>((1-f((n-1)/n))*100).toFixed(0)+"%").map(s=>s.padStart(6)).join(""));}
