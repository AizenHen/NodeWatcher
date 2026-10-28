function connectionButton(device) {
  if(!['linux','windows'].includes(device.os))return '<span class="muted">—</span>';
  const protocol=device.os==='linux'?'SSH':'RDP';
  return `<button type="button" class="connection-button ${device.os}" data-action="remote-access" data-id="${e(device.id)}" ${device.demo?'disabled':''} title="${device.demo?'Demo device — add a real device to connect':`Check reachability and open ${protocol}`}" aria-label="${protocol} to ${e(device.name)}${device.demo?' (demo device)':''}">${icon(device.os==='linux'?'terminal':'monitor')}${protocol}</button>`;
}

function syncRemoteEditor(resetDefaults=false) {
  const form=document.getElementById('editor-form');
  const os=form.elements.os?.value;
  const port=form.elements.remotePort,user=form.elements.sshUser;
  if(!port||!user)return;
  if(resetDefaults&&[22,3389].includes(Number(port.value)))port.value=os==='windows'?3389:22;
  if(resetDefaults&&['windows','linux'].includes(os)&&['22','3389'].includes(form.elements.ports?.value.trim()))form.elements.ports.value=os==='windows'?'3389':'22';
  port.disabled=!['windows','linux'].includes(os);
  port.closest('label').hidden=port.disabled;
  user.disabled=os!=='linux';
  user.closest('label').hidden=user.disabled;
}

(() => {
  const get=id=>document.getElementById(id);
  let device=null,checked=null,revision=0;
  const fields=()=>({host:device.host,remotePort:Number(get('remote-port').value),sshUser:device.os==='linux'?get('remote-user').value.trim():''});
  document.addEventListener('change',event=>{
    if(event.target.matches('#editor-form select[name="os"]'))syncRemoteEditor(true);
  });
  function invalidate() {
    revision++;
    checked=null;
    get('remote-launch').disabled=true;
    get('remote-fallback').hidden=true;
    get('remote-error').textContent='';
    get('remote-results').innerHTML='<p>Check this address and port before opening the client.</p>';
  }
  async function request(action,values) {
    const response=await fetch(`/api/servers/${encodeURIComponent(device.id)}/${action}`,{
      method:'POST',headers:{'Content-Type':'application/json','X-InfraCheck-Action':'remote-access'},body:JSON.stringify(values)
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Connection request failed.');
    return result;
  }
  async function check() {
    if(!get('remote-form').reportValidity())return;
    invalidate();
    const thisRevision=revision,values=fields();
    get('remote-check').disabled=true;
    get('remote-results').innerHTML='<p class="remote-checking">Testing ping and the remote-access port…</p>';
    try {
      const result=await request('connection-check',values);
      if(thisRevision!==revision||!get('remote-dialog').open)return;
      checked={...result,values};
      const line=(title,ok,message)=>`<div class="remote-check-row"><span class="dot ${ok?'healthy':'warning'}-bg"></span><div><strong>${e(title)}</strong><p>${e(message)}</p></div></div>`;
      get('remote-results').innerHTML=
        line('ICMP ping',result.ping.reachable,result.ping.reachable?`Reply received${result.ping.latencyMs!==null?` · ${result.ping.latencyMs} ms`:''}`:result.ping.message)+
        line(`${result.target.protocol} · TCP ${result.target.port}`,result.service.reachable,result.service.reachable?`Port is reachable · ${result.service.latencyMs} ms`:result.service.message)+
        (!result.ping.reachable&&result.canConnect?'<p class="remote-hint">Ping did not reply, but the service port is reachable. You can still connect.</p>':'')+
        (!result.canConnect?'<p class="remote-hint">The remote-access port did not respond. Check that the service is enabled and allowed through the firewall, then retry.</p>':'')+
        (!result.nativeAvailable?`<p class="remote-hint">${e(result.nativeMessage)}</p>`:'');
      get('remote-launch').disabled=!(result.canConnect&&result.nativeAvailable);
      get('remote-fallback').hidden=!result.canConnect;
      get('remote-command-field').hidden=result.target.protocol!=='SSH';
      get('remote-copy').hidden=result.target.protocol!=='SSH';
      get('remote-download').hidden=result.target.protocol!=='RDP';
      get('remote-command').value=result.command||'';
    } catch(error) {
      if(thisRevision===revision){get('remote-error').textContent=error.message;get('remote-results').textContent='Connection check could not complete.';}
    } finally { if(thisRevision===revision)get('remote-check').disabled=false; }
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action="remote-access"]');
    if(!button||button.disabled)return;
    const selected=state.servers.find(s=>s.id===button.dataset.id);
    if(!selected||selected.demo)return;
    device={...selected};
    const protocol=device.os==='linux'?'SSH':'RDP';
    get('remote-title').textContent=`${protocol} to ${device.name}`;
    get('remote-address').textContent=device.host;
    get('remote-icon').innerHTML=icon(device.os==='linux'?'terminal':'monitor');
    get('remote-port').value=device.remotePort||(device.os==='linux'?22:3389);
    get('remote-user').value=device.sshUser||'';
    get('remote-user-field').hidden=device.os!=='linux';
    get('remote-user').disabled=device.os!=='linux';
    get('remote-launch').textContent=`Open ${protocol}`;
    get('remote-check').disabled=false;
    if(get('editor').open)get('editor').close();
    get('remote-dialog').showModal();
    check();
  });
  get('remote-form').addEventListener('submit',event=>{event.preventDefault();check();});
  for(const id of ['remote-port','remote-user'])get(id).addEventListener('input',()=>{invalidate();get('remote-check').disabled=false;});
  get('remote-close').addEventListener('click',()=>get('remote-dialog').close());
  get('remote-dialog').addEventListener('close',()=>{revision++;checked=null;});
  get('remote-launch').addEventListener('click',async()=>{
    if(!checked?.canConnect||!checked.nativeAvailable)return;
    const values=checked.values,thisRevision=revision;
    get('remote-launch').disabled=true;
    get('remote-check').disabled=true;
    get('remote-port').disabled=true;
    get('remote-user').disabled=true;
    get('remote-error').textContent='';
    try {
      const result=await request('connect',values);
      if(thisRevision===revision){get('remote-dialog').close();toast(result.message);}
    } catch(error) {
      if(thisRevision===revision){get('remote-error').textContent=error.message;checked=null;get('remote-fallback').hidden=true;}
    } finally {
      get('remote-port').disabled=false;
      get('remote-user').disabled=device.os!=='linux';
      get('remote-check').disabled=false;
    }
  });
  get('remote-copy').addEventListener('click',async()=>{
    if(!checked?.command)return;
    try{await navigator.clipboard.writeText(checked.command);toast('SSH command copied.');}
    catch{get('remote-command').select();get('remote-error').textContent='Select and copy the SSH command above.';}
  });
  get('remote-download').addEventListener('click',()=>{
    if(!checked?.rdpFile)return;
    const url=URL.createObjectURL(new Blob([checked.rdpFile],{type:'application/x-rdp'}));
    const link=document.createElement('a');link.href=url;link.download=`${device.id}.rdp`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
})();
