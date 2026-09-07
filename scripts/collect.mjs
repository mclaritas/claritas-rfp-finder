
import fs from 'fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const cfg=JSON.parse(fs.readFileSync('config.json','utf8'));
const HIGH=cfg.keywords_high, MED=cfg.keywords_medium, SEARCH=cfg.search_terms, BCORGS=cfg.bcbid_priority_organizations||[];

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
function inferStatus(text=''){
  const t=text.toLowerCase();
  if(/awarded|closed|cancelled|canceled|expired|completed/.test(t)) return 'closed';
  if(/\bopen\b|accepting submissions|in progress|posted/.test(t)) return 'open';
  return 'unknown';
}
function extractClosing(text=''){
  for(const p of [
    /(?:Bid Closing Date|Closing Date|Closing|Closes)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}(?:[^|]{0,25})?)/i,
    /(?:Bid Closing Date|Closing Date|Closing|Closes)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}(?:[^|]{0,25})?)/i
  ]){const m=text.match(p);if(m)return clean(m[1]);}
  return '';
}
function mergeScores(listing,detail){
  const title=detail.title||listing.title;
  const description=(listing.description||'')+' '+(detail.description||'');
  return {...listing,...detail,title,description,...score({title,description})};
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
    out.push({source:s.name,sourceId:s.id,bidNumber:parseBidNumber(title+' '+description),title,description,url,closing:extractClosing(description),status:inferStatus(title+' '+description),...score({title,description})});
  });
  return out;
}

async function searchEngineLinks(domain,terms){
  const found=new Map();
  for(const term of terms){
    const queries=[
      `site:${domain} "/Tender/Detail/" "${term}"`,
      `site:${domain} "${term}" bids and tenders`
    ];
    for(const q of queries){
      for(const engine of [
        `https://www.google.com/search?q=${encodeURIComponent(q)}`,
        `https://www.bing.com/search?q=${encodeURIComponent(q)}`
      ]){
        try{
          const r=await fetch(engine,{headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'}});
          if(!r.ok)continue;
          const $=cheerio.load(await r.text());
          $('a').each((_,a)=>{
            let href=$(a).attr('href')||'';
            if(href.startsWith('/url?q='))href=decodeURIComponent(href.slice(7).split('&')[0]);
            if(!href.includes(domain))return;
            if(!href.includes('/Tender/Detail/'))return;
            const title=clean($(a).text())||term;
            const context=clean($(a).parent().text());
            found.set(href,{url:href,title,description:context||title,discoveredBy:[term]});
          });
        }catch{}
        if(found.size)break;
      }
    }
  }
  return found;
}

async function portalListingLinks(s,browser){
  const page=await browser.newPage({viewport:{width:1440,height:1400}});
  const found=new Map();
  try{
    await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(5000);

    for(let p=0;p<10;p++){
      const rows=await page.locator('a[href*="/Tender/Detail/"]').evaluateAll(as=>as.map(a=>({
        href:a.href,
        title:(a.innerText||a.textContent||'').trim(),
        context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
      })));
      for(const x of rows){
        if(!x.href)continue;
        const base={source:s.name,sourceId:s.id,url:x.href,bidNumber:parseBidNumber(x.title+' '+x.context),title:clean(x.title),description:clean(x.context),closing:extractClosing(x.context),status:inferStatus(x.context),discoveredBy:['portal']};
        found.set(x.href,{...base,...score(base)});
      }

      const next=page.locator('[aria-label*="Next" i]:visible,button:has-text("Next Page"):visible,a:has-text("Next Page"):visible').first();
      try{
        if(!(await next.count())||!(await next.isVisible())||!(await next.isEnabled()))break;
        await next.click();await page.waitForTimeout(1200);
      }catch{break}
    }
  } finally {await page.close()}
  return found;
}

async function bidsListingFirst(s,browser){
  const portal=await portalListingLinks(s,browser);
  const web=await searchEngineLinks(new URL(s.url).hostname,SEARCH);
  for(const [u,x] of web.entries()){
    if(!portal.has(u)){
      const base={source:s.name,sourceId:s.id,url:u,bidNumber:parseBidNumber(x.title+' '+x.description),title:x.title,description:x.description,closing:'',status:'unknown',discoveredBy:x.discoveredBy};
      portal.set(u,{...base,...score(base)});
    }
  }

  const page=await browser.newPage({viewport:{width:1440,height:1400}});
  const out=[];
  try{
    for(const item of portal.values()){
      let detail={};
      try{
        await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:45000});
        await page.waitForTimeout(700);
        const body=clean(await page.locator('body').innerText());
        detail={
          bidNumber:parseBidNumber(body)||item.bidNumber,
          title:(body.match(/Bid Name:\s*([^\n\r]+)/i)||[])[1]||item.title,
          description:body.slice(0,22000),
          closing:extractClosing(body)||item.closing,
          status:inferStatus(body)!=='unknown'?inferStatus(body):item.status
        };
      }catch{}
      out.push(mergeScores(item,detail));
    }
  } finally {await page.close()}
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
      const base={source:s.name,sourceId:s.id,bidNumber:parseBidNumber(x.context+' '+x.title),title:clean(x.title),description:clean(x.context),url:x.href,closing:extractClosing(x.context),status:inferStatus(x.context)};
      out.push({...base,...score(base)});
    }
    return out;
  }finally{await page.close()}
}

