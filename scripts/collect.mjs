
import fs from 'fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const cfg=JSON.parse(fs.readFileSync('config.json','utf8'));
const HIGH=cfg.keywords_high, MED=cfg.keywords_medium;
const NEG=[
 'roof replacement','hvac','paving','asphalt','janitorial','vehicle','fleet','playground',
 'watermain replacement','water main replacement','pump replacement','sewer replacement',
 'electrical upgrade','mechanical upgrade','building renovation','road construction','roadworks',
 'landscaping','snow removal','fire apparatus','furniture'
];
const ISLAND=[
 'capital regional district','city of victoria','district of saanich','central saanich','north saanich',
 'town of sidney','city of colwood','city of langford','district of sooke','township of esquimalt',
 'district of oak bay','cowichan valley regional district','city of duncan','north cowichan',
 'town of ladysmith','lake cowichan','regional district of nanaimo','city of nanaimo',
 'city of parksville','qualicum beach','lantzville','alberni-clayoquot regional district',
 'city of port alberni','tofino','ucluelet','comox valley regional district','city of courtenay',
 'town of comox','cumberland','strathcona regional district','city of campbell river','sayward',
 'gold river','tahsis','zeballos','mount waddington','port hardy','port mcneill','alert bay',
 'port alice','vancouver island'
];
function clean(s){return (s||'').replace(/\s+/g,' ').trim()}
function score(x){
 const t=(x.title+' '+(x.description||'')).toLowerCase();
 let n=0,m=[];
 for(const p of HIGH) if(t.includes(p)){n+=28;m.push(p)}
 for(const p of MED) if(t.includes(p)){n+=12;m.push(p)}
 if(/\bsampling\b/.test(t)&&!m.some(x=>x.includes('sampling'))){n+=14;m.push('sampling')}
 for(const p of NEG) if(t.includes(p)) n-=25;
 if(!m.length)n=0;
 return {score:Math.max(0,Math.min(100,n)),matches:[...new Set(m)]}
}
async function htmlSource(s){
 const r=await fetch(s.url,{headers:{'user-agent':'Mozilla/5.0'}});
 const html=await r.text(),$=cheerio.load(html),out=[];
 $('table tr').each((_,tr)=>{
   const cells=$(tr).find('td').map((i,x)=>clean($(x).text())).get();
   if(cells.length<2)return;
   const a=$(tr).find('a').first();
   const title=clean(a.text())||cells.slice().sort((a,b)=>b.length-a.length)[0];
   if(!title||title.length<8)return;
   let url=s.url; try{if(a.attr('href'))url=new URL(a.attr('href'),s.url).toString()}catch{}
   const description=cells.join(' | ');
   out.push({source:s.name,sourceId:s.id,title,description,url,closing:'',...score({title,description})});
 });
 return out;
}
async function bidsSource(s,browser){
 const page=await browser.newPage({viewport:{width:1400,height:1200}});
 const seen=new Map();
 try{
   await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
   await page.waitForTimeout(5000);
   for(let p=0;p<20;p++){
     const rows=await page.locator('a[href*="/Tender/Detail/"]').evaluateAll(as=>as.map(a=>({
       title:(a.innerText||a.textContent||'').trim(),
       href:a.href,
       context:(a.closest('tr')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
     })));
     for(const x of rows){
       if(!x.title||seen.has(x.href))continue;
       seen.set(x.href,{source:s.name,sourceId:s.id,title:clean(x.title),description:clean(x.context),url:x.href,closing:'',...score({title:x.title,description:x.context})});
     }
     const next=page.locator('button[aria-label*="Next"],a[aria-label*="Next"],button:has-text("Next Page"),a:has-text("Next Page")').first();
     if(!(await next.count()))break;
     let disabled=false; try{disabled=await next.isDisabled()}catch{}
     if(disabled||!(await next.isVisible()))break;
     const before=[...seen.keys()].length;
     await next.click();
     await page.waitForTimeout(2500);
     if([...seen.keys()].length===before && p>1) break;
   }
 } finally {await page.close()}
 return [...seen.values()]
}
async function bonfireSource(s,browser){
 const page=await browser.newPage({viewport:{width:1400,height:1200}});
 try{
   await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
   await page.waitForTimeout(7000);
   const rows=await page.locator('a').evaluateAll(as=>as.map(a=>({
     title:(a.innerText||'').trim(),href:a.href,
     context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
   })));
   const out=[];
   for(const x of rows){
     if(x.title.length<8||!/^https?:/.test(x.href))continue;
     const text=(x.href+' '+x.context).toLowerCase();
     if(!/opportun|project|portal/.test(text))continue;
     if(out.some(y=>y.url===x.href))continue;
     out.push({source:s.name,sourceId:s.id,title:clean(x.title),description:clean(x.context),url:x.href,closing:'',...score({title:x.title,description:x.context})});
   }
   return out;
 } finally {await page.close()}
}
async function bcBidSource(s,browser){
 const page=await browser.newPage({viewport:{width:1400,height:1200}});
 try{
   await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
   await page.waitForTimeout(8000);
   const body=(await page.locator('body').innerText()).toLowerCase();
   if(body.includes('checking your browser')) return {blocked:true,items:[]};
   const rows=await page.locator('a').evaluateAll(as=>as.map(a=>({
     title:(a.innerText||'').trim(),href:a.href,
     context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
   })));
   const out=[];
   for(const x of rows){
     if(x.title.length<8||!/^https?:/.test(x.href))continue;
     const text=(x.title+' '+x.context).toLowerCase();
     if(!ISLAND.some(g=>text.includes(g)))continue;
     const sc=score({title:x.title,description:x.context});
     if(sc.score<20)continue;
     if(!out.some(y=>y.url===x.href))out.push({source:s.name,sourceId:s.id,title:clean(x.title),description:clean(x.context),url:x.href,closing:'',...sc});
   }
   return {blocked:false,items:out};
 } finally {await page.close()}
}
const browser=await chromium.launch({headless:true});
const statuses=[],items=[];
for(const s of cfg.sources){
 try{
   let rows=[],note='';
   if(s.type==='html') rows=await htmlSource(s);
   else if(s.type==='bids') rows=await bidsSource(s,browser);
   else if(s.type==='bonfire') rows=await bonfireSource(s,browser);
   else if(s.type==='bcbid'){
      const r=await bcBidSource(s,browser);rows=r.items;if(r.blocked)note='BC Bid browser check blocked the public automation session.';
   }
   rows=rows.filter(x=>x.score>=20);
   items.push(...rows);
   statuses.push({source:s.name,status:note?'limited':'ok',note,count:rows.length});
 }catch(e){statuses.push({source:s.name,status:'error',note:String(e.message||e),count:0})}
}
await browser.close();
const dedup=[...new Map(items.map(x=>[(x.url||x.source+'|'+x.title).toLowerCase(),x])).values()].sort((a,b)=>b.score-a.score);
fs.writeFileSync('data/results.json',JSON.stringify({refreshedAt:new Date().toISOString(),items:dedup,statuses},null,2));
console.log(`Wrote ${dedup.length} relevant opportunities`);
