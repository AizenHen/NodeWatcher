import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import {isIP} from 'node:net';
import path from 'node:path';
import {validateHost,remoteSettings} from './model.js';
import {tcpProbe} from './network.js';

const run=promisify(execFile);
const windowsRoot=process.env.SystemRoot || 'C:\\Windows';
const powershell=path.join(windowsRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const quotePS=value=>`'${String(value).replaceAll("'","''")}'`;
const encoded=script=>['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};

export function connectionTarget(device,input={}) {
  if(device.demo)fail('Demo devices are fictional. Add a real device to use SSH or RDP.');
  if(!['windows','linux'].includes(device.os))fail('Remote access is available for Windows and Linux devices.');
  const host=validateHost(device.host);
  if(input.host!==host)fail('The device address changed. Close this panel and open it again.',409);
  const settings=remoteSettings(device.os,{
    remotePort:input.remotePort ?? device.remotePort,
    sshUser:input.sshUser ?? device.sshUser
  });
  return {host,port:settings.remotePort,username:settings.sshUser,protocol:device.os==='linux'?'SSH':'RDP'};
}

export async function pingProbe(host) {
  validateHost(host);
  if(process.platform==='win32') {
    // .NET reports ICMP status explicitly; ping.exe can exit 0 for an unreachable reply.
    const script=`$ErrorActionPreference='Stop'; $p=New-Object System.Net.NetworkInformation.Ping; try { $r=$p.Send(${quotePS(host)},1500); @{reachable=($r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success); message=$r.Status.ToString(); latencyMs=$r.RoundtripTime} | ConvertTo-Json -Compress } finally { $p.Dispose() }`;
    try {
      const {stdout}=await run(powershell,encoded(script),{timeout:5000,windowsHide:true,maxBuffer:16384});
      return JSON.parse(stdout.trim());
    } catch { return {reachable:false,message:'No ICMP reply, or ping is unavailable.',latencyMs:null}; }
  }
  const command=process.platform==='darwin'&&isIP(host)===6?'ping6':'ping';
  try {
    const start=performance.now();
    await run(command,['-n','-c','1',host],{timeout:3000,maxBuffer:16384});
    return {reachable:true,message:'Echo reply received.',latencyMs:Math.round(performance.now()-start)};
  } catch(e) {return {reachable:false,message:e.code==='ENOENT'?'Ping is not installed.':'No ICMP reply; the host or firewall may block ping.',latencyMs:null};}
}

export function sshArguments(target) {
  return ['-p',String(target.port),...(target.username?['-l',target.username]:[]),'--',target.host];
}
export function connectionArtifacts(target) {
  const endpoint=`${isIP(target.host)===6?`[${target.host}]`:target.host}:${target.port}`;
  return target.protocol==='SSH'
    ? {command:['ssh',...sshArguments(target)].join(' ')}
    : {rdpFile:`full address:s:${endpoint}\r\nprompt for credentials:i:1\r\nauthentication level:i:1\r\nenablecredsspsupport:i:1\r\nredirectclipboard:i:0\r\ndrivestoredirect:s:\r\n`};
}

export async function nativeClient(protocol) {
  if(process.platform!=='win32')return {available:false,message:'Native launch is supported when NodeWatcher runs on Windows. Use the command or connection file below.'};
  const executable=path.join(windowsRoot,'System32',...(protocol==='SSH'?['OpenSSH','ssh.exe']:['mstsc.exe']));
  try {
    await Promise.all([access(executable),access(powershell)]);
    return {available:true,executable};
  } catch {
    return {available:false,message:protocol==='SSH'?'Windows OpenSSH Client is not installed. Use another SSH client or install the Windows OpenSSH Client optional feature.':'Remote Desktop Connection is unavailable on this machine. Download the connection file for another RDP client.'};
  }
}

export function launchScript(target,executable) {
  const endpoint=`${isIP(target.host)===6?`[${target.host}]`:target.host}:${target.port}`;
  const args=target.protocol==='SSH'?sshArguments(target):[`/v:${endpoint}`,'/prompt'];
  // Only validated host/user/port values become arguments; no remote command or shell is accepted.
  // A visible window is intentional here: the user explicitly requests an interactive session.
  return `$ErrorActionPreference='Stop'; Start-Process -FilePath ${quotePS(executable)} -ArgumentList @(${args.map(quotePS).join(',')}) -WindowStyle Normal`;
}

export async function launchNative(target) {
  const client=await nativeClient(target.protocol);
  if(!client.available)fail(client.message,409);
  try {
    await run(powershell,encoded(launchScript(target,client.executable)),{timeout:10000,windowsHide:true,maxBuffer:16384});
  } catch { fail(`Unable to open the ${target.protocol} client. Use the command or connection file instead.`,503); }
}

export async function inspectConnection(target,dependencies={}) {
  const [ping,service,client]=await Promise.all([
    (dependencies.ping || pingProbe)(target.host),
    (dependencies.tcp || tcpProbe)(target.host,target.port),
    (dependencies.client || nativeClient)(target.protocol)
  ]);
  return {target,ping,service,canConnect:service.reachable,nativeAvailable:client.available,nativeMessage:client.message||'',...connectionArtifacts(target)};
}

export async function openConnection(target,dependencies={}) {
  // Recheck at launch time. A stale UI result or imported health record cannot authorize a launch.
  const service=await (dependencies.tcp || tcpProbe)(target.host,target.port);
  if(!service.reachable)fail(`${target.protocol} port ${target.port} is unreachable: ${service.message}. Check the service, firewall, and address.`,409);
  await (dependencies.launch || launchNative)(target);
  return {opened:true,protocol:target.protocol,message:`${target.protocol} client opened. Complete sign-in in the new window.`};
}
