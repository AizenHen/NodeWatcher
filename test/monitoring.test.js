import test from 'node:test';
import assert from 'node:assert/strict';
import {alertAction,configureMonitoring,monitoringState,monitoringSummary,runWorkerPool,updateAlerts} from '../lib/monitoring.js';

test('monitoring settings are bounded and disabled by default',()=>{
  assert.deepEqual(monitoringState().enabled,false);
  assert.equal(configureMonitoring({enabled:true,intervalMinutes:10,concurrency:50}).concurrency,50);
  assert.throws(()=>configureMonitoring({enabled:true,intervalMinutes:1,concurrency:25}),/5 to 1,440/);
  assert.throws(()=>configureMonitoring({enabled:true,intervalMinutes:10,concurrency:201}),/1 to 200/);
});

test('worker pool enforces concurrency and processes every device',async()=>{
  let active=0,peak=0;const seen=[];
  await runWorkerPool([1,2,3,4,5],2,async value=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));seen.push(value);active--;});
  assert.equal(peak,2);
  assert.deepEqual(seen.sort(),[1,2,3,4,5]);
});

test('worker pool staggers launch targets',async()=>{
  const waits=[];let now=0;
  await runWorkerPool(['a','b','c'],1,async()=>{}, {staggerMs:10,clock:()=>now,delay:async ms=>{waits.push(ms);now+=ms;}});
  assert.deepEqual(waits,[10,10]);
});

test('alerts open, update, recover, acknowledge, and silence',()=>{
  const device={id:'web-1',name:'WEB-1'},at='2026-01-01T00:00:00.000Z';
  let alerts=updateAlerts([],device,{checkedAt:at,checks:[{name:'TCP 443',status:'critical',message:'timeout'}]});
  assert.equal(alerts[0].active,true);
  alerts=updateAlerts(alerts,device,{checkedAt:'2026-01-01T00:05:00.000Z',checks:[{name:'TCP 443',status:'warning',message:'slow'}]});
  assert.equal(alerts[0].occurrences,2);
  assert.ok(alertAction(alerts[0],{action:'acknowledge'},at).acknowledgedAt);
  assert.equal(alertAction(alerts[0],{action:'silence',minutes:60},at).silencedUntil,'2026-01-01T01:00:00.000Z');
  alerts=updateAlerts(alerts,device,{checkedAt:'2026-01-01T00:10:00.000Z',checks:[{name:'TCP 443',status:'healthy',message:'connected'}]});
  assert.equal(alerts[0].active,false);
  assert.ok(alerts[0].recoveryMessage.includes('recovered'));
});

test('monitoring summaries include all health states',()=>{
  const records=[['healthy'],['warning'],['critical'],['unknown']].map((statuses,i)=>({serverId:String(i),checks:statuses.map(status=>({status}))}));
  assert.deepEqual(monitoringSummary(records),{devicesChecked:4,healthy:1,warning:1,critical:1,unknown:1});
});
