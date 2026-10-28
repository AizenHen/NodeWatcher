import test from 'node:test';
import assert from 'node:assert/strict';
import {validateServer,validateResults,overall,escapeHtml} from '../lib/model.js';
const racks=[{id:'a',units:42}];
const device={id:'server-1',name:'Server',host:'127.0.0.1',os:'linux',role:'Test',model:'Test',rackId:'a',startU:10,units:2,watts:300,ports:[22],demo:false};
test('rack placement rejects overlap and overflow but allows adjacent devices and self-edit',()=>{
  assert.throws(()=>validateServer({...device,id:'other',startU:11},racks,[device]),/overlaps/);
  assert.throws(()=>validateServer({...device,startU:42},racks,[]),/beyond/);
  assert.equal(validateServer({...device,id:'other',startU:12},racks,[device]).startU,12);
  assert.equal(validateServer(device,racks,[device],device.id).id,device.id);
});
test('inventory requires valid hosts, numeric ports, and known racks',()=>{
  assert.throws(()=>validateServer({...device,host:'http://localhost/path'},racks,[]),/hostname/);
  assert.throws(()=>validateServer({...device,ports:[0]},racks,[]),/TCP port/);
  assert.throws(()=>validateServer({...device,ports:['22']},racks,[]),/TCP port/);
  assert.throws(()=>validateServer({...device,rackId:'missing'},racks,[]),/Rack does not/);
});
test('unknown results are never reported healthy',()=>{
  assert.equal(overall([]),'unknown');
  assert.equal(overall([{status:'healthy'},{status:'unknown'}]),'unknown');
  assert.equal(overall([{status:'warning'},{status:'critical'}]),'critical');
});
test('collector results must reference real inventory and preserve valid timestamps',()=>{
  const result={serverId:device.id,checkedAt:new Date().toISOString(),checks:[{name:'CPU',status:'healthy',message:'Load 0.1'}]};
  assert.equal(validateResults([result],[device])[0].source,'collector');
  assert.throws(()=>validateResults([result],[]),/Unknown server/);
  assert.throws(()=>validateResults([result],[{...device,demo:true}]),/demo device/);
  assert.throws(()=>validateResults([{...result,checkedAt:'tomorrow'}],[device]),/timestamp/);
  assert.throws(()=>validateResults([{...result,checks:[{name:'CPU',status:'ok',message:'fine'}]}],[device]),/status/);
  assert.throws(()=>validateResults([null],[device]),/must be an object/);
  assert.throws(()=>validateResults([{...result,checks:[null]}],[device]),/must be an object/);
});
test('untrusted report values are HTML escaped',()=>assert.equal(escapeHtml('<script>"&\''),'&lt;script&gt;&quot;&amp;&#39;'));

test('endpoint assignments are validated without requiring a rack',()=>{
  const laptop=validateServer({...device,deviceType:'laptop',rackId:'',assignedUser:'LAB\\alex',location:'Office / desk 12'},[],[]);
  assert.equal(laptop.deviceType,'laptop');
  assert.equal(laptop.assignedUser,'LAB\\alex');
  assert.equal(laptop.location,'Office / desk 12');
  assert.throws(()=>validateServer({...device,deviceType:'laptop'},racks,[]),/location instead/);
  assert.throws(()=>validateServer({...device,deviceType:'phone'},racks,[]),/device type/);
  assert.throws(()=>validateServer({...device,assignedUser:[]},racks,[]),/Assigned user/);
  assert.equal(validateServer(device,racks,[]).deviceType,'server');
});
test('session snapshots distinguish missing, empty, unavailable and observed sessions',()=>{
  const result={serverId:device.id,checkedAt:new Date().toISOString(),checks:[{name:'CPU',status:'healthy',message:'OK'}]};
  assert.equal(validateResults([result],[device])[0].userSnapshot,undefined);
  const snapshot={status:'collected',scope:'Console only',sessions:[]};
  assert.deepEqual(validateResults([{...result,userSnapshot:snapshot}],[device])[0].userSnapshot,snapshot);
  const observed={...snapshot,sessions:[{user:'LAB\\alex',connection:'Console'}]};
  assert.deepEqual(validateResults([{...result,userSnapshot:observed}],[device])[0].userSnapshot,observed);
  assert.throws(()=>validateResults([{...result,userSnapshot:{...observed,status:'unavailable'}}],[device]),/cannot contain/);
  assert.throws(()=>validateResults([{...result,userSnapshot:{...snapshot,sessions:[{user:'',connection:'Console'}]}}],[device]),/Session user/);
  assert.throws(()=>validateResults([{...result,userSnapshot:{...snapshot,sessions:Array(101).fill(observed.sessions[0])}}],[device]),/100 user/);
});

test('large rack devices fit only in consecutive free units',()=>{
 for(const units of [3,4,8,21,42])assert.equal(validateServer({...device,startU:1,units},racks,[]).units,units);
 assert.throws(()=>validateServer({...device,startU:40,units:4},racks,[]),/beyond/);
 assert.throws(()=>validateServer({...device,startU:1,units:12},racks,[{...device,id:'occupied',startU:10}]),/overlaps/);
 assert.throws(()=>validateServer({...device,units:61},racks,[]),/Device height/);
});
