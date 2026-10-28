const DEVICE_FIELDS=['name','host','os','deviceType','assignedUser','location','role','model','rackId','startU','units','watts','ports','remotePort','sshUser'];
const RACK_FIELDS=['name','location','units','maxWatts'];

const display=value=>Array.isArray(value)?value.join(', '):value===''?'—':value??'—';
export function differences(before,after,fields=DEVICE_FIELDS) {
  return fields.flatMap(field=>JSON.stringify(before?.[field])===JSON.stringify(after?.[field])?[]:[{field,before:display(before?.[field]),after:display(after?.[field])}]);
}

export function appendChange(state,{entityType,entityId,action,summary,changes=[]},now=new Date().toISOString()) {
  const event={id:`change-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,at:now,actor:'Local administrator',entityType,entityId:String(entityId||''),action,summary:String(summary),changes:changes.slice(0,30).map(c=>({field:String(c.field),before:display(c.before),after:display(c.after)}))};
  state.changeHistory=[...(state.changeHistory||[]),event].slice(-5000);
  return event;
}

export function deviceChange(state,before,after,action='updated') {
  const changes=differences(before,after);
  const name=after?.name||before?.name||after?.id||before?.id;
  return appendChange(state,{entityType:'device',entityId:after?.id||before?.id,action,summary:action==='created'?`${name} added to inventory`:action==='deleted'?`${name} removed from inventory`:action==='moved'?`${name} rack placement changed`:`${name} configuration changed`,changes});
}

export function rackChange(state,before,after,action='updated') {
  const changes=differences(before,after,RACK_FIELDS),name=after?.name||before?.name||after?.id||before?.id;
  return appendChange(state,{entityType:'rack',entityId:after?.id||before?.id,action,summary:action==='created'?`${name} rack created`:`${name} rack changed`,changes});
}
