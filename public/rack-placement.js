function rackPositionProblem(rack, startU, units, excludeId = null) {
  if(!rack)return 'Choose a rack first.';
  if(!Number.isInteger(units)||units<1||units>60)return 'Enter a device height from 1 to 60 U.';
  if(!Number.isInteger(startU)||startU<1||startU+units-1>rack.units)return `Does not fit inside this ${rack.units}U rack.`;
  const overlaps=state.servers.filter(s=>s.id!==excludeId&&s.rackId===rack.id&&startU<s.startU+s.units&&startU+units>s.startU);
  return overlaps.length?`Occupied by ${overlaps.map(s=>s.name).join(', ')}.`:'';
}

function rackUnitRange(startU, units) {
  return units===1?`U${startU}`:`U${startU}–U${startU+units-1}`;
}

function rackUnitOptions(rack, units, selectedU, excludeId = null) {
  if(!rack)return '<option value="1">Unassigned</option>';
  return Array.from({length:rack.units},(_,index)=>rack.units-index).map(u=>{
    const problem=rackPositionProblem(rack,u,units,excludeId);
    return `<option value="${u}" ${u===selectedU?'selected':''} ${problem?'disabled':''}>${rackUnitRange(u,units)} · ${e(problem||'Available')}</option>`;
  }).join('');
}

function rackPositionField(device) {
  return `<label class="field" id="rack-position-field">Starting U (lowest occupied unit)<select name="startU" data-initial-u="${device.startU}" aria-label="Starting U (lowest occupied unit)" aria-describedby="rack-position-help" required></select><small id="rack-position-help" aria-live="polite"></small></label>`;
}

function syncRackPositionEditor(initial=false) {
  const form=document.getElementById('editor-form');
  if(!form.elements.rackId||!form.elements.startU)return;
  const rack=state.racks.find(r=>r.id===form.elements.rackId.value);
  const units=Number(form.elements.units.value),select=form.elements.startU;
  let selectedU=Number(initial?select.dataset.initialU:select.value);
  if(!rack)selectedU=1;
  // For a newly added device only, choose a free default rather than an occupied U1.
  if(initial&&!editorDevice&&rack&&rackPositionProblem(rack,selectedU,units)) {
    const firstFree=Array.from({length:rack.units},(_,i)=>i+1).find(u=>!rackPositionProblem(rack,u,units));
    if(firstFree)selectedU=firstFree;
  }
  if(rack&&(selectedU<1||selectedU>rack.units))selectedU=0;
  select.innerHTML=(selectedU===0?'<option value="" selected disabled>Choose an available U</option>':'')+rackUnitOptions(rack,units,selectedU,editorDevice?.id);
  document.getElementById('rack-position-field').hidden=!rack;
  const problem=rack?(selectedU?rackPositionProblem(rack,selectedU,units,editorDevice?.id):'Choose an available starting U.'):'';
  select.setCustomValidity(problem);
  const help=document.getElementById('rack-position-help');
  help.textContent=problem||(rack?`Occupies ${rackUnitRange(selectedU,units)} in ${rack.name}. Blocked positions cannot be selected.`:'');
  help.classList.toggle('danger-text',!!problem);
}

function rackSlots(rack, devices) {
  let slots='';
  for(let u=rack.units;u>=1;u--) {
    const row=rack.units-u+1;
    const occupied=devices.some(s=>u>=s.startU&&u<s.startU+s.units);
    slots+=`<div class="rack-unit-label" style="grid-column:1;grid-row:${row}">${String(u).padStart(2,'0')}</div>`;
    slots+=occupied?`<div class="rack-empty" style="grid-column:2;grid-row:${row}"></div>`:
      `<button type="button" class="rack-empty rack-slot-button" style="grid-column:2;grid-row:${row}" data-action="place-at-u" data-rack="${e(rack.id)}" data-u="${u}" aria-label="Place a device at U${u} in ${e(rack.name)}" title="Place a device at U${u}"><span>+ Place at U${u}</span></button>`;
  }
  return slots;
}

