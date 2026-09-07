
import fs from 'fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const cfg=JSON.parse(fs.readFileSync('config.json','utf8'));
const HIGH=cfg.keywords_high, MED=cfg.keywords_medium, SEARCH=cfg.search_terms;
const BCORGS=cfg.bcbid_priority_organizations||[];

const NEG=['roof replacement','hvac','paving','asphalt','janitorial','vehicle','fleet','playground',
'watermain replacement','water main replacement','pump replacement','sewer replacement','electrical upgrade',
'mechanical upgrade','building renovation','road construction','roadworks','landscaping','snow removal',
'fire apparatus','furniture'];

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
  for(const p of [
    /\b(?:Bid Number|Bid No\.?|Solicitation Number|RFP No\.?|Tender No\.?|Opportunity ID)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /\b(\d{2}-\d{3,4})\b/
  ]){const m=text.match(p);if(m)return clean(m[1]);}
  return '';
}
function detailFields(body){
  const status=(body.match(/(?:Bid Status|RFx Status|Status):\s*([^\n\r]+)/i)||[])[1]||'';
  const closing=(body.match(/(?:Bid Closing Date|Closing Date|Closing):\s*([^\n\r]+)/i)||[])[1]||'';
  const bidName=(body.match(/(?:Bid Name|Opportunity Description):\s*([^\n\r]+)/i)||[])[1]||'';
  const bidNumber=parseBidNumber(body);
  let normalized='unknown';
  if(/\bopen\b|in progress|accepting/i.test(status)) normalized='open';
  else if(/awarded|closed|cancelled|canceled|expired|completed/i.test(status)) normalized='closed';
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

async function externalTenderDiscovery(domain,terms){
  const found=new Map();
  for(const term of terms){
    const q=`site:${domain} "/Tender/Detail/" "${term}"`;
    for(const engine of [
      `https://www.google.com/search?q=${encodeURIComponent(q)}`,
      `https://www.bing.com/search?q=${encodeURIComponent(q)}`
    ]){
      try{
        const r=await fetch(engine,{headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'}});
        if(!r.ok)continue;
        const html=await r.text();
        const $=cheerio.load(html);
        $('a').each((_,a)=>{
          let href=$(a).attr('href')||'';
          if(href.startsWith('/url?q=')) href=decodeURIComponent(href.slice(7).split('&')[0]);
          if(href.includes('/Tender/Detail/') && href.includes(domain)){
            const title=clean($(a).text())||term;
            found.set(href,{url:href,title,description:title,discoveredBy:[term]});
          }
        });
      }catch{}
      if(found.size) break;
    }
  }
  return found;
}

async function harvestPortalLinks(page){
  const links=await page.locator('a[href*="/Tender/Detail/"]').evaluateAll(as=>as.map(a=>({
    href:a.href,title:(a.innerText||a.textContent||'').trim(),
    context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
  })));
  return links;
}
async function waitAndHarvest(s,browser,extraTerms=[]){
  const page=await browser.newPage({viewport:{width:1440,height:1400}});
  const found=new Map();
  try{
    await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(6000);
    for(const x of await harvestPortalLinks(page)){
      if(x.href)found.set(x.href,{source:s.name,sourceId:s.id,url:x.href,title:clean(x.title),description:clean(x.context),discoveredBy:['portal']});
    }
    // Try any visible keyword/search input, but do not fail if absent.
    const candidates=page.locator('input:visible');
    for(const term of [...new Set([...SEARCH,...extraTerms])]){
      let box=null;
      for(let i=0;i<await candidates.count();i++){
        const el=candidates.nth(i);
        try{
          const a=(await el.evaluate(e=>`${e.type} ${e.id} ${e.name} ${e.placeholder} ${e.getAttribute('aria-label')||''}`)).toLowerCase();
          if(/search|keyword|filter/.test(a)){box=el;break}
        }catch{}
      }
      if(!box)break;
      try{
        await box.fill(term);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1200);
        for(const x of await harvestPortalLinks(page)){
          if(!x.href)continue;
          if(!found.has(x.href))found.set(x.href,{source:s.name,sourceId:s.id,url:x.href,title:clean(x.title)||term,description:clean(x.context),discoveredBy:[term]});
          else if(!found.get(x.href).discoveredBy.includes(term))found.get(x.href).discoveredBy.push(term);
        }
      }catch{}
    }
  } finally {await page.close()}

  // Search-engine fallback, which avoids dependence on the portal's search control.
  const domain=new URL(s.url).hostname;
  const web=await externalTenderDiscovery(domain,[...new Set([...SEARCH,...extraTerms])]);
  for(const [href,x] of web.entries()){
    if(!found.has(href))found.set(href,{source:s.name,sourceId:s.id,...x});
  }
  return found;
}

async function hydrate(found,s,browser){
  const page=await browser.newPage({viewport:{width:1440,height:1400}});
  const out=[];
  try{
    for(const item of found.values()){
      try{
        await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:45000});
        await page.waitForTimeout(700);
        const body=clean(await page.locator('body').innerText());
        const f=detailFields(body),title=f.bidName||item.title||body.slice(0,150);
        out.push({...item,bidNumber:f.bidNumber||item.bidNumber||parseBidNumber(title),title,description:body.slice(0,22000),status:f.status,closing:f.closing,...score({title,description:body})});
      }catch{
        out.push({...item,bidNumber:item.bidNumber||parseBidNumber(item.title+' '+item.description),status:'unknown',closing:'',...score(item)});
      }
    }
  } finally {await page.close()}
  return out;
}

