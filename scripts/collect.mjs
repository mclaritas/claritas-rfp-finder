
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
    /\b(?:Bid Number|Bid No\.?|Solicitation Number|Solicitation No\.?|Reference Number|RFP No\.?|Tender No\.?|Opportunity ID)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /\b(\d{2}-\d{3,4})\b/
  ]){const m=text.match(p);if(m)return clean(m[1]);}
  return '';
}
function inferStatus(text=''){
  const t=text.toLowerCase();
  if(/awarded|closed|cancelled|canceled|expired|completed/.test(t)) return 'closed';
  if(/\bopen\b|this solicitation is open|accepting submissions|in progress|posted/.test(t)) return 'open';
  return 'unknown';
}
function extractDate(text='', kind='closing'){
  const labels=kind==='opening'
    ? '(?:Bid Open Date|Open Date|Opening Date|Posted Date|Issue Date|Published Date|Publication Date|Publication|Opportunity Open Date)'
    : '(?:Bid Closing Date|Closing Date|Close Date|Closing|Closes|Opportunity Close Date)';
  const pats=[
    new RegExp(labels+'\\s*[:\\-]?\\s*([A-Za-z]{3,9}\\s+\\d{1,2},\\s+\\d{4}(?:[^|\\n\\r]{0,32})?)','i'),
    new RegExp(labels+'\\s*[:\\-]?\\s*(\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2}(?:[^|\\n\\r]{0,32})?)','i'),
    new RegExp(labels+'\\s*[:\\-]?\\s*(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}(?:[^|\\n\\r]{0,32})?)','i')
  ];
  for(const p of pats){const m=text.match(p);if(m)return clean(m[1]);}
  return '';
}
function validHttpUrl(href,hostContains=''){
  try{
    if(!/^https?:\/\//i.test(href))return false;
    const u=new URL(href);
    if(hostContains && !u.hostname.includes(hostContains))return false;
    if(/bing\.com\/search|google\.com\/search|copilotsearch/i.test(u.href))return false;
    return true;
  }catch{return false}
}
function baseItem(s,url,title,description){
  return {
    source:s.name,sourceId:s.id,url,
    bidNumber:parseBidNumber(title+' '+description),
    title:clean(title),description:clean(description),
    openDate:extractDate(description,'opening'),
    closing:extractDate(description,'closing'),
    status:inferStatus(title+' '+description)
  };
}
function mergeScores(listing,detail){
  const title=detail.title||listing.title;
  const description=(listing.description||'')+' '+(detail.description||'');
  return {
    ...listing,...detail,title,description,
    bidNumber:detail.bidNumber||listing.bidNumber||parseBidNumber(title+' '+description),
    openDate:detail.openDate||listing.openDate||'',
    closing:detail.closing||listing.closing||'',
    status:detail.status&&detail.status!=='unknown'?detail.status:listing.status,
    ...score({title,description})
  };
}

async function bingRss(query){
  const url=`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  try{
    const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'}});
    if(!r.ok)return [];
    const xml=await r.text(),$=cheerio.load(xml,{xmlMode:true});
    return $('item').map((_,it)=>({
      title:clean($(it).find('title').text()),
      link:clean($(it).find('link').text()),
      description:clean($(it).find('description').text())
    })).get();
  }catch{return []}
}

async function htmlSource(s){
  const r=await fetch(s.url,{headers:{'user-agent':'Mozilla/5.0'}});
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  const html=await r.text(),$=cheerio.load(html),out=[];
  $('table tr').each((_,tr)=>{
    const cells=$(tr).find('td').map((i,x)=>clean($(x).text())).get();
    if(cells.length<2)return;
    const a=$(tr).find('a').first();
    const title=clean(a.text())||cells.slice().sort((a,b)=>b.length-a.length)[0];
    if(!title||title.length<8)return;
    let url=s.url;try{if(a.attr('href'))url=new URL(a.attr('href'),s.url).toString()}catch{}
    const description=cells.join(' | ');
    const base=baseItem(s,url,title,description);
    out.push({...base,...score(base)});
  });
  return out;
}

async function portalListingLinks(s,browser){
  const page=await browser.newPage({viewport:{width:1440,height:1400}});
  const found=new Map();
  try{
    await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(5000);
    for(let p=0;p<12;p++){
      const rows=await page.locator('a[href*="/Tender/Detail/"]').evaluateAll(as=>as.map(a=>({
        href:a.href,
        title:(a.innerText||a.textContent||'').trim(),
        context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
      })));
      for(const x of rows){
        if(!validHttpUrl(x.href,new URL(s.url).hostname))continue;
        const base=baseItem(s,x.href,x.title,x.context);
        found.set(x.href,{...base,...score(base),discoveredBy:['portal']});
      }
      const next=page.locator('[aria-label*="Next" i]:visible,button:has-text("Next Page"):visible,a:has-text("Next Page"):visible').first();
      try{
        if(!(await next.count())||!(await next.isVisible())||!(await next.isEnabled()))break;
        await next.click();await page.waitForTimeout(1000);
      }catch{break}
    }
  }finally{await page.close()}
  return found;
}

async function rssTenderDiscovery(s,extra=[]){
  const domain=new URL(s.url).hostname;
  const found=new Map();
  for(const term of [...new Set([...SEARCH,...extra])]){
    const rows=await bingRss(`site:${domain} "/Tender/Detail/" "${term}"`);
    for(const x of rows){
      if(!validHttpUrl(x.link,domain))continue;
      if(!x.link.includes('/Tender/Detail/'))continue;
      const base=baseItem(s,x.link,x.title||term,x.description||x.title||term);
      const sc=score(base);
      if(sc.score<20)continue;
      found.set(x.link,{...base,...sc,discoveredBy:[term]});
    }
  }
  return found;
}

async function hydrate(found,s,browser){
  const page=await browser.newPage({viewport:{width:1440,height:1400}});
  const out=[];
  try{
    for(const item of found.values()){
      let detail={};
      try{
        await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:45000});
        await page.waitForTimeout(700);
        const body=clean(await page.locator('body').innerText());
        const title=(body.match(/Bid Name:\s*([^\n\r]+)/i)||[])[1]
          ||(body.match(/Title\s*[:\-]\s*([^\n\r]+)/i)||[])[1]
          ||item.title;
        detail={
          bidNumber:parseBidNumber(body)||item.bidNumber,
          title:clean(title),
          description:body.slice(0,24000),
          openDate:extractDate(body,'opening')||item.openDate,
          closing:extractDate(body,'closing')||item.closing,
          status:inferStatus(body)
        };
      }catch{}
      out.push(mergeScores(item,detail));
    }
  }finally{await page.close()}
  return out;
}

async function bidsSource(s,browser){
  const found=await portalListingLinks(s,browser);
  const extra=s.id==='metrovan'
    ? ['biosolids','biosolid','biosolids management','AIWWTP','wastewater','stormwater','environmental services','combined sewer overflow']
    : [];
  const rss=await rssTenderDiscovery(s,extra);
  for(const [u,x] of rss.entries()) if(!found.has(u)) found.set(u,x);
  return hydrate(found,s,browser);
}

async function bonfireSource(s,browser){
  const page=await browser.newPage({viewport:{width:1400,height:1200}});
  try{
    await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(7000);
    const rows=await page.locator('a').evaluateAll(as=>as.map(a=>({
      title:(a.innerText||'').trim(),href:a.href,
      context:(a.closest('tr')?.innerText||a.closest('[role=row]')?.innerText||a.parentElement?.parentElement?.innerText||'').trim()
    })));
    const out=[];
    for(const x of rows){
      if(x.title.length<8||!validHttpUrl(x.href))continue;
      const text=(x.href+' '+x.context).toLowerCase();
      if(!/opportun|project|portal/.test(text)||out.some(y=>y.url===x.href))continue;
      const base=baseItem(s,x.href,x.title,x.context);
      out.push({...base,...score(base)});
    }
    return out;
  }finally{await page.close()}
}

async function bcBidSource(s){
  const found=new Map();

  // First try real BC Bid indexed URLs.
  for(const term of ['biosolid','biosolids','wastewater','stormwater','environmental','sampling','risk assessment','water quality','remediation','PFAS','groundwater','sediment','effluent']){
    const rows=await bingRss(`site:bcbid.gov.bc.ca "${term}" "Vancouver Island"`);
    for(const x of rows){
      if(!validHttpUrl(x.link,'bcbid.gov.bc.ca'))continue;
      const base=baseItem(s,x.link,x.title,x.description);
      const sc=score(base);
      if(sc.score>=20)found.set(x.link,{...base,...sc});
    }
  }

  // If BC Bid itself is poorly indexed, use public procurement mirrors to recover real BC public opportunities.
  // We label them transparently as BC Bid / public index.
  if(found.size<3){
    const mirrorSource={...s,name:'BC Bid / public index'};
    for(const org of BCORGS){
      for(const term of ['environmental','wastewater','stormwater','biosolid','sampling','risk assessment','water quality','remediation']){
        const rows=await bingRss(`"${org}" "${term}" (site:merx.com OR site:bcbid.gov.bc.ca)`);
        for(const x of rows){
          if(!validHttpUrl(x.link))continue;
          if(!/merx\.com|bcbid\.gov\.bc\.ca/i.test(new URL(x.link).hostname))continue;
          const combined=(x.title+' '+x.description).toLowerCase();
          if(!combined.includes(org.toLowerCase()))continue;
          const base=baseItem(mirrorSource,x.link,x.title,x.description);
          const sc=score(base);
          if(sc.score>=20)found.set(x.link,{...base,...sc});
        }
      }
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
    else if(s.type==='bids_listing_first')rows=await bidsSource(s,browser);
    else if(s.type==='bonfire')rows=await bonfireSource(s,browser);
    else if(s.type==='bcbid_indexed'){
      rows=await bcBidSource(s);
      if(!rows.length)note='No verified BC Bid or public-index matches found in this run.';
    }

    rows=rows.filter(x=>validHttpUrl(x.url));
    const relevant=rows.filter(x=>x.score>=20);
    items.push(...relevant);
    statuses.push({
      source:s.name,status:note?'limited':'ok',note,
      discovered:rows.length,relevant:relevant.length,
      openCount:relevant.filter(x=>x.status==='open').length,
      closedCount:relevant.filter(x=>x.status==='closed').length
    });
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
