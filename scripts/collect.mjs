import fs from 'fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const cfg=JSON.parse(fs.readFileSync('config.json','utf8'));
const HIGH=cfg.keywords_high, MED=cfg.keywords_medium;
const NEG=['roof replacement','hvac','paving','asphalt','janitorial','vehicle','fleet','playground','watermain replacement','water main replacement','pump replacement','sewer replacement','electrical upgrade','mechanical upgrade','building renovation','road construction','roadworks','landscaping','snow removal','fire apparatus','furniture'];
const CLOSED_WORDS=['awarded','closed','cancelled','canceled','completed','expired','results','award notice','contract awarded','submission closed','bid closed'];
const OPEN_WORDS=['open','active','accepting submissions','posted','current'];
const ISLAND=['capital regional district','city of victoria','district of saanich','central saanich','north saanich','town of sidney','city of colwood','city of langford','district of sooke','township of esquimalt','district of oak bay','cowichan valley regional district','city of duncan','north cowichan','town of ladysmith','lake cowichan','regional district of nanaimo','city of nanaimo','city of parksville','qualicum beach','lantzville','alberni-clayoquot regional district','city of port alberni','tofino','ucluelet','comox valley regional district','city of courtenay','town of comox','cumberland','strathcona regional district','city of campbell river','sayward','gold river','tahsis','zeballos','mount waddington','port hardy','port mcneill','alert bay','port alice','vancouver island'];

function clean(s){return (s||'').replace(/\s+/g,' ').trim()}
function score(x){
 const t=(x.title+' '+(x.description||'')).toLowerCase(); let n=0,m=[];
 for(const p of HIGH) if(t.includes(p)){n+=28;m.push(p)}
 for(const p of MED) if(t.includes(p)){n+=12;m.push(p)}
 for(const p of NEG) if(t.includes(p)) n-=25;
 if(!m.length)n=0;
 return {score:Math.max(0,Math.min(100,n)),matches:[...new Set(m)]}
}
function inferStatus(text=''){
 const t=text.toLowerCase();
 if(CLOSED_WORDS.some(x=>t.includes(x))) return 'closed';
 if(OPEN_WORDS.some(x=>t.includes(x))) return 'open';
 return 'unknown';
}
function extractClosing(text=''){
 const pats=[/(?:closing date|bid closing date|closes|closing)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}(?:[^|]{0,25})?)/i,/(?:closing date|bid closing date|closes|closing)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}(?:[^|]{0,25})?)/i];
 for(const p of pats){const m=text.match(p);if(m)return clean(m[1]);} return '';
}

async function htmlSource(s){
 const r=await fetch(s.url,{headers:{'user-agent':'Mozilla/5.0'}}); if(!r.ok) throw new Error(`HTTP ${r.status}`);
 const html=await r.text(),$=cheerio.load(html),out=[];
 $('table tr').each((_,tr)=>{
   const cells=$(tr).find('td').map((i,x)=>clean($(x).text())).get(); if(cells.length<2)return;
   const a=$(tr).find('a').first(); const title=clean(a.text())||cells.slice().sort((a,b)=>b.length-a.length)[0]; if(!title||title.length<8)return;
   let url=s.url; try{if(a.attr('href'))url=new URL(a.attr('href'),s.url).toString()}catch{}
   const description=cells.join(' | '),status=inferStatus(description+' '+title),closing=extractClosing(description);
   out.push({source:s.name,sourceId:s.id,title,description,url,closing,status,...score({title,description})});
 });
 return out;
}

async function detailFromPage(page,item){
 try{
  await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:45000}); await page.waitForTimeout(2500);
  const body=clean(await page.locator('body').innerText());
  const title=clean(await page.locator('h1,h2,.bid-name,.tender-name').first().innerText().catch(()=>item.title))||item.title;
  return {...item,title,description:body.slice(0,18000),status:inferStatus(body),closing:extractClosing(body),...score({title,description:body})};
 }catch{return item;}
}

