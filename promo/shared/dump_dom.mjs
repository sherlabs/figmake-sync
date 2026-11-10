import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { chromium } from "/Users/nilesh93/Projects/personal/figmake/node_modules/playwright/index.mjs";
const SC="/private/tmp/claude-501/-Users-nilesh93-Projects-personal-figmake/1c34d106-71b7-4a6b-a4b8-083d38245c85/scratchpad";
const root=SC+"/rt", out=SC+"/shots-chat";
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"};
const srv=http.createServer((q,r)=>{const u=q.url.split("?")[0];const f=path.join(root,u==="/"?"index.html":u);fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return}r.writeHead(200,{"content-type":types[path.extname(f)]||"text/plain"});r.end(d)})}).listen(0);
await new Promise(r=>srv.on("listening",r));
const url=`http://127.0.0.1:${srv.address().port}/`;
const iso=(m)=>new Date(Date.now()-m*60000).toISOString();
const P=(k,name,status,m)=>({key:k,name,status,syncedAt:m==null?null:iso(m)});
const proj=[P("a","Checkout Flow","synced",2)];
const base={phase:"ready",projectName:"Checkout Flow",previewUrl:"http://localhost:5173/",changes:[],changeFiles:[],changeIds:[],canSend:false,canUndo:false,agent:"claude",workspace:"figmake-sync",projects:proj,activeKey:"a",syncedAt:iso(2),updatesEnabled:true};
const start={phase:"start",projectName:null,previewUrl:null,activeKey:null,projects:[],syncedAt:null,changes:[],changeFiles:[],changeIds:[],canSend:false,canUndo:false,agent:null,workspace:"figmake-sync",updatesEnabled:true};
const U=(id,text,m)=>({id,role:"user",at:iso(m),text,parts:[],status:"done"});
const A=(id,m,parts,extra={})=>({id,role:"assistant",at:iso(m),text:"",parts,status:"done",...extra});
const T=(text)=>({type:"text",text});
const AC=(...items)=>({type:"activity",items:items.map(([kind,label,file])=>({kind,label,...(file?{file}:{})}))});
const CH=(turnId,summary,files,fate="active")=>({turnId,summary,files,previewUpdated:true,fate});
const F=(name,status="edited")=>({name,status});
const chatOf=(messages,extra={})=>({projectKey:"a",messages,active:false,fresh:false,...extra});

const turn1=[U("u1","Make the primary button blue and a bit rounder",9),A("a1",9,[AC(["look","Looked at Button.tsx","Button.tsx"],["look","Searched the project"],["edit","Edited Button.tsx","Button.tsx"],["add","Added button.css","button.css"],["check","Checked the app builds"]),T("Done. The main button is now a calm blue with softer corners.")],{change:CH("t1","Made the main button blue with softer corners",[F("Button.tsx"),F("button.css","added")])})];
const turn2=[U("u2","Add a promo banner above the product grid",5),A("a2",5,[AC(["look","Looked at App.tsx","App.tsx"],["edit","Edited App.tsx","App.tsx"],["add","Added PromoBanner.tsx","PromoBanner.tsx"]),T("I added a slim banner at the top of the shop with the line **Free shipping over $50**. It sits above the product grid and uses your existing colours.\n\nIf you'd like, I can also:\n\n- make it dismissible\n- change the wording\n- match it to the footer")],{change:CH("t2","Added a promo banner above the product grid",[F("App.tsx"),F("PromoBanner.tsx","added")])})];
const turn3=[U("u3","Why is the cart count not updating?",2),A("a3",2,[AC(["look","Looked at Cart.tsx","Cart.tsx"],["look","Looked at CartContext.tsx","CartContext.tsx"]),T("The count only reads the cart once when the page opens, so it never hears about new items. That's easy to fix: it should follow the cart as it changes. Want me to make that change?")])];
const sess2=(n)=>({...base,changes:["Made the main button blue with softer corners","Added a promo banner above the product grid"].slice(0,n),changeFiles:[2,2].slice(0,n),changeIds:["t1","t2"].slice(0,n),canSend:n>0,canUndo:n>0,projects:[P("a","Checkout Flow",n?"changes":"synced",2)]});

