import {overall} from './model.js';

export const DEFAULT_MONITORING = Object.freeze({enabled:false,intervalMinutes:15,concurrency:25,lastRunAt:null,nextRunAt:null,lastSummary:null,running:false});

export function monitoringState(value={}) {
  const interval=Number.isInteger(value.intervalMinutes)?value.intervalMinutes:15;
  const concurrency=Number.isInteger(value.concurrency)?value.concurrency:25;
  return {...DEFAULT_MONITORING,...value,enabled:value.enabled===true,intervalMinutes:Math.min(1440,Math.max(5,interval)),concurrency:Math.min(200,Math.max(1,concurrency)),running:false};
}

export function configureMonitoring(input,current={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('Expected monitoring settings.'),{status:400});
  if(typeof input.enabled!=='boolean')throw Object.assign(new Error('Enabled must be true or false.'),{status:400});
  if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<5||input.intervalMinutes>1440)throw Object.assign(new Error('Interval must be an integer from 5 to 1,440 minutes.'),{status:400});
  if(!Number.isInteger(input.concurrency)||input.concurrency<1||input.concurrency>200)throw Object.assign(new Error('Parallel workers must be an integer from 1 to 200.'),{status:400});
  return {...monitoringState(current),enabled:input.enabled,intervalMinutes:input.intervalMinutes,concurrency:input.concurrency};
}

export async function runWorkerPool(items,concurrency,worker,{staggerMs=0,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),clock=Date.now}={}) {
  let cursor=0;const started=clock();
  async function run(){while(cursor<items.length){const index=cursor++,wait=started+index*staggerMs-clock();if(wait>0)await delay(wait);await worker(items[index],index);}}
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},run));
}

const key=(deviceId,name)=>`${deviceId}\u0000${name}`;
export function updateAlerts(alerts=[],device,record,now=record.checkedAt) {
  const next=alerts.map(a=>({...a})),byKey=new Map(next.filter(a=>a.active).map(a=>[key(a.deviceId,a.checkName),a]));
  for(const check of record.checks) {
    const alertKey=key(device.id,check.name),existing=byKey.get(alertKey);
    if(['warning','critical'].includes(check.status)) {
      if(existing){existing.status=check.status;existing.message=check.message;existing.lastSeenAt=now;existing.occurrences=(existing.occurrences||1)+1;}
      else next.push({id:`alert-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,deviceId:device.id,deviceName:device.name,checkName:check.name,status:check.status,message:check.message,active:true,openedAt:now,lastSeenAt:now,occurrences:1,acknowledgedAt:null,silencedUntil:null,resolvedAt:null});
    } else if(existing&&check.status==='healthy') {existing.active=false;existing.resolvedAt=now;existing.lastSeenAt=now;existing.recoveryMessage=`${check.name} recovered on ${device.name}.`;}
  }
  return next.slice(-1000);
}

export function monitoringSummary(records,extra={}) {
  return {devicesChecked:records.length,healthy:records.filter(r=>overall(r.checks)==='healthy').length,warning:records.filter(r=>overall(r.checks)==='warning').length,critical:records.filter(r=>overall(r.checks)==='critical').length,unknown:records.filter(r=>overall(r.checks)==='unknown').length,...extra};
}

export function alertAction(alert,input,now=new Date().toISOString()) {
  if(!alert)throw Object.assign(new Error('Alert not found.'),{status:404});
  if(!input||typeof input!=='object')throw Object.assign(new Error('Expected an alert action.'),{status:400});
  if(input.action==='acknowledge')return {...alert,acknowledgedAt:now};
  if(input.action==='unacknowledge')return {...alert,acknowledgedAt:null};
  if(input.action==='unsilence')return {...alert,silencedUntil:null};
  if(input.action==='silence') {
    if(!Number.isInteger(input.minutes)||input.minutes<5||input.minutes>10080)throw Object.assign(new Error('Silence duration must be 5 minutes to 7 days.'),{status:400});
    return {...alert,silencedUntil:new Date(Date.parse(now)+input.minutes*60000).toISOString()};
  }
  throw Object.assign(new Error('Unknown alert action.'),{status:400});
}
