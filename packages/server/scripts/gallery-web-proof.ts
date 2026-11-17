/** Headless proof against gallery-demo.ts. No installed backend or real data. */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connectChromiumPage } from '../../../apps/web/scripts/chromium-page.ts';
const fixture = await Bun.file(process.env.GALLERY_OUTPUT ?? '/tmp/t234/fixture.json').json();
const phase = process.env.GALLERY_PHASE ?? 'before';
const output = process.env.GALLERY_PROOF_OUTPUT ?? '/tmp/t234/web';
const page = await connectChromiumPage(process.env.GALLERY_CDP ?? 'http://localhost:9494');
await mkdir(output,{recursive:true}); await page.call('Page.enable'); await page.call('Runtime.enable');
await page.call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('aiki.backends.v1',${JSON.stringify(JSON.stringify([{id:'demo',name:'Gallery sample',url:fixture.url}]))});`});
async function waitFor(selector:string){const deadline=Date.now()+25000;while(Date.now()<deadline){if(await page.run(selector=>!!document.querySelector(selector),selector))return;await Bun.sleep(150);}throw Error('Missing '+selector);}
for(const form of ['desktop','phone']) for(const theme of ['light','dark']){
 await page.call('Emulation.setDeviceMetricsOverride',{width:form==='phone'?390:1440,height:form==='phone'?844:1000,deviceScaleFactor:1,mobile:form==='phone'});
 await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
 await page.call('Page.navigate',{url:fixture.origin+`/b/demo/projects/${fixture.projectId}?task=${fixture.taskId}`});
 await waitFor('[data-task-files]');
 await page.run(theme=>{document.documentElement.classList.toggle('dark',theme==='dark');document.querySelector('[data-task-files]')?.scrollIntoView({block:'start'});const body=document.querySelector<HTMLElement>('[data-task-body]');if(body)body.scrollTop-=100;},theme);
 await Bun.sleep(1800);
 const shot=await page.call<{data:string}>('Page.captureScreenshot',{format:'png'});await Bun.write(join(output,`${phase}-${form}-${theme}.png`),Buffer.from(shot.data,'base64'));
}
if(phase==='after'){
 const frames=join(output,'frames');await mkdir(frames,{recursive:true});let count=0;
 const capture=async(n=5)=>{for(let i=0;i<n;i++){const shot=await page.call<{data:string}>('Page.captureScreenshot',{format:'jpeg'});await Bun.write(join(frames,String(count++).padStart(4,'0')+'.jpg'),Buffer.from(shot.data,'base64'));await Bun.sleep(180);}};
 await capture();await page.run(()=>document.querySelector<HTMLButtonElement>('[data-artifact-list] button[data-artifact]')!.click());await waitFor('[data-html-artifact-dialog] iframe');await capture(20);
 const video=Bun.spawn(['ffmpeg','-y','-loglevel','error','-framerate','5','-i',join(frames,'%04d.jpg'),'-c:v','libx264','-pix_fmt','yuv420p',join(output,'open-page-phone-dark.mp4')]);if(await video.exited)throw Error('Video failed');await rm(frames,{recursive:true});
}
page.close();console.log('Gallery '+phase+' captured');
