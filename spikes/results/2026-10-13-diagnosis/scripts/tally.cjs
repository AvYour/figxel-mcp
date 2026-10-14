const fs=require("fs"),path=require("path");const d=process.argv[2];
const files={R1M:"j39-critic_motion_r1.json",R1D:"j38-critic_design_r1.json",R1Q:"j40-critic_qa_r1.json",R2M:"j46-critic_motion_r2.json",R2D:"j47-critic_design_r2.json",R2Q:"j48-critic_qa_r2.json",R3D:"j54-critic_design_r3.json",R3M:"j55-critic_motion_r3.json",R3Q:"j56-critic_qa_r3.json"};
const cat={
"R1M1":"handoff","R1M2":"cut","R1M3":"pop","R1M4":"weak","R1M5":"dead","R1M6":"dead","R1M7":"anticipation","R1M8":"offbeat","R1M9":"ease","R1M10":"sequence","R1M11":"dead",
"R1D1":"collision","R1D2":"static","R1D3":"collision","R1D4":"static","R1D5":"static","R1D6":"collision","R1D7":"static","R1D8":"weak","R1D9":"collision","R1D10":"read","R1D11":"static",
"R1Q1":"pop","R1Q2":"handoff","R1Q3":"pop","R1Q4":"pop","R1Q5":"pop","R1Q6":"collision","R1Q7":"cut","R1Q8":"pop","R1Q9":"weak","R1Q10":"pop","R1Q11":"pop","R1Q12":"residue","R1Q13":"dead","R1Q14":"delivery",
"R2M1":"offbeat","R2M2":"handoff","R2M3":"vocab","R2M4":"ease","R2M5":"ease","R2M6":"blur","R2M7":"dead",
"R2D1":"drift","R2D2":"collision","R2D3":"read","R2D4":"sequence","R2D5":"collision","R2D6":"collision","R2D7":"static","R2D8":"edge",
"R2Q1":"collision","R2Q2":"residue","R2Q3":"pop","R2Q4":"handoff","R2Q5":"edge","R2Q6":"collision","R2Q7":"delivery",
"R3D1":"collision","R3D2":"collision","R3D3":"collision","R3D4":"static",
"R3M1":"cut","R3M2":"ease","R3M3":"dead","R3M4":"sequence","R3M5":"drift",
"R3Q1":"collision","R3Q2":"blur","R3Q3":"morph","R3Q4":"pop","R3Q5":"blur","R3Q6":"ease"};
const tags={ // non-exclusive root-cause tags
 easeConcentrates:["R1M1","R1M3","R1M9","R1M11","R1Q1","R1Q2","R1Q3","R1Q4","R1Q5","R1Q8","R1Q10","R1Q11","R2Q3","R2M4","R3Q4"],
 blurWrong:["R1M3","R1M7","R1Q8","R2Q3","R2M6","R3Q2","R3Q4","R3Q5"],
 startsOnEvent:["R1M4","R1M8","R1Q9","R1Q13","R2M1"],
 symmetricOrApex:["R2M1","R2M5","R3M2","R3Q6"],
 onlyRestChecked:["R1D6","R1Q6","R2D1","R2D8","R2Q5","R2Q6","R3D1","R3Q1","R3M5"],
 builtNotSpec:["R1D1","R1D7"],
 multiLensDup:[["R1M1","R1Q2"],["R1M2","R1Q7"],["R1M4","R1D8","R1Q9"],["R1D6","R1Q6"],["R2D5","R2Q1"],["R2D8","R2Q5"],["R2M2","R2Q4"],["R3D1","R3Q1"],["R3M2","R3Q6"]]
};
let n=0;const count={},sev={};const missing=[];
for(const[k,f]of Object.entries(files)){const o=JSON.parse(fs.readFileSync(path.join(d,f)));o.findings.forEach((x,i)=>{const id=k+(i+1);n++;const c=cat[id];if(!c)missing.push(id);count[c]=(count[c]||0)+1;sev[c]=sev[c]||{};sev[c][x.severity]=(sev[c][x.severity]||0)+1;});}
const extra=Object.keys(cat).filter(id=>{const k=id.slice(0,3),i=+id.slice(3);const o=JSON.parse(fs.readFileSync(path.join(d,files[k])));return i>o.findings.length;});
console.log("total",n,"missing",missing,"extra",extra);
Object.entries(count).sort((a,b)=>b[1]-a[1]).forEach(([c,v])=>console.log(c.padEnd(13),v,JSON.stringify(sev[c])));
for(const[t,l]of Object.entries(tags))console.log(t,Array.isArray(l[0])?l.length+" pairs/triples":l.length);
