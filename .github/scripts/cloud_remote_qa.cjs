'use strict';
// Read-only live-site verification. All answers stay in an isolated, temporary
// Playwright context; this script never uploads data or calls GitHub APIs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const base=process.argv[2]||process.env.N1_LIVE_BASE||'https://Subterranean-Sun.github.io/n1-study/';
const audioUrl='https://Subterranean-Sun.github.io/n1-audio/audio/2026_07.mp3';
const out=process.env.LIVE_QA_OUTPUT_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'n1-live-qa-'));
fs.mkdirSync(out,{recursive:true});
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={status:'running',base,audioUrl,phoneViewport:'390x844',storage:'isolated temporary Playwright browser context only',steps:[],errors:[],failed:[],networkFailures:[],rangeResponses:[],resourceHeaders:[],screenshots:[]};
let browser,page,ctx;
const cappedPush=(list,value,limit=50)=>{if(list.length<limit)list.push(value);};
const save=()=>fs.writeFileSync(path.join(out,'remote-report.json'),JSON.stringify(report,null,2));
function step(name,evidence){report.steps.push({name,...(evidence?{evidence}:{})});save();console.log('PASS '+name+(evidence?' '+JSON.stringify(evidence):''));}
async function screenshot(name){
  await page.screenshot({path:path.join(out,name),fullPage:false,timeout:15000});report.screenshots.push(name);
}
async function navigate(url){
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
      assert(response&&response.status()<400,'Navigation returned HTTP '+response?.status()+' for '+url);
      return;
    }catch(error){if(attempt===3)throw error;console.warn('Navigation retry '+attempt+' '+url);await sleep(1000);}
  }
}
async function requestRange(url,lastByte,signature){
  const response=await ctx.request.get(url,{headers:{Range:'bytes=0-'+lastByte},timeout:90000});
  const bytes=await response.body(),headers=response.headers();
  const proof={url,status:response.status(),contentRange:headers['content-range']||null,bytes:bytes.length,acceptRanges:headers['accept-ranges']||null,contentType:headers['content-type']||null};
  assert(proof.status===206,'Range request must return HTTP 206: '+JSON.stringify(proof));
  assert(new RegExp('^bytes 0-'+lastByte+'/\\d+$').test(proof.contentRange||''),'Incorrect Content-Range: '+JSON.stringify(proof));
  assert(bytes.length===lastByte+1,'Range body length incorrect: '+JSON.stringify(proof));
  if(signature){proof.signature=bytes.subarray(0,signature.length).toString('ascii');assert(proof.signature===signature,'Unexpected resource signature: '+JSON.stringify(proof));}
  await response.dispose();return proof;
}
(async()=>{
  assert(/^https:\/\//.test(base),'Live base must use HTTPS');
  save();
  browser=await chromium.launch({headless:true});
  ctx=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'});
  ctx.setDefaultTimeout(240000);ctx.setDefaultNavigationTimeout(90000);
  page=await ctx.newPage();
  page.on('pageerror',error=>cappedPush(report.errors,error.message));
  page.on('requestfailed',request=>cappedPush(report.networkFailures,{url:request.url(),error:request.failure()?.errorText||null}));
  page.on('response',response=>{
    const url=response.url().toLowerCase(),headers=response.headers();
    if(/\/(?:knowledge|revision-index)\.js(?:\?|$)/.test(url))cappedPush(report.resourceHeaders,{url:response.url(),status:response.status(),encoding:headers['content-encoding']||null,length:headers['content-length']||null,type:headers['content-type']||null});
    if(response.status()>=400&&(url.startsWith(base.toLowerCase())||url.includes('/n1-audio/audio/')))cappedPush(report.failed,{url:response.url(),status:response.status()});
    if(url.includes('/n1-audio/audio/2026_07.mp3'))cappedPush(report.rangeResponses,{status:response.status(),requestRange:response.request().headers()['range']||null,contentRange:headers['content-range']||null});
  });

  report.rangeProof=await requestRange(audioUrl,1023);step('MP3 HTTP Range',report.rangeProof);
  await navigate(base);
  await page.getByRole('link',{name:/^考点精编/}).waitFor({state:'visible'});
  assert(await page.evaluate(()=>getComputedStyle(document.querySelector('.main-nav')).display!=='none'),'Mobile main navigation is hidden');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile home overflows horizontally');
  await screenshot('remote-mobile-home.png');step('Mobile navigation and layout');

  await page.getByRole('link',{name:'打开知识点总览',exact:true}).click();
  await page.locator('#knowledge-search').waitFor({state:'visible'});
  await page.locator('#knowledge-search').fill('ざるを得ない');
  await page.waitForFunction(()=>document.querySelector('#knowledge-search')?.value==='ざるを得ない'&&document.querySelectorAll('.knowledge-results .knowledge-item').length>0);
  report.knowledgeSearchResults=await page.locator('.knowledge-results .knowledge-item').count();
  step('Knowledge overview loads and returns search results',{results:report.knowledgeSearchResults});

  await navigate(base);
  await page.getByRole('link',{name:/^考点精编/}).click();
  await page.getByRole('heading',{name:'按场次阅读与练习'}).waitFor({state:'visible'});
  assert(await page.locator('.exam-card').count()===32,'Revision route must contain 32 session cards');
  await page.getByRole('link',{name:'打开精编总索引 →'}).click();
  await page.waitForFunction(()=>document.readyState==='complete'&&window.N1_REVISION&&document.querySelector('#search-panel')&&document.querySelector('#query'));
  await page.locator('#query').fill('ざるを得ない');
  await page.waitForFunction(()=>{const panel=document.querySelector('#search-panel');return panel&&!panel.hidden&&document.querySelectorAll('.result').length>0;});
  report.searchCount=await page.locator('#result-count').textContent();
  await page.locator('.result .primary').first().click();
  await page.locator('.section:target').waitFor({state:'attached'});
  assert(await page.locator('.section:target').count()===1,'Revision search did not land on the target anchor');
  step('Revision search and deep link',{result:report.searchCount});

  await navigate(base+'knowledge/2026_07/1.html');
  await page.getByRole('link',{name:'本卷考点精编 →',exact:true}).click();
  await page.waitForURL('**/knowledge/revision/2026_07.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.getByRole('heading',{name:'2026 年 7 月 · 考点精编',exact:true}).waitFor({state:'visible'});
  assert(page.url().includes('/knowledge/revision/2026_07.html'),'Parallel knowledge link has an incorrect destination');
  step('Parallel knowledge-to-revision navigation');

  await navigate(base+'index.html?exam=2026_07&group=1&q=2');
  await page.locator('.q-label').waitFor({state:'visible'});
  assert((await page.locator('.q-label').textContent()).includes('2'),'Question query did not select question 2');
  await page.locator('.original-paper summary').click();
  await page.waitForFunction(()=>{const image=document.querySelector('.original-paper img');return image&&image.complete&&image.naturalWidth>0;});
  report.imageProof=await page.locator('.original-paper img').evaluate(image=>({url:image.currentSrc,width:image.naturalWidth,height:image.naturalHeight}));
  const pdfUrl=await page.evaluate(()=>new URL(window.N1_DATA['2026_07'].sourcePdf,location.href).href);
  report.pdfProof=await requestRange(pdfUrl,4,'%PDF-');step('Original image and PDF',{image:report.imageProof,pdf:report.pdfProof});
  await page.locator('.option').first().click();
  await page.reload({waitUntil:'domcontentloaded',timeout:90000});
  await page.locator('.option.selected').waitFor({state:'visible'});
  assert((await page.locator('.option.selected .opt-num').textContent()).trim()==='1','Answer was not restored from the isolated context after refresh');
  step('Answer persistence across refresh');

  await navigate(base+'index.html?exam=2026_07&group=L5&q=L5_1');
  await page.locator('#question-audio').waitFor({state:'visible'});
  await page.waitForFunction(()=>{const audio=document.querySelector('#question-audio');return audio&&Number.isFinite(audio.duration)&&audio.duration>0;},null,{timeout:240000});
  report.expectedAudioSegment=await page.evaluate(()=>{const question=window.N1_DATA['2026_07'].questions.find(q=>String(q.id)==='L5_1');return {start:question.audioStart,end:question.audioEnd};});
  assert(Number.isFinite(report.expectedAudioSegment.start)&&report.expectedAudioSegment.start>0,'L5 audio start is missing');
  await page.waitForFunction(start=>{const audio=document.querySelector('#question-audio');return audio&&Math.abs(audio.currentTime-start)<1&&audio.readyState>=2;},report.expectedAudioSegment.start,{timeout:240000});
  report.audioBefore=await page.locator('#question-audio').evaluate(audio=>({src:audio.currentSrc,duration:audio.duration,currentTime:audio.currentTime,readyState:audio.readyState,error:audio.error?.code||null}));
  assert(report.audioBefore.src.toLowerCase()===audioUrl.toLowerCase(),'Audio source is not the expected live MP3');
  await page.locator('[data-action="audio-replay"]').click();
  await page.waitForFunction(start=>{const audio=document.querySelector('#question-audio');return audio&&!audio.paused&&audio.currentTime>start+.2;},report.expectedAudioSegment.start,{timeout:90000});
  report.audioAfter=await page.locator('#question-audio').evaluate(audio=>{audio.pause();return {duration:audio.duration,currentTime:audio.currentTime,paused:audio.paused,error:audio.error?.code||null};});
  assert(!report.audioAfter.error,'Audio reported a media error');
  assert(report.audioAfter.currentTime>report.expectedAudioSegment.start+.2,'Audio clock did not advance after user-gesture playback');
  await screenshot('remote-audio-segment.png');step('Real L5 media metadata, automatic seek and playback',{expected:report.expectedAudioSegment,before:report.audioBefore,after:report.audioAfter});

  report.localDependencies=await page.locator('[href],[src]').evaluateAll(elements=>elements.flatMap(element=>['href','src'].filter(key=>element.hasAttribute(key)).map(key=>element.getAttribute(key))).filter(value=>/^file:|^[A-Za-z]:[\\/]/i.test(value)));
  assert(report.localDependencies.length===0,'Live DOM contains machine-local file paths');
  await page.setViewportSize({width:1440,height:1000});
  await navigate(base+'index.html?view=revision');
  await page.getByRole('heading',{name:'按场次阅读与练习'}).waitFor({state:'visible'});
  assert(await page.locator('.exam-card').count()===32,'Desktop revision cards are incomplete');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Desktop page overflows horizontally');
  await screenshot('remote-desktop-revision.png');step('Desktop layout and absence of local dependencies');
  assert(report.errors.length===0,'JavaScript errors: '+report.errors.join('; '));
  assert(report.failed.length===0,'HTTP resource failures: '+JSON.stringify(report.failed));
  report.status='passed';save();console.log(JSON.stringify(report,null,2));
  await ctx.close();await browser.close();
})().catch(async error=>{
  report.status='failed';report.failure={message:error.message,stack:error.stack?.slice(0,6000),url:page?.url()||null};
  if(page){
    await screenshot('remote-failure.png').catch(()=>{});
    report.failure.bodyExcerpt=(await page.locator('body').textContent({timeout:5000}).catch(()=>''))?.slice(0,1200);
  }
  save();console.error(error);console.error('Saved diagnostic report in '+out);
  if(browser)await browser.close().catch(()=>{});process.exitCode=1;
});