const long=[U("u1","Can you make the checkout form feel friendlier? Right now it reads like a tax return: long labels, a wall of fields, and the error messages are red and scary. Also make sure it still works on small screens and that the totals stay readable when someone has a lot of items in their cart, thanks!",8),
 A("a1",8,[AC(["look","Looked at Checkout.tsx","Checkout.tsx"],["edit","Edited Checkout.tsx","Checkout.tsx"],["edit","Edited form.css","form.css"]),T("Here's what I changed:\n\n1. Shortened the labels, so **Billing address** is now just *Address*.\n2. Grouped the fields into three calm sections.\n3. Softened errors: they now say what to fix, in dark grey with a small warning icon.\n\nThe spacing comes from one value you can tweak yourself:\n\n```css\n.form-section {\n  display: grid;\n  gap: 16px;\n  padding: 20px 24px;\n  border-radius: 14px;\n}\n```\n\nThe long `ShippingAddressAutocompleteField` component was left alone, because it also feeds the totals and I didn't want to break the very-long-name-wrapping-case-in-a-narrow-column.")],{change:CH("t1","Made the checkout form shorter, calmer and easier to scan on small screens",[F("Checkout.tsx"),F("form.css"),F("ShippingFields.tsx"),F("Totals.tsx"),F("theme.css")])})];

const stub=(initial)=>{
 let cb=[],cc=[]; let cur=initial.s; let curChat=initial.c; window.__calls=[]; window.__rect=null;
 const rec=(n)=>(...a)=>{window.__calls.push([n,...a]);return Promise.resolve()};
 const cell=(n,t,m)=>({n,text:t,mark:m});
 const demo=[
  {path:"src/components/Button.tsx",status:"edited",binary:false,truncated:false,rows:[
   {left:null,right:null,hunk:"Lines 4 to 9"},
   {left:cell(4,"export function Button({ label }: Props) {","same"),right:cell(4,"export function Button({ label }: Props) {","same")},
   {left:cell(5,"  return <button className=\"btn\">{label}</button>;","del"),right:cell(5,"  return <button className=\"btn btn-blue\">{label}</button>;","add")},
   {left:cell(6,"}","same"),right:cell(6,"}","same")}]},
  {path:"src/styles/button.css",status:"added",binary:false,truncated:false,rows:[
   {left:null,right:cell(1,".btn-blue {","add")},{left:null,right:cell(2,"  background: #2563eb;","add")},{left:null,right:cell(3,"  border-radius: 12px;","add")},{left:null,right:cell(4,"}","add")}]}];
 window.figmake={state:()=>Promise.resolve(cur),onState:(f)=>{cb.push(f);return()=>{}},chat:()=>Promise.resolve(curChat),onChat:(f)=>{cc.push(f);return()=>{}},newChat:rec("newChat"),copyText:rec("copy"),
  onCommand:(f)=>{window.__cmd=f;return()=>{}},
  openProject:rec("open"),ask:rec("ask"),undo:rec("undo"),send:rec("send"),cancel:rec("cancel"),retry:rec("retry"),setAgent:rec("agent"),chooseWorkspace:rec("ws"),signOutFigma:rec("out"),
  switchProject:rec("switch"),removeProject:rec("remove"),setUpdates:rec("updates"),describeChange:()=>Promise.resolve(demo),
  reportIssue:rec("report"),onUpdateState:(f)=>{window.__upd=f;return()=>{}},installUpdate:rec("install"),previewRect:(r)=>{window.__rect=r}};
 window.__set=(s)=>{cur=s;cb.forEach(f=>f(s))};
 window.__chat=(c)=>{curChat=c;cc.forEach(f=>f(c))};
};
const fake=()=>{
 const slot=document.querySelector(".slot"); if(!slot||slot.querySelector(".fakepage"))return;
 const el=(t,st,txt)=>{const e=document.createElement(t);Object.assign(e.style,st);if(txt)e.textContent=txt;return e};
 const page=el("div",{position:"absolute",inset:"0",background:"#f7f4ee",fontFamily:"Georgia,serif",color:"#1b1b1b",overflow:"hidden"});page.className="fakepage";
 const nav=el("div",{display:"flex",justifyContent:"space-between",padding:"22px 36px",fontSize:"15px"});
 nav.append(el("b",{},"Oak & Ember"),el("span",{color:"#666"},"Shop    Journal    Cart (2)"));
 const hero=el("div",{padding:"30px 36px 0",maxWidth:"560px"});
 hero.append(el("div",{fontSize:"38px",lineHeight:"1.1"},"Hand-poured candles for slow evenings."),el("div",{margin:"16px 0 22px",color:"#555",fontSize:"16px"},"Small batches. Soy wax. Burns for forty hours."));
 hero.append(el("div",{display:"inline-block",padding:"12px 24px",background:"#2563eb",color:"#fff",borderRadius:"12px",fontFamily:"system-ui",fontSize:"15px"},"Shop the collection"));
 const cards=el("div",{display:"flex",gap:"18px",padding:"34px 36px"});
 for(const c of["#d9c7a8","#c9b08a","#b89a74"])cards.append(el("div",{width:"130px",height:"130px",borderRadius:"14px",background:c}));
 page.append(nav,hero,cards);slot.append(page);
};