async function bidsSource(s,browser){
 const listPage=await browser.newPage({viewport:{width:1400,height:1200}}); const seen=new Map();
 try{
  await listPage.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000}); await listPage.waitForTimeout(5000);
  for(let p=0;p<20;p++){
   const rows=await listPage.locator('a[href*="/Tender/Detail/"]').evaluateAll(as=>as.map(a=>({title:(a.innerText||a.textContent||'').trim(),href:a.href,context:(a.closest('tr')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()})));
   for(const x of rows){if(!x.title||seen.has(x.href))continue;seen.set(x.href,{source:s.name,sourceId:s.id,title:clean(x.title),description:clean(x.context),url:x.href,closing:'',status:inferStatus(x.context),...score({title:x.title,description:x.context})});}
   const next=listPage.locator('button[aria-label*="Next"],a[aria-label*="Next"],button:has-text("Next Page"),a:has-text("Next Page")').first();
   if(!(await next.count()))break; let disabled=false; try{disabled=await next.isDisabled()}catch{} if(disabled||!(await next.isVisible()))break;
   await next.click(); await listPage.waitForTimeout(2200);
  }
 } finally {await listPage.close()}
 const detailPage=await browser.newPage({viewport:{width:1400,height:1200}}),out=[];
 try{for(const item of seen.values())out.push(await detailFromPage(detailPage,item));}finally{await detailPage.close()}
 return out;
}

async function bonfireSource(s,browser){
 const page=await browser.newPage({viewport:{width:1400,height:1200}});
 try{
  await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000}); await page.waitForTimeout(7000);
  const rows=await page.locator('a').evaluateAll(as=>as.map(a=>({title:(a.innerText||'').trim(),href:a.href,context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()})));
  const out=[];
  for(const x of rows){if(x.title.length<8||!/^https?:/.test(x.href))continue;const text=(x.href+' '+x.context).toLowerCase();if(!/opportun|project|portal/.test(text))continue;if(out.some(y=>y.url===x.href))continue;out.push({source:s.name,sourceId:s.id,title:clean(x.title),description:clean(x.context),url:x.href,closing:extractClosing(x.context),status:inferStatus(x.context),...score({title:x.title,description:x.context})});}
  return out;
 } finally {await page.close()}
}

async function bcBidSource(s,browser){
 const page=await browser.newPage({viewport:{width:1400,height:1200}});
 try{
  await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000}); await page.waitForTimeout(8000);
  const body=(await page.locator('body').innerText()).toLowerCase(); if(body.includes('checking your browser')) return {blocked:true,items:[]};
  const rows=await page.locator('a').evaluateAll(as=>as.map(a=>({title:(a.innerText||'').trim(),href:a.href,context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()})));
  const out=[];
  for(const x of rows){if(x.title.length<8||!/^https?:/.test(x.href))continue;const text=(x.title+' '+x.context).toLowerCase();if(!ISLAND.some(g=>text.includes(g)))continue;const sc=score({title:x.title,description:x.context});if(sc.score<20)continue;if(!out.some(y=>y.url===x.href))out.push({source:s.name,sourceId:s.id,title:clean(x.title),description:clean(x.context),url:x.href,closing:extractClosing(x.context),status:inferStatus(x.context),...sc});}
  return {blocked:false,items:out};
 } finally {await page.close()}
}

const browser=await chromium.launch({headless:true}); const statuses=[],items=[];
for(const s of cfg.sources){
 try{
  let rows=[],note='';
  if(s.type==='html')rows=await htmlSource(s); else if(s.type==='bids')rows=await bidsSource(s,browser); else if(s.type==='bonfire')rows=await bonfireSource(s,browser); else if(s.type==='bcbid'){const r=await bcBidSource(s,browser);rows=r.items;if(r.blocked)note='BC Bid browser check blocked the public automation session.';}
  const relevant=rows.filter(x=>x.score>=20);items.push(...relevant);statuses.push({source:s.name,status:note?'limited':'ok',note,count:relevant.length,openCount:relevant.filter(x=>x.status==='open').length,closedCount:relevant.filter(x=>x.status==='closed').length});
 }catch(e){statuses.push({source:s.name,status:'error',note:String(e.message||e),count:0,openCount:0,closedCount:0})}
}
await browser.close();
const rank={open:0,unknown:1,closed:2};
const dedup=[...new Map(items.map(x=>[(x.url||x.source+'|'+x.title).toLowerCase(),x])).values()].sort((a,b)=>(rank[a.status]??1)-(rank[b.status]??1)||b.score-a.score);
fs.writeFileSync('data/results.json',JSON.stringify({refreshedAt:new Date().toISOString(),items:dedup,statuses},null,2));
console.log(`Wrote ${dedup.length} relevant opportunities (${dedup.filter(x=>x.status==='open').length} open)`);
