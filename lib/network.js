import net from 'node:net';
import dns from 'node:dns/promises';
export function tcpProbe(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const start = performance.now();
    const socket = net.createConnection({host,port});
    let done = false;
    function finish(reachable,message) {
      if(done)return;
      done=true;
      clearTimeout(timer);
      socket.destroy();
      resolve({reachable,message,latencyMs:reachable?Math.round(performance.now()-start):null});
    }
    const timer=setTimeout(()=>finish(false,`Connection timed out after ${timeout/1000} seconds`),timeout);
    socket.on('connect',()=>finish(true,`Connected in ${Math.round(performance.now()-start)} ms`));
    socket.on('error',e=>finish(false,e.code || e.message));
  });
}
export async function networkChecks(server) {
  const checks = [];
  try {
    const addresses = await Promise.race([dns.lookup(server.host,{all:true}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('DNS lookup timed out')),3000);t.unref();})]);
    checks.push({name:'DNS resolution',status:'healthy',category:'network',message:addresses.map(a=>a.address).join(', ')});
  } catch(e) { checks.push({name:'DNS resolution',status:'critical',category:'network',message:e.message}); }
  const ports = await Promise.all(server.ports.map(async port => {
    const result=await tcpProbe(server.host,port);
    return {name:`TCP ${port}`,status:result.reachable?'healthy':'critical',category:'network',message:result.message,...(result.latencyMs===null?{}:{metric:{value:result.latencyMs,unit:'ms'}})};
  }));
  return [...checks,...ports];
}
