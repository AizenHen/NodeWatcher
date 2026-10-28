import test from 'node:test';
import assert from 'node:assert/strict';
import {appendChange,deviceChange,differences} from '../lib/changes.js';

test('device changes contain only tracked configuration fields',()=>{
  const before={id:'web-1',name:'WEB-1',host:'old.example',ports:[22],password:['never','record','this'].join('-')};
  const after={...before,host:'new.example',ports:[22,443],password:['also','never','record','this'].join('-')};
  const changes=differences(before,after);
  assert.deepEqual(changes,[{field:'host',before:'old.example',after:'new.example'},{field:'ports',before:'22',after:'22, 443'}]);
  assert.ok(!JSON.stringify(changes).includes('never-record'));
});

test('change history records before and after values and caps retention',()=>{
  const state={changeHistory:[]};
  deviceChange(state,null,{id:'web-1',name:'WEB-1',host:'web.example',ports:[443]},'created');
  assert.equal(state.changeHistory[0].entityId,'web-1');
  assert.equal(state.changeHistory[0].action,'created');
  state.changeHistory=Array.from({length:5000},(_,i)=>({id:String(i)}));
  appendChange(state,{entityType:'monitoring',entityId:'schedule',action:'updated',summary:'Changed',changes:[]});
  assert.equal(state.changeHistory.length,5000);
  assert.equal(state.changeHistory.at(-1).summary,'Changed');
});