(() => {
  const get=id=>document.getElementById(id);
  let rackId='',selectedU=1;
  function refreshPlacement(rebuildUnits=true) {
    const rack=state.racks.find(r=>r.id===rackId);
    const device=state.servers.find(s=>s.id===get('placement-device').value);
    const height=Number(get('placement-height').value);
    get('placement-height').max=rack?.units||60;
    if(rebuildUnits)get('placement-unit').innerHTML=rackUnitOptions(rack,height,selectedU,device?.id);
    get('placement-error').textContent='';
    get('placement-title').textContent=`Place a device at U${selectedU}`;
    get('placement-location').textContent=rack?`${rack.name} · ${rack.location}`:'Rack no longer exists';
    get('placement-add').disabled=!!rackPositionProblem(rack,selectedU,height);
    const problem=rackPositionProblem(rack,selectedU,height,device?.id);
    const alreadyHere=device?.rackId===rackId&&device?.startU===selectedU&&device?.units===height;
    get('placement-save').disabled=!device||!!problem||alreadyHere;
    get('placement-save').textContent=device?.rackId?'Save placement & height':'Place device';
    get('placement-unit').setCustomValidity(problem);
    if(!device){get('placement-preview').innerHTML=`Choose a device or add a new one. Requested space: <strong>${e(rackUnitRange(selectedU,height))}</strong> (${height}U). ${e(problem)}`;return;}
    const oldRack=state.racks.find(r=>r.id===device.rackId);
    const origin=oldRack?`${oldRack.name} / ${rackUnitRange(device.startU,device.units)}`:'Unassigned';
    get('placement-preview').innerHTML=`<div class="placement-device-name">${e(device.name)} <span>${height}U${device.demo?' · Demo':''}</span></div><div class="placement-path"><span>${e(origin)}</span><span aria-hidden="true">→</span><strong>${e(rack?.name||'')} / ${rackUnitRange(selectedU,height)}</strong></div><p class="${problem?'danger-text':''}">${e(problem||(alreadyHere?'This device is already at this position.':'This position is available.'))}</p>`;
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action="place-at-u"]');
    if(!button)return;
    rackId=button.dataset.rack;selectedU=Number(button.dataset.u);get('placement-height').value='1';
    const devices=state.servers.filter(s=>!['laptop','desktop'].includes(deviceKind(s))).sort((a,b)=>Number(a.demo)-Number(b.demo)||a.name.localeCompare(b.name));
    get('placement-device').innerHTML='<option value="" selected disabled>Choose a device…</option>'+devices.map(s=>{
      const rack=state.racks.find(r=>r.id===s.rackId);
      return `<option value="${e(s.id)}">${e(s.name)} · ${s.units}U · ${rack?`${e(rack.name)} / U${s.startU}`:'Unassigned'}${s.demo?' · Demo':''}</option>`;
    }).join('');
    refreshPlacement();
    get('placement-dialog').showModal();
  });
  document.addEventListener('change',event=>{
    if(event.target.matches('#editor-form [name="rackId"], #editor-form [name="startU"], #editor-form [name="units"]'))syncRackPositionEditor();
  });
  document.addEventListener('input',event=>{
    if(event.target.matches('#editor-form [name="units"]'))syncRackPositionEditor();
  });
  get('placement-device').addEventListener('change',()=>{get('placement-height').value=state.servers.find(s=>s.id===get('placement-device').value)?.units||1;refreshPlacement();});
  get('placement-height').addEventListener('input',()=>refreshPlacement());
  get('placement-unit').addEventListener('change',()=>{selectedU=Number(get('placement-unit').value);refreshPlacement(false);});
  get('placement-cancel').addEventListener('click',()=>get('placement-dialog').close());
  get('placement-add').addEventListener('click',()=>{
    get('placement-dialog').close();showEditor('device',undefined,{rackId,startU:selectedU,units:Number(get('placement-height').value)});
  });
  get('placement-form').addEventListener('submit',async event=>{
    event.preventDefault();
    if(get('placement-save').disabled)return;
    const device=state.servers.find(s=>s.id===get('placement-device').value);
    if(!device)return;
    const target={rackId,startU:selectedU,units:Number(get('placement-height').value)};
    const controls=['placement-save','placement-device','placement-unit','placement-height','placement-add'];
    controls.forEach(id=>get(id).disabled=true);
    try {
      await api(`/api/servers/${encodeURIComponent(device.id)}/placement`,'PATCH',target);
      await load();
      get('placement-dialog').close();
      toast(`${device.name} placed at ${rackUnitRange(target.startU,target.units)}.`);
    } catch(error) {
      // A second browser may have occupied the slot since this dialog was opened.
      try{state=await api('/api/state');}catch{}
      refreshPlacement();
      get('placement-error').textContent=error.message;
    } finally {
      get('placement-device').disabled=false;get('placement-unit').disabled=false;get('placement-height').disabled=false;
      if(get('placement-dialog').open){const message=get('placement-error').textContent;refreshPlacement();get('placement-error').textContent=message;}
    }
  });
})();
