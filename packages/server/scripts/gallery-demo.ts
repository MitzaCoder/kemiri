/** Synthetic gallery proof. Uses only createSetup's disposable data and sources. */
import { join } from 'node:path';
import { createSetup, TestClient } from '../test/support.ts';
const origin = process.env.GALLERY_ORIGIN ?? 'http://localhost:5194';
const output = process.env.GALLERY_OUTPUT ?? '/tmp/t234/fixture.json';
const setup = await createSetup({ allowedOrigins: [origin], terminals: false });
const client = await TestClient.open(setup.server); await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw Error('Project not created');
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Gallery sample' });
const task = await client.request({ type: 'board.task.save', projectId, task: { title: 'Review the gallery', description: '', acceptance: null, status: 'todo', blockedBy: [], blockedReason: null, writeScopes: [] } });
if (task.type !== 'board.task.save') throw Error('Task not created');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:36px;background:var(--tone-bg,#f4f1ea);color:var(--tone-fg,#222);font:18px system-ui}h1{font-size:38px}section{padding:24px;background:var(--tone-surface,#fff);border-radius:16px}b{color:var(--tone-primary,#5544aa)}.bars{display:flex;gap:20px;align-items:end;height:130px}.bars i{background:#8177cc;width:23%;border-radius:12px 12px 0 0}</style></head><body><b>FIELD NOTES / 2026</b><h1>Garden observations</h1><section><h2>A season in bloom</h2><p>Four beds. Many small discoveries.</p><div class="bars"><i style="height:45%"></i><i style="height:80%"></i><i style="height:60%"></i><i style="height:100%"></i></div></section></body></html>`;
const pixels = Buffer.alloc(960 * 540 * 3);
for (let y = 0; y < 540; y++) for (let x = 0; x < 960; x++) {
 const sun = (x - 720) ** 2 + (y - 130) ** 2 < 65 ** 2;
 const hill = y > 430 - 220 * Math.sin(x / 250);
 pixels.set(sun ? [248,216,145] : hill ? [116,141,117] : [213,223,199], (y * 960 + x) * 3);
}
await Bun.write(join(setup.root,'image.ppm'),Buffer.concat([Buffer.from('P6\n960 540\n255\n'),pixels]));
for (const args of [ ['-i',join(setup.root,'image.ppm'),'-frames:v','1',join(setup.root,'garden.png')], ['-loop','1','-i',join(setup.root,'garden.png'),'-t','2','-c:v','libx264','-pix_fmt','yuv420p',join(setup.root,'walk.mp4')] ]) {
 const process = Bun.spawn(['ffmpeg','-y','-loglevel','error',...args]); if(await process.exited) throw Error('Fixture media failed');
}
await Bun.write(join(setup.root,'report.html'),html);
await Bun.write(join(setup.root,'notes.txt'),'Synthetic garden notes.\nWater the seedlings in the morning.');
const artifacts=[];
for(const [name,title] of [['report.html','Garden observations — a long page title with seasonal findings and next steps for every planting bed'],['garden.png','Afternoon in the garden — a long image title that should stay above the picture'],['walk.mp4','A short garden walk'],['notes.txt','Plain field notes']]) artifacts.push(await setup.server.artifacts.save({ projectId, sourcePath:join(setup.root,name!),title:title!,note:'Synthetic gallery sample.', threadId:'main',workerId:null,taskId:task.task.id }));
// Optional long-list fixture for checking the live preview budget while scrolling.
const extraPages = Math.min(30, Math.max(0, Number(process.env.GALLERY_EXTRA_PAGES ?? 0) || 0));
for (let i = 0; i < extraPages; i++) {
 const sourcePath = join(setup.root, `report-${i}.html`);
 await Bun.write(sourcePath, html);
 artifacts.push(await setup.server.artifacts.save({ projectId, sourcePath, title: `Garden page ${i + 2}`, note: null, threadId: 'main', workerId: null, taskId: task.task.id }));
}
await Bun.write(output,JSON.stringify({url:setup.server.url,origin,projectId,taskId:task.task.id,artifacts,pid:process.pid}));
console.log('Gallery fixture ready: '+output);
process.on('SIGTERM',async()=>{client.close();await setup.cleanup();process.exit(0)});
await new Promise(()=>{});