const outd=SC+"/vid/dom";fs.mkdirSync(outd,{recursive:true});
const S2=[
 ["start",start,chatOf([]),async p=>{await p.keyboard.press("Control+n");await p.waitForTimeout(300)}],
 ["start-sheet",start,chatOf([]),async p=>{await p.keyboard.press("Control+n");await p.fill(".sheet input","https://www.figma.com/make/Hk3xQp/Oak-and-Ember");await p.waitForTimeout(300)}],
 ["prep",{...base,phase:"preparing",previewUrl:null,projects:proj},chatOf([])],
 ["empty",sess2(0),chatOf([])],
 ["two",sess2(2),chatOf([...turn1,...turn2]),async p=>{await p.locator("button:has-text('View changes')").first().click();await p.waitForTimeout(300)}],
 ["sent",{...sess2(0),canSend:false,message:"Sent to Figma"},chatOf([...turn1,...turn2])],
 ["choice",{...base,phase:"needs-ai-choice",agent:null},chatOf([])],
 ["working",{...sess2(0),phase:"working"},chatOf([U("u1","Make the button blue and rounded",0)],{active:true})],
];
const b=await chromium.launch({channel:"chrome"});
for(const [id,s,c,steps] of S2){
  const ctx=await b.newContext({viewport:{width:1180,height:760},colorScheme:"light",reducedMotion:"reduce"});
  const p=await ctx.newPage();
  await p.addInitScript(stub,{s,c});
  await p.addInitScript(()=>{Object.defineProperty(navigator,"platform",{get:()=> "MacIntel"})});
  await p.goto(url);await p.waitForTimeout(300);
  if(s.previewUrl)await p.evaluate(fake);
  if(typeof steps==="function"){await steps(p);await p.waitForTimeout(150)}
  if(s.previewUrl)await p.evaluate(fake);
  await p.screenshot({path:outd+"/"+id+".png"});
  const html=await p.evaluate(()=>{document.querySelectorAll(".fakepage").forEach(e=>e.remove());return document.documentElement.className+"\n@@@\n"+document.body.innerHTML});
  fs.writeFileSync(outd+"/"+id+".html",html);
  await ctx.close();
}
await b.close();srv.close();
