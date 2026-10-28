import ssh2 from 'ssh2';
const {Client}=ssh2;
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {validateHost} from './model.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const services={linux:['nginx','apache2','cron'],windows:['Spooler','W32Time']};
export function targetFor(device,input){
 if(!device||device.demo||!services[device.os])fail('Choose a real Windows or Linux device.');
 if(input.host!==device.host)fail('Device changed. Reopen the investigation.',409);
 const host=validateHost(device.host);
 if(typeof input.username!=='string'||!input.username.trim()||input.username.length>120)fail('Enter a username.');
 if(typeof input.password!=='string'||!input.password||input.password.length>1024)fail('Enter a password for this request.');
 const port=input.port??(device.os==='linux'?22:5986);
 if(!Number.isInteger(port)||port<1||port>65535)fail('Invalid management port.');
 if(device.os==='linux'&&!/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.fingerprint||''))fail('Enter the server SSH SHA256 fingerprint, verified through your administrator or console.');
 return {host,os:device.os,port,username:input.username.trim(),password:input.password,fingerprint:input.fingerprint};
}
const linuxDiagnostic=`python3 - <<'NODEWATCHER'
import os,json,subprocess,time
m=dict((l.split(':')[0],int(l.split()[1])) for l in open('/proc/meminfo'))
a=list(map(int,open('/proc/stat').readline().split()[1:9]));time.sleep(1);b=list(map(int,open('/proc/stat').readline().split()[1:9]));d=sum(b)-sum(a);cpu=100*(1-((b[3]+b[4])-(a[3]+a[4]))/d) if d else 0
sv={}
for name in ['nginx','apache2','cron']:
 p=subprocess.run(['systemctl','is-active',name],capture_output=True,text=True,timeout=5);sv[name]=p.stdout.strip() or 'unknown'
p=subprocess.run(['ps','-eo','pid,comm,pcpu,pmem','--sort=-pcpu'],capture_output=True,text=True,timeout=5)
print(json.dumps(dict(cpu=round(cpu,1),memory=round(100*(1-m['MemAvailable']/m['MemTotal']),1),processes='\\n'.join(p.stdout.splitlines()[:11]),services=sv)))
NODEWATCHER`;
const windowsDiagnostic=`$os=Get-CimInstance Win32_OperatingSystem; $cpu=(Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average; if($null -eq $cpu){throw 'CPU data unavailable'}; $sv=@{}; foreach($n in @('Spooler','W32Time')){$s=Get-Service $n -ErrorAction SilentlyContinue;$sv[$n]=if($s){[string]$s.Status}else{'unknown'}}; @{cpu=[double]$cpu;memory=[math]::Round(100*(1-$os.FreePhysicalMemory/$os.TotalVisibleMemorySize),1);processes=(Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 10 Id,ProcessName,@{n='RAM_MB';e={[math]::Round($_.WorkingSet64/1MB)}}|Out-String);services=$sv}|ConvertTo-Json -Compress`;
export function commandFor(os,service){
 if(service&&!services[os]?.includes(service))fail('This service has no approved repair recipe.');
 if(os==='linux')return service?`sudo -n systemctl restart ${service}`:linuxDiagnostic;
 if(os==='windows')return service?`Restart-Service -Name '${service}' -ErrorAction Stop`:windowsDiagnostic;
 fail('Unsupported platform.');
}
export function remoteRun(target,service){
 const command=commandFor(target.os,service);
 return new Promise((resolve,reject)=>{
 let done=false,out='';let close=()=>{};
 const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);close();error?reject(Object.assign(new Error(error),{status:502})):resolve(out);};
 const timer=setTimeout(()=>finish(service?'Repair timed out; its outcome is unknown. Investigate again before retrying.':'Investigation timed out.'),45000);
 const append=chunk=>{out+=chunk.toString();if(out.length>65536)finish('Remote output exceeded the limit.');};
 if(target.os==='linux'){
  const client=new Client();close=()=>client.destroy();
  client.on('error',()=>finish('SSH failed. Check credentials, the verified fingerprint, permissions, and reachability.'));
  client.on('ready',()=>client.exec(command,(err,stream)=>{if(err)return finish('SSH command could not start.');stream.on('data',append);stream.stderr.on('data',()=>{});stream.on('close',code=>finish(code===0?null:service?'Repair failed or could not be verified. The account needs permission for this recipe (sudo -n).':'Diagnostics failed. Linux requires python3, procfs, ps, and systemctl.'));}));
  client.connect({host:target.host,port:target.port,username:target.username,password:target.password,readyTimeout:15000,hostVerifier:key=>`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}`===target.fingerprint});
 }else{
  if(process.platform!=='win32')return finish('Windows management requires NodeWatcher running on Windows.');
  const script=`$ErrorActionPreference='Stop';try{$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$secure=ConvertTo-SecureString $v.password -AsPlainText -Force;$cred=[pscredential]::new($v.username,$secure);Invoke-Command -ComputerName $v.host -Port $v.port -UseSSL -Authentication Negotiate -Credential $cred -ScriptBlock { $ErrorActionPreference='Stop'; ${command} } -SessionOption (New-PSSessionOption -OpenTimeout 15000 -OperationTimeout 30000)}catch{exit 1}`;
  const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  close=()=>child.kill();child.stdout.on('data',append);child.stderr.on('data',()=>{});child.on('error',()=>finish('PowerShell could not start.'));child.on('close',code=>finish(code===0?null:service?'Repair failed or its outcome is unknown. Investigate again.':'WinRM HTTPS failed. Check trusted certificate, credentials, permissions, and port.'));
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(target));
 }
 });
}
export function parseDiagnostic(text){
 let d;try{d=JSON.parse(text.trim());}catch{fail('The remote diagnostic returned invalid data.',502);}
 if(!Number.isFinite(d.cpu)||!Number.isFinite(d.memory)||d.cpu<0||d.cpu>100||d.memory<0||d.memory>100||!d.services||typeof d.services!=='object')fail('The remote diagnostic returned invalid metrics.',502);
 return {cpu:d.cpu,memory:d.memory,processes:String(d.processes||'').slice(0,12000),services:d.services};
}
export function createRepairManager(run=remoteRun){
 const plans=new Map();
 return {
 async investigate(device,input){
  const target=targetFor(device,input),diagnostic=parseDiagnostic(await run(target));
  for(const [id,p] of plans)if(p.expires<Date.now()||p.deviceId===device.id)plans.delete(id);
  const offers=[];
  for(const service of services[device.os])if(['failed','inactive','Stopped'].includes(diagnostic.services[service])){
   const token=randomUUID();const plan={deviceId:device.id,identity:JSON.stringify(device),host:target.host,port:target.port,username:target.username,fingerprint:target.fingerprint,service,expires:Date.now()+300000};
   if(plans.size>=1000)plans.delete(plans.keys().next().value);plans.set(token,plan);
   offers.push({token,service,command:commandFor(device.os,service),impact:`Restarting ${service} may interrupt its users and jobs. A stopped service may be intentional.`,expiresAt:new Date(plan.expires).toISOString()});
  }
  return {diagnostic,offers,checkedAt:new Date().toISOString()};
 },
 async repair(device,input){
  const target=targetFor(device,input),p=plans.get(input.token);
  if(!p||p.expires<Date.now()||p.identity!==JSON.stringify(device)||p.deviceId!==device.id||p.port!==target.port||p.username!==target.username||p.fingerprint!==target.fingerprint||input.approve!==true)fail('Repair approval is missing, expired, or the device/connection changed. Investigate again.',409);
  plans.delete(input.token);
  const before=parseDiagnostic(await run(target));
  if(!['failed','inactive','Stopped'].includes(before.services[p.service]))fail('Service state changed. Investigate again before approving a repair.',409);
  await run(target,p.service);
  const after=parseDiagnostic(await run(target));
  return {service:p.service,verified:['active','Running'].includes(after.services[p.service]),diagnostic:after,checkedAt:new Date().toISOString()};
 }
 };
}
