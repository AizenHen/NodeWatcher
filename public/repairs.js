(() => {
 const get=id=>document.getElementById(id);let device=null,busy=false,offers=[];
 function values(){return {host:device.host,port:Number(get('repair-port').value),username:get('repair-username').value,password:get('repair-password').value,fingerprint:get('repair-fingerprint').value.trim()};}
 function lock(value){busy=value;get('repair-investigate').disabled=value;get('repair-close').disabled=value;for(const el of get('repair-form').querySelectorAll('input,button[data-repair-token]'))el.disabled=value;}
 async function request(action,extra={}){
  const data={...values(),...extra};get('repair-password').value='';
  try{const res=await fetch(`/api/servers/${encodeURIComponent(device.id)}/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-NodeWatcher-Action':'repair'},body:JSON.stringify(data)});const result=await res.json();if(!res.ok)throw new Error(result.error||'Operation failed');return result;}finally{data.password='';}
 }
 function findings(result){
  const d=result.diagnostic;offers=result.offers||[];
  get('repair-findings').innerHTML=`<h3>Fresh diagnostic sample</h3><p>CPU: <strong>${e(d.cpu)}%</strong> · RAM: <strong>${e(d.memory)}%</strong><br>Collected ${e(new Date(result.checkedAt).toLocaleString())}</p><p>${d.cpu>=80||d.memory>=80?'High utilization detected. Inspect the processes below; there is no automatic CPU or RAM repair.':'CPU and memory are below the warning thresholds in this sample.'}</p><h3>Processes</h3><p>${device.os==='windows'?'Largest memory users (MB).':'Top CPU processes; ps CPU is a lifetime average.'}</p><pre class="repair-output">${e(d.processes)}</pre><h3>Service status</h3><ul>${Object.entries(d.services).map(([n,v])=>`<li>${e(n)}: ${e(v)}</li>`).join('')}</ul>${'verified' in result?`<p><strong>${result.verified?'Service verified running.':'Service is not verified running.'}</strong> CPU and RAM may still need attention.</p>`:''}<h3>Available repairs</h3>${offers.map(p=>`<section class="repair-offer"><strong>Restart ${e(p.service)}</strong><p>${e(p.impact)}</p><pre class="repair-output">${e(p.command)}</pre><p>Approval expires in 5 minutes. Re-enter your password, then approve.</p><button type="button" class="button secondary" data-repair-token="${e(p.token)}">Approve restart of ${e(p.service)}</button></section>`).join('')||'<p>No service restart offered. NodeWatcher does not terminate processes, reboot devices, or change AD settings.</p>'}`;
  if(d.cpu>=80||d.memory>=80)toast(`${device.name}: high ${d.cpu>=80?'CPU':'RAM'} usage detected.`,true);
 }
 document.addEventListener('click',async event=>{
  const open=event.target.closest('[data-action="investigate"]');
  if(open){device=state.servers.find(s=>s.id===open.dataset.id);if(!device||device.demo)return;get('repair-form').reset();offers=[];get('repair-findings').innerHTML='';get('repair-error').textContent='';get('repair-host').textContent=`${device.name} · ${device.host}`;get('repair-port').value=device.os==='linux'?(device.remotePort||22):5986;get('repair-username').value=device.sshUser||'';get('repair-fingerprint-field').hidden=device.os!=='linux';get('repair-fingerprint').required=device.os==='linux';get('repair-help').textContent=device.os==='linux'?'SSH with verified host identity. Diagnostics require Python 3 and systemd. Service repairs require preconfigured sudo permission without a prompt.':'PowerShell Remoting over HTTPS (not RDP). A trusted WinRM certificate and an account with remote-management permissions are required.';get('repair-dialog').showModal();return;}
  const button=event.target.closest('[data-repair-token]');if(!button||busy)return;
  const plan=offers.find(p=>p.token===button.dataset.repairToken);if(!plan||!get('repair-form').reportValidity())return;
  if(!confirm(`Approve restart of ${plan.service} on ${device.name} (${device.host})?\n\n${plan.impact}\n\n${plan.command}`))return;
  lock(true);get('repair-error').textContent='';try{const result=await request('repair',{token:plan.token,approve:true});findings(result);await load();}catch(err){offers=[];get('repair-findings').innerHTML='';get('repair-error').textContent=err.message+' Investigate again before retrying.';}finally{lock(false);}
 });
 get('repair-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;lock(true);offers=[];get('repair-findings').innerHTML='Investigating…';get('repair-error').textContent='';try{const result=await request('investigate');findings(result);await load();}catch(err){get('repair-findings').innerHTML='';get('repair-error').textContent=err.message;}finally{lock(false);}});
 get('repair-close').addEventListener('click',()=>get('repair-dialog').close());
 get('repair-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 get('repair-dialog').addEventListener('close',()=>{get('repair-form').reset();get('repair-findings').innerHTML='';offers=[];device=null;});
 for(const id of ['repair-port','repair-username','repair-fingerprint'])get(id).addEventListener('input',()=>{offers=[];get('repair-findings').innerHTML='Connection changed. Investigate again.';});
})();
