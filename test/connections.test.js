import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionTarget,connectionArtifacts,inspectConnection,openConnection,launchScript} from '../lib/connections.js';
import {remoteSettings,validateHost} from '../lib/model.js';

const linux={id:'linux-real',host:'linux.example.test',os:'linux',demo:false};
const options={host:linux.host};

test('connection settings select SSH or RDP defaults and support custom ports and usernames',()=>{
  assert.deepEqual(connectionTarget(linux,options),{host:linux.host,protocol:'SSH',port:22,username:''});
  assert.equal(connectionTarget({...linux,os:'windows'},options).port,3389);
  assert.deepEqual(connectionTarget(linux,{...options,remotePort:2222,sshUser:'ops-admin'}),{host:linux.host,protocol:'SSH',port:2222,username:'ops-admin'});
  assert.equal(remoteSettings('linux',{remotePort:2222,sshUser:'ops'}).sshUser,'ops');
});

test('connection endpoints reject demos, unsupported devices, changed hosts, and command injection',()=>{
  assert.throws(()=>connectionTarget({...linux,demo:true},options),/Demo devices/);
  assert.throws(()=>connectionTarget({...linux,os:'storage'},options),/Windows and Linux/);
  assert.throws(()=>connectionTarget(linux,{host:'different.example.test'}),/changed/);
  for(const host of ['-oProxyCommand=bad','-example','host;whoami','host\r\nusername:s:other','user@host','host:3389','a..b'])assert.throws(()=>validateHost(host));
  for(const user of ['-oProxyCommand=bad','ops;whoami','ops admin',"ops'bad",'$(whoami)'])assert.throws(()=>connectionTarget(linux,{...options,sshUser:user}));
  for(const port of [0,65536,'22',22.5])assert.throws(()=>connectionTarget(linux,{...options,remotePort:port}));
  assert.equal(validateHost('2001:db8::1'),'2001:db8::1');
});

test('blocked ICMP does not block a reachable service, while successful ping cannot authorize a closed port',async()=>{
  const target=connectionTarget(linux,options);
  const available=await inspectConnection(target,{
    ping:async()=>({reachable:false,message:'Blocked'}),
    tcp:async()=>({reachable:true,latencyMs:1}),
    client:async()=>({available:true})
  });
  assert.equal(available.canConnect,true);
  const unavailable=await inspectConnection(target,{
    ping:async()=>({reachable:true}),tcp:async()=>({reachable:false,message:'Closed'}),client:async()=>({available:true})
  });
  assert.equal(unavailable.canConnect,false);
});

test('launch rechecks the service and never starts a client for an unreachable port',async()=>{
  const target=connectionTarget(linux,options);
  let launched=0;
  const launch=async()=>{launched++;};
  await assert.rejects(openConnection(target,{tcp:async()=>({reachable:false,message:'Connection refused'}),launch}),/unreachable/);
  assert.equal(launched,0);
  const result=await openConnection(target,{tcp:async()=>({reachable:true}),launch});
  assert.equal(result.opened,true);
  assert.equal(launched,1);
});

test('SSH launch uses explicit argument boundaries and RDP preserves credential and certificate checks',()=>{
  const target=connectionTarget(linux,{...options,sshUser:'ops',remotePort:2222});
  assert.equal(connectionArtifacts(target).command,'ssh -p 2222 -l ops -- linux.example.test');
  const script=launchScript(target,'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  assert.ok(script.includes("@('-p','2222','-l','ops','--','linux.example.test')"));
  assert.ok(script.includes('-WindowStyle Normal'));
  assert.ok(!script.includes('StrictHostKeyChecking=no'));
  const rdp=connectionTarget({...linux,os:'windows',host:'2001:db8::1'},{host:'2001:db8::1',remotePort:3390});
  const artifact=connectionArtifacts(rdp).rdpFile;
  assert.ok(artifact.includes('full address:s:[2001:db8::1]:3390\r\n'));
  assert.ok(artifact.includes('authentication level:i:1'));
  assert.ok(artifact.includes('prompt for credentials:i:1'));
  assert.ok(launchScript(rdp,'mstsc.exe').includes("'/v:[2001:db8::1]:3390','/prompt'"));
});