async function bidsMulti(s,browser){
  return hydrate(await waitAndHarvest(s,browser),s,browser);
}
async function metroMulti(s,browser){
  const metroTerms=['biosolids','biosolid','biosolids management','wastewater','stormwater','environmental services',
    'environmental monitoring','sampling','effluent','sewage','combined sewer overflow','risk assessment',
    'water quality','remediation','sediment','groundwater','PFAS','AIWWTP'];
  return hydrate(await waitAndHarvest(s,browser,metroTerms),s,browser);
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

async function waitOutBcBidCheck(page){
  const start=Date.now();
  while(Date.now()-start < 35000){
    const body=(await page.locator('body').innerText().catch(()=>'' )).toLowerCase();
    if(!body.includes('checking your browser') && !body.includes('please wait while we are checking')) return true;
    await page.waitForTimeout(2500);
  }
  return false;
}
async function findControlNearText(page,text){
  // label association first
  const label=page.locator('label').filter({hasText:new RegExp(text,'i')}).first();
  try{
    if(await label.count()){
      const fr=await label.getAttribute('for');
      if(fr){const el=page.locator(`#${fr}`);if(await el.count())return el}
      const nested=label.locator('input,select,[role="combobox"]').first();
      if(await nested.count())return nested;
    }
  }catch{}
  // fallback by attributes
  const all=page.locator('input,select,[role="combobox"]');
  for(let i=0;i<await all.count();i++){
    const el=all.nth(i);
    try{
      const a=(await el.evaluate(e=>`${e.id} ${e.name} ${e.placeholder||''} ${e.getAttribute('aria-label')||''}`)).toLowerCase();
      if(a.includes(text.toLowerCase()))return el;
    }catch{}
  }
  return null;
}
async function chooseOption(page,control,text){
  if(!control)return false;
  try{
    if(await control.evaluate(e=>e.tagName.toLowerCase())==='select'){
      const opts=await control.locator('option').allTextContents();
      const match=opts.find(o=>o.toLowerCase().includes(text.toLowerCase()));
      if(match){await control.selectOption({label:match});return true}
    }
  }catch{}
  try{
    await control.click();
    const opt=page.getByRole('option',{name:new RegExp(text,'i')}).first();
    if(await opt.count()){await opt.click();return true}
  }catch{}
  return false;
}
async function clickSearch(page){
  for(const loc of [
    page.getByRole('button',{name:/^search$/i}).first(),
    page.locator('button:has-text("Search")').first(),
    page.locator('input[type="submit"][value*="Search" i]').first()
  ]){
    try{if(await loc.count()&&await loc.isVisible()){await loc.click();return true}}catch{}
  }
  return false;
}
async function extractBcBidRows(page,s){
  const items=[];
  const rows=page.locator('tr,[role="row"]');
  for(let i=0;i<await rows.count();i++){
    const row=rows.nth(i);
    let txt='';try{txt=clean(await row.innerText())}catch{}
    if(!txt||txt.length<15)continue;
    const sc=score({title:txt,description:txt});
    if(sc.score<20)continue;
    let url=s.url;
    try{
      const a=row.locator('a').first();
      if(await a.count())url=await a.getAttribute('href')||url;
      if(url&&!/^https?:/.test(url))url=new URL(url,s.url).toString();
    }catch{}
    const f=detailFields(txt);
    items.push({source:s.name,sourceId:s.id,bidNumber:f.bidNumber||parseBidNumber(txt),title:f.bidName||txt.slice(0,240),description:txt,url,closing:f.closing,status:f.status==='unknown'?'open':f.status,...sc});
  }
  return items;
}
async function bcBidPublic(s,browser){
  const page=await browser.newPage({viewport:{width:1500,height:1500}});
  const found=new Map();
  let note='';
  try{
    await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:60000});
    const passed=await waitOutBcBidCheck(page);
    if(!passed)return {items:[],note:'BC Bid browser check did not clear within 35 seconds.'};

    // Public guide says Opportunities status defaults to Open.
    // First try a region-wide Vancouver Island search for every term.
    const region=await findControlNearText(page,'region');
    if(region) await chooseOption(page,region,'Vancouver Island');

    const keyword=await findControlNearText(page,'keyword');
    if(!keyword)return {items:[],note:'BC Bid loaded, but keyword field could not be identified.'};

    for(const term of SEARCH){
      try{
        await keyword.fill(term);
        await clickSearch(page);
        await page.waitForTimeout(1300);
        for(const x of await extractBcBidRows(page,s)){
          const key=(x.url+'|'+x.bidNumber+'|'+x.title).toLowerCase();
          found.set(key,x);
        }
      }catch{}
    }

    // Second pass: priority Vancouver Island organizations, focused on the broadest terms.
    const org=await findControlNearText(page,'organization');
    if(org){
      for(const orgName of BCORGS){
        try{
          await chooseOption(page,org,orgName);
          for(const term of ['environmental','wastewater','stormwater','biosolid','sampling','risk assessment','water quality','remediation']){
            await keyword.fill(term);
            await clickSearch(page);
            await page.waitForTimeout(900);
            for(const x of await extractBcBidRows(page,s)){
              const key=(x.url+'|'+x.bidNumber+'|'+x.title).toLowerCase();
              found.set(key,x);
            }
          }
        }catch{}
      }
    }
    return {items:[...found.values()],note};
  }finally{await page.close()}
}

const browser=await chromium.launch({headless:true});
const statuses=[],items=[];
for(const s of cfg.sources){
  try{
    let rows=[],note='';
    if(s.type==='html')rows=await htmlSource(s);
    else if(s.type==='bids_multi')rows=await bidsMulti(s,browser);
    else if(s.type==='metro_multi')rows=await metroMulti(s,browser);
    else if(s.type==='bonfire')rows=await bonfireSource(s,browser);
    else if(s.type==='bcbid_public'){const r=await bcBidPublic(s,browser);rows=r.items;note=r.note||''}
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
