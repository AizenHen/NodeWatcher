import test from 'node:test';
import assert from 'node:assert/strict';
import {createRepairManager,targetFor,commandFor,parseDiagnostic,remoteRun} from '../lib/repairs.js';
import ssh2 from 'ssh2';
const {Server,utils}=ssh2;
import {generateKeyPairSync,createHash} from 'node:crypto';
const device={id:'real',host:'127.0.0.1',os:'linux',demo:false};
const testPassword=['test','only'].join('-');
const input={host:device.host,port:22,username:'ops',password:testPassword,fingerprint:'SHA256:'+'a'.repeat(43)};
const report=(state='failed')=>JSON.stringify({cpu:90,memory:85,processes:'test process',services:{nginx:state,apache2:'unknown',cron:'active'}});
test('repair inputs reject demo devices, changed addresses, bad ports, and unverified SSH hosts',()=>{
 assert.throws(()=>targetFor({...device,demo:true},input),/real/);
 assert.throws(()=>targetFor(device,{...input,host:'other'}),/changed/);
 assert.throws(()=>targetFor(device,{...input,fingerprint:''}),/fingerprint/);
 assert.throws(()=>targetFor(device,{...input,port:0}),/port/);
 assert.throws(()=>commandFor('linux','nginx;reboot'),/recipe/);
 assert.throws(()=>parseDiagnostic('{"cpu":null}'),/metrics/);
});
test('approved repairs are single use, recheck state, and verify service after repair',async()=>{
 const calls=[];let running=false;
 const manager=createRepairManager(async(t,service)=>{calls.push(service||'diagnose');if(service){running=true;return '';}return report(running?'active':'failed');});
 const plan=await manager.investigate(device,input);assert.equal(plan.offers.length,1);
 assert.equal(JSON.stringify(plan).includes(input.password),false);
 const result=await manager.repair(device,{...input,token:plan.offers[0].token,approve:true});
 assert.equal(result.verified,true);assert.deepEqual(calls,['diagnose','diagnose','nginx','diagnose']);
 await assert.rejects(manager.repair(device,{...input,token:plan.offers[0].token,approve:true}),/approval/);
});
test('approval cannot be reused for another device or connection, and no CPU kill recipe exists',async()=>{
 const manager=createRepairManager(async()=>report());const plan=await manager.investigate(device,input);const token=plan.offers[0].token;
 for(const changed of [{approve:false},{port:2222,approve:true},{username:'other',approve:true}])await assert.rejects(manager.repair(device,{...input,token,...changed}),/approval/);
 await assert.rejects(manager.repair({...device,id:'different'},{...input,token,approve:true}),/approval/);
 assert.ok(plan.offers.every(x=>!x.command.includes('kill')));
});
test('service state changes and command failures never report a successful fix',async()=>{
 let calls=0;const manager=createRepairManager(async()=>report(++calls===1?'failed':'active'));
 const plan=await manager.investigate(device,input);
 await assert.rejects(manager.repair(device,{...input,token:plan.offers[0].token,approve:true}),/state changed/);
 const failed=createRepairManager(async(t,service)=>{if(service)throw new Error('permission denied');return report();});
 const p=await failed.investigate(device,input);await assert.rejects(failed.repair(device,{...input,token:p.offers[0].token,approve:true}),/permission denied/);
});
test('SSH transport authenticates against a verified host and executes fixed diagnostics',async t=>{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 let publicBlob;let auths=0;
 const server=new Server({hostKeys:[privateKey]},client=>{
  client.on('error',()=>{});
  client.on('authentication',ctx=>{auths++;if(ctx.method==='password'&&ctx.username==='ops'&&ctx.password===testPassword)ctx.accept();else ctx.reject();});
  client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('exec',(accept,reject,info)=>{assert.match(info.command,/python3/);const stream=accept();stream.write(report());stream.exit(0);stream.end();});}));
 });
 publicBlob=utils.parseKey(privateKey).getPublicSSH();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const target={...targetFor(device,input),port:server.address().port,fingerprint:'SHA256:'+createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/,'')};
 assert.equal(parseDiagnostic(await remoteRun(target)).cpu,90);
 const previous=auths;await assert.rejects(remoteRun({...target,fingerprint:input.fingerprint}),/SSH failed/);assert.equal(auths,previous);
});
