
import fs from 'fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const cfg=JSON.parse(fs.readFileSync('config.json','utf8'));
const HIGH=cfg.keywords_high, MED=cfg.keywords_medium, SEARCH=cfg.search_terms;

const NEG=['roof replacement','hvac','paving','asphalt','janitorial','vehicle','fleet','playground','watermain replacement','water main replacement','pump replacement','sewer replacement','electrical upgrade','mechanical upgrade','building renovation','road construction','roadworks','landscaping','snow removal','fire apparatus','furniture'];
const ISLAND=['capital regional district','victoria','saanich','sidney','colwood','langford','sooke','esquimalt','oak bay','cowichan','duncan','ladysmith','lake cowichan','regional district of nanaimo','city of nanaimo','parksville','qualicum','lantzville','alberni-clayoquot','port alberni','tofino','ucluelet','comox valley','courtenay','town of comox','cumberland','strathcona','campbell river','sayward','gold river','tahsis','zeballos','mount waddington','port hardy','port mcneill','alert bay','port alice','vancouver island'];

function clean(s){return (s||'').replace(/\s+/g,' ').trim()}
function score(x){
  const t=(x.title+' '+(x.description||'')).toLowerCase(); let n=0,m=[];
  for(const p of HIGH) if(t.includes(p.toLowerCase())){n+=28;m.push(p)}
  for(const p of MED) if(t.includes(p.toLowerCase())){n+=12;m.push(p)}
  for(const p of NEG) if(t.includes(p)) n-=25;
  if(!m.length)n=0;
  return {score:Math.max(0,Math.min(100,n)),matches:[...new Set(m)]}
}
function parseBidNumber(text=''){
  const patterns=[
    /\b(?:Bid Number|Bid No\.?|Solicitation Number|RFP No\.?|Tender No\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /\b(\d{2}-\d{3,4})\b/
  ];
  for(const p of patterns){const m=text.match(p);if(m)return clean(m[1]);}
  return '';
}
function detailFields(body){
  const status=(body.match(/Bid Status:\s*([^\n\r]+)/i)||[])[1]||'';
  const closing=(body.match(/Bid Closing Date:\s*([^\n\r]+)/i)||[])[1]||'';
  const bidName=(body.match(/Bid Name:\s*([^\n\r]+)/i)||[])[1]||'';
  const bidNumber=parseBidNumber(body);
  let normalized='unknown';
  if(/\bopen\b/i.test(status)) normalized='open';
  else if(/awarded|closed|cancelled|canceled|expired/i.test(status)) normalized='closed';
  return {status:normalized,closing:clean(closing),bidName:clean(bidName),bidNumber}
}

async function htmlSource(s){
  const r=await fetch(s.url,{headers:{'user-agent':'Mozilla/5.0'}});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const html=await r.text(),$=cheerio.load(html),out=[];
  $('table tr').each((_,tr)=>{
    const cells=$(tr).find('td').map((i,x)=>clean($(x).text())).get();
    if(cells.length<2)return;
    const a=$(tr).find('a').first();
    const title=clean(a.text())||cells.slice().sort((a,b)=>b.length-a.length)[0];
    if(!title||title.length<8)return;
    let url=s.url; try{if(a.attr('href'))url=new URL(a.attr('href'),s.url).toString()}catch{}
    const description=cells.join(' | ');
    const closed=/awarded|results|closed|cancelled/i.test(description+' '+title);
    out.push({source:s.name,sourceId:s.id,bidNumber:parseBidNumber(description+' '+title),title,description,url,closing:'',status:closed?'closed':'unknown',...score({title,description})});
  });
  return out;
}

async function findSearchBox(page){
  const selectors=['input[type="search"]','input[placeholder*="Search" i]','input[aria-label*="Search" i]','input[name*="Search" i]','input[id*="Search" i]'];
  for(const sel of selectors){
    const loc=page.locator(sel).first();
    try{if(await loc.count() && await loc.isVisible()) return loc}catch{}
  }
  const inputs=page.locator('input[type="text"]:visible');
  const n=await inputs.count();
  for(let i=0;i<n;i++){
    const el=inputs.nth(i);
    try{
      const attrs=await el.evaluate(e=>`${e.id} ${e.name} ${e.placeholder} ${e.className}`.toLowerCase());
      if(/search|filter|keyword/.test(attrs)) return el;
    }catch{}
  }
  return n?inputs.first():null;
}
async function triggerSearch(page){
  const candidates=[
    page.getByRole('button',{name:/^search$/i}).first(),
    page.locator('button:has-text("Search")').first(),
    page.locator('input[type="submit"][value*="Search" i]').first(),
    page.locator('input[type="button"][value*="Search" i]').first()
  ];
  for(const b of candidates){
    try{if(await b.count() && await b.isVisible()){await b.click();return}}catch{}
  }
  await page.keyboard.press('Enter');
}
async function collectTenderLinks(page){
  await page.waitForTimeout(1200);
  return await page.locator('a[href*="/Tender/Detail/"]').evaluateAll(as=>as.map(a=>({
    href:a.href,title:(a.innerText||a.textContent||'').trim(),
    context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
  })));
}
async function openOnlyIfAvailable(page){
  const selects=page.locator('select:visible');
  for(let i=0;i<await selects.count();i++){
    const sel=selects.nth(i);
    try{
      const text=(await sel.locator('option').allTextContents()).join(' | ');
      if(/open/i.test(text) && /status/i.test(await sel.evaluate(e=>`${e.id} ${e.name} ${e.getAttribute('aria-label')||''}`))){
        const opts=await sel.locator('option').evaluateAll(os=>os.map(o=>({t:o.textContent||'',v:o.value})));
        const open=opts.find(o=>/open/i.test(o.t));
        if(open){await sel.selectOption(open.v);await page.waitForTimeout(700);return;}
      }
    }catch{}
  }
}

async function genericBidsSearch(s,browser){
  const page=await browser.newPage({viewport:{width:1440,height:1300}});
  const found=new Map();
  try{
    for(const term of SEARCH){
      await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
      await page.waitForTimeout(2200);
      await openOnlyIfAvailable(page);
      const box=await findSearchBox(page);
      if(!box) throw new Error('Could not locate bids&tenders Search field');
      await box.fill(term);
      await triggerSearch(page);
      await page.waitForTimeout(1400);
      const links=await collectTenderLinks(page);
      for(const x of links){
        if(!x.href)continue;
        if(!found.has(x.href))found.set(x.href,{source:s.name,sourceId:s.id,url:x.href,title:clean(x.title)||term,description:clean(x.context),discoveredBy:[term]});
        else if(!found.get(x.href).discoveredBy.includes(term))found.get(x.href).discoveredBy.push(term);
      }
    }
  } finally {await page.close()}
  return await hydrate(found,s,browser);
}

async function metroBidsSearch(s,browser){
  const page=await browser.newPage({viewport:{width:1440,height:1300}});
  const found=new Map();
  const metroTerms=[...new Set([
    'biosolids','biosolid','biosolids management','wastewater','stormwater','environmental',
    'environmental services','environmental monitoring','sampling','effluent','sewage',
    'combined sewer overflow','risk assessment','water quality','remediation','sediment',
    'groundwater','PFAS',...SEARCH
  ])];

  try{
    for(const term of metroTerms){
      await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
      await page.waitForTimeout(2500);
      await openOnlyIfAvailable(page);

      const box=await findSearchBox(page);
      if(!box) throw new Error('Metro Vancouver search field not found');

      await box.fill(term);
      await triggerSearch(page);
      await page.waitForTimeout(1600);

      const links=await collectTenderLinks(page);
      for(const x of links){
        if(!x.href)continue;
        const base={source:s.name,sourceId:s.id,url:x.href,title:clean(x.title)||term,description:clean(x.context),bidNumber:parseBidNumber(x.context+' '+x.title),discoveredBy:[term]};
        if(!found.has(x.href))found.set(x.href,base);
        else if(!found.get(x.href).discoveredBy.includes(term))found.get(x.href).discoveredBy.push(term);
      }

      // Fallback: inspect visible rows/cards that may contain bid number/name but use JS links.
      const visibleText=await page.locator('body').innerText();
      const lines=visibleText.split('\n').map(clean).filter(Boolean);
      for(let i=0;i<lines.length;i++){
        if(/\b26-\d{3,4}\b/.test(lines[i]) || /biosolid/i.test(lines[i])){
          const context=lines.slice(Math.max(0,i-2),Math.min(lines.length,i+4)).join(' | ');
          const num=parseBidNumber(context);
          if(num && /biosolid|wastewater|stormwater|environment|sampling|effluent|sewage|sediment|groundwater|remediation|risk|water quality/i.test(context)){
            const key='metro-text-'+num;
            if(!found.has(key))found.set(key,{source:s.name,sourceId:s.id,url:s.url,bidNumber:num,title:context,description:context,discoveredBy:[term],fallback:true});
          }
        }
      }
    }
  } finally {await page.close()}

  return await hydrate(found,s,browser);
}

async function hydrate(found,s,browser){
  const detail=await browser.newPage({viewport:{width:1440,height:1300}});
  const out=[];
  try{
    for(const [key,item] of found.entries()){
      if(item.fallback){
        out.push({...item,status:'unknown',closing:'',...score(item)});
        continue;
      }
      try{
        await detail.goto(item.url,{waitUntil:'domcontentloaded',timeout:45000});
        await detail.waitForTimeout(800);
        const body=clean(await detail.locator('body').innerText());
        const f=detailFields(body);
        const title=f.bidName||item.title;
        const sc=score({title,description:body});
        out.push({...item,bidNumber:f.bidNumber||item.bidNumber||'',title,description:body.slice(0,20000),status:f.status,closing:f.closing,...sc});
      }catch{
        out.push({...item,status:'unknown',closing:'',...score(item)});
      }
    }
  } finally {await detail.close()}
  return out;
}

async function bonfireSource(s,browser){
  const page=await browser.newPage({viewport:{width:1400,height:1200}});
  try{
    await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(7000);
    const rows=await page.locator('a').evaluateAll(as=>as.map(a=>({title:(a.innerText||'').trim(),href:a.href,context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()})));
    const out=[];
    for(const x of rows){
      if(x.title.length<8||!/^https?:/.test(x.href))continue;
      const text=(x.href+' '+x.context).toLowerCase();
      if(!/opportun|project|portal/.test(text)||out.some(y=>y.url===x.href))continue;
      out.push({source:s.name,sourceId:s.id,bidNumber:parseBidNumber(x.context+' '+x.title),title:clean(x.title),description:clean(x.context),url:x.href,closing:'',status:'unknown',...score({title:x.title,description:x.context})});
    }
    return out;
  }finally{await page.close()}
}
async function bcBidSource(s,browser){
  const page=await browser.newPage({viewport:{width:1400,height:1200}});
  try{
    await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(8000);
    const body=(await page.locator('body').innerText()).toLowerCase();
    if(body.includes('checking your browser')) return {blocked:true,items:[]};
    const rows=await page.locator('a').evaluateAll(as=>as.map(a=>({title:(a.innerText||'').trim(),href:a.href,context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()})));
    const out=[];
    for(const x of rows){
      if(x.title.length<8||!/^https?:/.test(x.href))continue;
      const text=(x.title+' '+x.context).toLowerCase();
      if(!ISLAND.some(g=>text.includes(g)))continue;
      const sc=score({title:x.title,description:x.context});
      if(sc.score>=20&&!out.some(y=>y.url===x.href))out.push({source:s.name,sourceId:s.id,bidNumber:parseBidNumber(x.context+' '+x.title),title:clean(x.title),description:clean(x.context),url:x.href,closing:'',status:'unknown',...sc});
    }
    return {blocked:false,items:out};
  }finally{await page.close()}
}

const browser=await chromium.launch({headless:true});
const statuses=[],items=[];
for(const s of cfg.sources){
  try{
    let rows=[],note='';
    if(s.type==='html')rows=await htmlSource(s);
    else if(s.type==='bids_search')rows=await genericBidsSearch(s,browser);
    else if(s.type==='metro_bids')rows=await metroBidsSearch(s,browser);
    else if(s.type==='bonfire')rows=await bonfireSource(s,browser);
    else if(s.type==='bcbid'){const r=await bcBidSource(s,browser);rows=r.items;if(r.blocked)note='BC Bid browser check blocked the public automation session.';}
    const relevant=rows.filter(x=>x.score>=20);
    items.push(...relevant);
    statuses.push({source:s.name,status:note?'limited':'ok',note,discovered:rows.length,relevant:relevant.length,openCount:relevant.filter(x=>x.status==='open').length,closedCount:relevant.filter(x=>x.status==='closed').length});
  }catch(e){
    statuses.push({source:s.name,status:'error',note:String(e.message||e),discovered:0,relevant:0,openCount:0,closedCount:0});
  }
}
await browser.close();

const rank={open:0,unknown:1,closed:2};
const dedup=[...new Map(items.map(x=>[(x.url||x.source+'|'+x.bidNumber+'|'+x.title).toLowerCase(),x])).values()]
 .sort((a,b)=>(rank[a.status]??1)-(rank[b.status]??1)||b.score-a.score);

fs.writeFileSync('data/results.json',JSON.stringify({refreshedAt:new Date().toISOString(),items:dedup,statuses},null,2));
console.log(`Wrote ${dedup.length} relevant opportunities; ${dedup.filter(x=>x.status==='open').length} open.`);
