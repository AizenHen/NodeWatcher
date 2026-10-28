import {createRepairManager,services} from './lib/repairs.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { validateRack, validateServer, validateResults, overall, escapeHtml } from './lib/model.js';
import { networkChecks } from './lib/network.js';
import { connectionTarget, inspectConnection, openConnection, launchNative } from './lib/connections.js';
import {monitoringState,configureMonitoring,updateAlerts,monitoringSummary,alertAction,runWorkerPool} from './lib/monitoring.js';
import {appendChange,deviceChange,rackChange,differences} from './lib/changes.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4310);
const store = createStore(process.env.INFRACHECK_DB || path.join(root,'data','infracheck.db'));
const activeScans = new Set();
const repairs = createRepairManager();
let monitoringTimer=null,monitoringRun=null;
{
  const state=store.read();
  state.monitoring=monitoringState(state.monitoring);
  state.alerts=Array.isArray(state.alerts)?state.alerts:[];
  state.changeHistory=Array.isArray(state.changeHistory)?state.changeHistory:[];
  store.write(state);
}
function error(message,status=400) { throw Object.assign(new Error(message),{status}); }
async function body(req) {
  let chunks=[],size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>2*1024*1024) error('Request exceeds 2 MB.',413);chunks.push(chunk);}
  try {const b=JSON.parse(Buffer.concat(chunks).toString());if(!b||typeof b!=='object'||Array.isArray(b)) error('Expected a JSON object.');return b;} catch(e) {if(e.status)throw e;error('Invalid JSON.');}
}
function send(res,code,data,type='application/json') {
  res.writeHead(code,{'Content-Type':`${type}; charset=utf-8`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  res.end(type==='application/json'?JSON.stringify(data):data);
}
function nextMonitoringAt(settings,from=Date.now()){return settings.enabled?new Date(from+settings.intervalMinutes*60000).toISOString():null;}
function saveMonitoring(settings){const state=store.read();state.monitoring=monitoringState(settings);store.write(state);}
function scheduleMonitoring(delay){
  if(monitoringTimer)clearTimeout(monitoringTimer);
  const settings=monitoringState(store.read().monitoring);
  if(!settings.enabled){settings.nextRunAt=null;saveMonitoring(settings);return;}
  const wait=delay??Math.max(1000,Date.parse(settings.nextRunAt||'')-Date.now()||settings.intervalMinutes*60000);
  settings.nextRunAt=new Date(Date.now()+wait).toISOString();saveMonitoring(settings);
  monitoringTimer=setTimeout(async()=>{try{await runMonitoring({stagger:true});}catch(e){console.error('Scheduled monitoring failed:',e.message);}finally{scheduleMonitoring();}},wait);
  monitoringTimer.unref();
}
async function runMonitoring({stagger=false}={}){
  if(monitoringRun)return monitoringRun;
  monitoringRun=(async()=>{
    const startedAt=Date.now();let state=store.read();const devices=state.servers.filter(s=>!s.demo),records=[],failures=[];
    const settings=monitoringState(state.monitoring),staggerMs=stagger&&devices.length>1?Math.floor(settings.intervalMinutes*60000*.8/(devices.length-1)):0;
    state.monitoring={...monitoringState(state.monitoring),running:true};store.write(state);
    await runWorkerPool(devices,settings.concurrency,async device=>{
      if(activeScans.has(device.id)){failures.push({deviceId:device.id,reason:'busy'});return;}
      activeScans.add(device.id);
      try{
        const checks=await networkChecks(device),checkedAt=new Date().toISOString();
        state=store.read();const current=state.servers.find(s=>s.id===device.id);
        if(!current||JSON.stringify(current)!==JSON.stringify(device)){failures.push({deviceId:device.id,reason:'changed'});return;}
        const latest=state.results.filter(r=>r.serverId===device.id).sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt))[0];
        const record={serverId:device.id,checkedAt,source:'scheduled-network',checks:[...(latest?.checks||[]).filter(c=>c.category!=='network'),...checks],systemCheckedAt:latest?.systemCheckedAt||(latest?.source==='collector'?latest.checkedAt:null)};
        state.results.push(record);state.results=state.results.slice(-5000);state.alerts=updateAlerts(state.alerts,current,record);store.write(state);records.push(record);
      } catch(e){failures.push({deviceId:device.id,reason:'check failed'});console.error(`Monitoring ${device.id} failed:`,e.message);}
      finally {activeScans.delete(device.id);}
    },{staggerMs});
    state=store.read();const finished=new Date().toISOString(),durationMs=Date.now()-startedAt;
    const nextAt=state.monitoring.enabled?new Date(Math.max(Date.now()+1000,startedAt+state.monitoring.intervalMinutes*60000)).toISOString():null;
    state.monitoring={...monitoringState(state.monitoring),running:false,lastRunAt:finished,nextRunAt:nextAt,lastSummary:monitoringSummary(records,{skipped:failures.length,durationMs,workers:settings.concurrency,staggered:stagger})};store.write(state);return state.monitoring;
  })().finally(()=>{monitoringRun=null;});
  return monitoringRun;
}
function report(state) {
  const e=escapeHtml;
  const rows=state.servers.map(s=>{const r=state.results.filter(r=>r.serverId===s.id).sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt))[0];return `<section><h2>${e(s.name)} <small>${e(s.host)} · ${s.demo?'DEMO':'LIVE'}</small></h2><p>Last collection: ${e(r?.checkedAt||'Never')} · Overall at collection: ${e(overall(r?.checks||[]))}</p><p>OS / AD collection: ${e(r?.systemCheckedAt || (r?.source === 'collector' || r?.source === 'demo' ? r.checkedAt : 'Not collected'))}</p><table><thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead><tbody>${(r?.checks||[]).map(c=>`<tr><td>${e(c.name)}</td><td class="${c.status}">${e(c.status)}</td><td>${e(c.message)}</td></tr>`).join('')||'<tr><td colspan="3">No results collected</td></tr>'}</tbody></table></section>`}).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NodeWatcher health report</title><style>body{font:14px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#182b36}h1{color:#087f68}small{font-size:13px;color:#617681}section{break-inside:avoid;margin:32px 0}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:10px;border-bottom:1px solid #dde5e9}.critical{color:#c33045}.warning{color:#a16a00}.healthy{color:#087f68}.unknown{color:#617681}@media print{body{margin:0}}</style><h1>NodeWatcher / Infrastructure health report</h1><p>Generated ${e(new Date().toISOString())}. Demo records are fictional. Results describe collection time and may be stale. Network checks do not collect operating system or AD health.</p>${rows}<h2>Rack inventory</h2>${state.racks.map(r=>`<h3>${e(r.name)} · ${e(r.location)} · ${r.units}U</h3><table><tr><th>Device</th><th>Position</th><th>Allocated power</th></tr>${state.servers.filter(s=>s.rackId===r.id).sort((a,b)=>b.startU-a.startU).map(s=>`<tr><td>${e(s.name)}</td><td>U${s.startU}–U${s.startU+s.units-1}</td><td>${s.watts} W</td></tr>`).join('')}</table>`).join('')}</html>`;
}
const server=http.createServer(async(req,res)=>{
  try {
    const expectedHost=`127.0.0.1:${server.address().port}`;
    if (![expectedHost,`localhost:${server.address().port}`].includes(req.headers.host)) return send(res,403,{error:'Invalid Host header. Use the local dashboard URL.'});
    if(req.headers.origin && ![`http://${expectedHost}`,`http://localhost:${server.address().port}`].includes(req.headers.origin)) return send(res,403,{error:'Cross-origin requests are not allowed.'});
    const url=new URL(req.url,`http://${expectedHost}`);
    const route=url.pathname;
    if(route==='/api/state'&&req.method==='GET') return send(res,200,store.read());
    if(route==='/api/monitoring'&&req.method==='PUT') {
      if(req.headers['x-nodewatcher-action']!=='monitoring')error('Use the monitoring controls.',403);
      const input=await body(req),state=store.read(),before=monitoringState(state.monitoring),settings=configureMonitoring(input,state.monitoring);
      settings.nextRunAt=nextMonitoringAt(settings);state.monitoring=settings;
      const changes=differences(before,settings,['enabled','intervalMinutes','concurrency']);if(changes.length)appendChange(state,{entityType:'monitoring',entityId:'schedule',action:'updated',summary:'Monitoring schedule changed',changes});
      store.write(state);scheduleMonitoring();return send(res,200,settings);
    }
    if(route==='/api/monitoring/run'&&req.method==='POST') {
      if(req.headers['x-nodewatcher-action']!=='monitoring')error('Use the monitoring controls.',403);
      return send(res,200,await runMonitoring());
    }
    const alertRoute=route.match(/^\/api\/alerts\/([a-zA-Z0-9-]+)$/);
    if(alertRoute&&req.method==='PATCH') {
      if(req.headers['x-nodewatcher-action']!=='monitoring')error('Use the monitoring controls.',403);
      const input=await body(req),state=store.read(),index=(state.alerts||[]).findIndex(a=>a.id===alertRoute[1]);
      state.alerts[index]=alertAction(index<0?null:state.alerts[index],input);store.write(state);return send(res,200,state.alerts[index]);
    }
    if(route==='/api/export'&&req.method==='GET') {res.setHeader('Content-Disposition','attachment; filename="nodewatcher-inventory.json"');return send(res,200,{version:1,...store.read()});}
    if(route==='/api/report'&&req.method==='GET') {res.setHeader('Content-Disposition','attachment; filename="nodewatcher-report.html"');return send(res,200,report(store.read()),'text/html');}
    if(route==='/api/servers'&&req.method==='POST') {
      const input=await body(req),state=store.read();
      if(state.servers.some(s=>s.id===input.id))error('Server ID already exists.');
      const s=validateServer({...input,demo:false},state.racks,state.servers);
      state.servers.push(s);deviceChange(state,null,s,'created');store.write(state);return send(res,201,s);
    }
    const repairRoute=route.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)\/(investigate|repair)$/);
    if(repairRoute&&req.method==='POST') {
      if(req.headers['x-nodewatcher-action']!=='repair'||!req.headers['content-type']?.startsWith('application/json'))error('Use the investigation panel.',403);
      const input=await body(req),device=store.read().servers.find(s=>s.id===repairRoute[1]);
      if(!device)error('Device not found.',404);
      if(activeScans.has(device.id)||activeScans.size>=4)error('An operation is already running. Try again shortly.',409);
      activeScans.add(device.id);
      const action=repairRoute[2];
      const audit=outcome=>{const state=store.read();state.repairHistory=[...(state.repairHistory||[]),{deviceId:device.id,action,outcome,at:new Date().toISOString()}].slice(-200);store.write(state);};
      try {
        const result=await repairs[action](device,input);
        const state=store.read(),current=state.servers.find(s=>s.id===device.id);
        if(JSON.stringify(current)!==JSON.stringify(device))error('Device changed during the operation. Investigate again.',409);
        const d=result.diagnostic,checkedAt=result.checkedAt;
        const prior=state.results.filter(r=>r.serverId===device.id).sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt))[0];
        const retained=(prior?.checks||[]).filter(c=>!['CPU utilization','CPU load','Memory utilization',...services[device.os].map(n=>'Managed service '+n)].includes(c.name)).map(c=>({...c,message:c.message.includes('[Previous sample:')?c.message:c.message+' [Previous sample: '+prior.checkedAt+']'}));
        state.results.push({serverId:device.id,checkedAt,source:'remote-diagnostic',checks:[...retained,...services[device.os].map(name=>({name:'Managed service '+name,status:['active','Running'].includes(d.services[name])?'healthy':d.services[name]==='failed'?'critical':['inactive','Stopped'].includes(d.services[name])?'warning':'unknown',category:'system',message:String(d.services[name]||'unknown')+'; stopped services may be intentional.'})),
          {name:'CPU utilization',status:d.cpu>=95?'critical':d.cpu>=80?'warning':'healthy',category:'system',message:d.cpu+'% CPU in diagnostic sample. Investigate sustained load before making changes.',metric:{value:d.cpu,unit:'%'}},
          {name:'Memory utilization',status:d.memory>=95?'critical':d.memory>=80?'warning':'healthy',category:'system',message:d.memory+'% RAM used. Review applications before making changes.',metric:{value:d.memory,unit:'%'}}
        ],systemCheckedAt:prior?.systemCheckedAt||(prior?.source==='collector'||prior?.source==='demo'?prior.checkedAt:null)});state.results=state.results.slice(-5000);const created=state.results.at(-1);state.alerts=updateAlerts(state.alerts,current,created);store.write(state);
        audit(action==='repair'?(result.verified?'service verified running':'service not verified running'):'diagnostics collected');
        return send(res,200,result);
      }catch(err){audit(action==='repair'?'failed or outcome unknown; investigate before retrying':'investigation failed');throw err;}
      finally {input.password='';activeScans.delete(device.id);}
    }
    const remote=route.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)\/(connection-check|connect)$/);
    if(remote&&req.method==='POST') {
      if(req.headers['x-infracheck-action']!=='remote-access'||!req.headers['content-type']?.startsWith('application/json'))error('Remote access requires a request from the NodeWatcher connection panel.',403);
      const input=await body(req),device=store.read().servers.find(s=>s.id===remote[1]);
      if(!device)error('Device not found.',404);
      const target=connectionTarget(device,input);
      if(activeScans.size>=4||activeScans.has(device.id))error('A check or connection is already running. Try again shortly.',409);
      activeScans.add(device.id);
      try {
        const verifyDevice=()=>{
          const current=store.read().servers.find(s=>s.id===device.id);
          if(!current||current.host!==device.host||current.os!==device.os||current.demo)error('Device changed while checking. Reopen the connection panel.',409);
        };
        if(remote[2]==='connection-check') {
          const result=await inspectConnection(target);verifyDevice();return send(res,200,result);
        }
        const result=await openConnection(target,{launch:async target=>{
          verifyDevice();
          await launchNative(target);
        }});
        return send(res,200,result);
      } finally {activeScans.delete(device.id);}
    }
    const placement=route.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)\/placement$/);
    if(placement&&req.method==='PATCH') {
      const input=await body(req),state=store.read();
      const device=state.servers.find(s=>s.id===placement[1]);
      if(!device)error('Device not found.',404);
      if(typeof input.rackId!=='string'||!input.rackId||!Number.isInteger(input.startU))error('Choose a rack and an integer starting U.');
      if(activeScans.has(device.id))error('Wait for the current operation before changing this device.',409);
      const updated=validateServer({...device,rackId:input.rackId,startU:input.startU,units:input.units??device.units},state.racks,state.servers,device.id);
      state.servers=state.servers.map(s=>s.id===device.id?updated:s);
      if(differences(device,updated).length)deviceChange(state,device,updated,'moved');
      store.write(state);
      return send(res,200,updated);
    }
    const match=route.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)(\/scan)?$/);
    if(match) {
      let state=store.read();const device=state.servers.find(s=>s.id===match[1]);if(!device)error('Device not found.',404);
      if(match[2]&&req.method==='POST') {
        if(device.demo)error('Demo devices use fictional addresses. Add a real device to run connectivity checks.');
        if(activeScans.size>=4||activeScans.has(device.id))error('A check is already running, or the scan limit has been reached. Try again shortly.',409);
        activeScans.add(device.id);
        try {
          const checks=await networkChecks(device);
          state=store.read();
          const current=state.servers.find(s=>s.id===device.id);
          if(!current||JSON.stringify(current)!==JSON.stringify(device))error('Device changed while checks ran. Run again.',409);
          const latest=state.results.filter(r=>r.serverId===device.id).sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt))[0];
          const record={serverId:device.id,checkedAt:new Date().toISOString(),source:'network',checks:[...(latest?.checks||[]).filter(c=>c.category!=='network'),...checks]};
          // Keep collector timestamps separate: a TCP check must not make older OS results look fresh.
          record.systemCheckedAt=latest?.systemCheckedAt || (latest?.source==='collector'?latest.checkedAt:null);
          state.results.push(record);state.results=state.results.slice(-5000);state.alerts=updateAlerts(state.alerts,current,record);store.write(state);return send(res,200,record);
        } finally {activeScans.delete(device.id);}
      }
      if(!match[2]&&['PUT','DELETE'].includes(req.method)&&activeScans.has(device.id))error('Wait for the current operation before changing this device.',409);
      if(!match[2]&&req.method==='PUT') {
        const input=await body(req);state=store.read();const existing=state.servers.find(s=>s.id===device.id);if(!existing)error('Device not found.',404);
        const updated=validateServer({...input,id:device.id,demo:existing.demo},state.racks,state.servers,device.id);
        state.servers=state.servers.map(s=>s.id===device.id?updated:s);
        if(existing.host!==updated.host||existing.os!==updated.os||JSON.stringify(existing.ports)!==JSON.stringify(updated.ports)) state.results=state.results.filter(r=>r.serverId!==device.id);
        if(differences(existing,updated).length)deviceChange(state,existing,updated);store.write(state);return send(res,200,updated);
      }
      if(!match[2]&&req.method==='DELETE') {state.servers=state.servers.filter(s=>s.id!==device.id);state.results=state.results.filter(r=>r.serverId!==device.id);deviceChange(state,device,null,'deleted');store.write(state);return send(res,200,{ok:true});}
    }
    if(route==='/api/racks'&&req.method==='POST') {
      const input=await body(req),state=store.read(),rack=validateRack(input);
      if(state.racks.some(r=>r.id===rack.id))error('Rack ID already exists.');state.racks.push(rack);rackChange(state,null,rack,'created');store.write(state);return send(res,201,rack);
    }
    if(route==='/api/import'&&req.method==='POST') {
      const input=await body(req);if(input.version!==1)error('Unsupported format. Expected version 1.');
      const state=store.read();
      if(input.racks!==undefined||input.servers!==undefined) {
        if(!Array.isArray(input.racks)||!Array.isArray(input.servers)||input.racks.length>100||input.servers.length>1000)error('Inventory must include racks (up to 100) and servers (up to 1,000).');
        const racks=input.racks.map(validateRack),servers=[];
        if(new Set(racks.map(r=>r.id)).size!==racks.length)error('Duplicate rack IDs.');
        for(const candidate of input.servers) {const validated=validateServer(candidate,racks,servers);if(servers.some(s=>s.id===validated.id))error('Duplicate server IDs.');servers.push(validated);}
        // Inventory import merges definitions; collisions must be edited explicitly.
        if(racks.some(r=>state.racks.some(x=>x.id===r.id))||servers.some(s=>state.servers.some(x=>x.id===s.id)))error('Inventory IDs already exist. Import only new racks and devices; edit existing devices in the dashboard.');
        state.racks.push(...racks);state.servers.push(...servers);for(const rack of racks)rackChange(state,null,rack,'created');for(const device of servers)deviceChange(state,null,device,'created');
      }
      if(input.results!==undefined) {const imported=validateResults(input.results,state.servers);state.results.push(...imported);for(const record of imported)state.alerts=updateAlerts(state.alerts,state.servers.find(s=>s.id===record.serverId),record);appendChange(state,{entityType:'import',entityId:'collector-results',action:'imported',summary:`${imported.length} collector result${imported.length===1?'':'s'} imported`,changes:[]});}
      if(input.results===undefined&&input.servers===undefined)error('No inventory or results found.');
      state.results=state.results.slice(-5000);store.write(state);return send(res,200,{ok:true});
    }
    if(route.startsWith('/api/'))return send(res,404,{error:'Endpoint not found.'});
    if(req.method!=='GET')return send(res,405,{error:'Method not allowed.'});
    const assets={'/':'index.html','/app.js':'app.js','/repairs.js':'repairs.js','/remote-access.js':'remote-access.js','/rack-placement.js':'rack-placement.js','/styles.css':'styles.css','/monitoring.css':'monitoring.css','/changes.css':'changes.css','/favicon.svg':'favicon.svg'};
    if(!assets[route])return send(res,404,'Not found','text/plain');
    const ext=path.extname(assets[route]);return send(res,200,await readFile(path.join(root,'public',assets[route])),{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[ext]);
  } catch(e) {if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'An internal error occurred. Check the server console.'});if(!e.status)console.error(e);}
});
server.listen(port,'127.0.0.1',()=>{console.log(`NodeWatcher ready at http://127.0.0.1:${server.address().port}`);scheduleMonitoring();});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(monitoringTimer)clearTimeout(monitoringTimer);server.close(()=>{store.close();process.exit(0);});});