async function bcbidIndexed(s){
  const found=new Map();

  // Broad environmental terms scoped to BC Bid.
  const broad=['biosolid','biosolids','wastewater','stormwater','environmental','sampling','risk assessment','water quality','remediation','PFAS','groundwater','sediment','effluent'];
  const queries=[];
  for(const term of broad){
    queries.push(`site:bcbid.gov.bc.ca "${term}" "Vancouver Island"`);
  }
  // Organization-specific passes, including Victoria/CRD.
  for(const org of BCORGS){
    for(const term of ['environmental','wastewater','stormwater','biosolid','sampling','risk assessment','water quality','remediation']){
      queries.push(`site:bcbid.gov.bc.ca "${org}" "${term}"`);
    }
  }

  for(const q of queries){
    for(const engine of [
      `https://www.google.com/search?q=${encodeURIComponent(q)}`,
      `https://www.bing.com/search?q=${encodeURIComponent(q)}`
    ]){
      try{
        const r=await fetch(engine,{headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'}});
        if(!r.ok)continue;
        const $=cheerio.load(await r.text());
        $('a').each((_,a)=>{
          let href=$(a).attr('href')||'';
          if(href.startsWith('/url?q='))href=decodeURIComponent(href.slice(7).split('&')[0]);
          if(!href.includes('bcbid.gov.bc.ca'))return;
          const title=clean($(a).text());
          const snippet=clean($(a).parent().parent().text())||clean($(a).parent().text())||title;
          const base={source:s.name,sourceId:s.id,bidNumber:parseBidNumber(title+' '+snippet),title:title||snippet.slice(0,180),description:snippet,url:href,closing:extractClosing(snippet),status:inferStatus(snippet)};
          const sc=score(base);
          if(sc.score>=20){
            const key=(href+'|'+base.bidNumber+'|'+base.title).toLowerCase();
            found.set(key,{...base,...sc});
          }
        });
      }catch{}
      if(found.size)break;
    }
  }

  return [...found.values()];
}

const browser=await chromium.launch({headless:true});
const statuses=[],items=[];
for(const s of cfg.sources){
  try{
    let rows=[],note='';
    if(s.type==='html')rows=await htmlSource(s);
    else if(s.type==='bids_listing_first')rows=await bidsListingFirst(s,browser);
    else if(s.type==='bonfire')rows=await bonfireSource(s,browser);
    else if(s.type==='bcbid_indexed'){
      rows=await bcbidIndexed(s);
      if(!rows.length)note='No indexed BC Bid matches found in this run. BC Bid browser challenge is bypassed using indexed public discovery.';
    }
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
console.log(`Wrote ${dedup.length} relevant opportunities; ${dedup.filter(x=>x.status==='open').length} confirmed open.`);
