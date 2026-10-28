export function seed() {
  const racks = [
    {id:'rack-a01',name:'Rack A01',location:'DC-01 · Row A',units:42,maxWatts:8000},
    {id:'rack-a02',name:'Rack A02',location:'DC-01 · Row A',units:42,maxWatts:8000},
    {id:'rack-b01',name:'Rack B01',location:'DC-02 · Row B',units:42,maxWatts:10000}
  ];
  const entries = [
    ['dc-01','DC-01','192.0.2.10','windows','Domain controller','Dell PowerEdge R350','rack-a01',38,1,280,[53,389]],
    ['dc-02','DC-02','192.0.2.11','windows','Domain controller','Dell PowerEdge R350','rack-a02',38,1,280,[53,389]],
    ['app-01','APP-01','192.0.2.20','windows','Application server','Dell PowerEdge R750','rack-a01',34,2,650,[443,3389]],
    ['file-01','FILE-01','192.0.2.30','windows','File server','HPE ProLiant DL380','rack-a01',28,2,580,[445]],
    ['web-01','WEB-01','192.0.2.40','linux','Web server','Dell PowerEdge R650','rack-a01',24,1,320,[22,443]],
    ['web-02','WEB-02','192.0.2.41','linux','Web server','Dell PowerEdge R650','rack-a02',24,1,320,[22,443]],
    ['db-01','DB-01','192.0.2.50','linux','Database server','HPE ProLiant DL380','rack-b01',30,2,750,[22,5432]],
    ['backup-01','BACKUP-01','192.0.2.60','linux','Backup server','Dell PowerEdge R740xd','rack-b01',20,2,540,[22]],
    ['sw-core-01','SW-CORE-01','192.0.2.2','network','Core switch','Cisco Catalyst 9300','rack-a01',42,1,350,[22]],
    ['sw-core-02','SW-CORE-02','192.0.2.3','network','Core switch','Cisco Catalyst 9300','rack-a02',42,1,350,[22]],
    ['san-01','SAN-01','192.0.2.70','storage','Shared storage','Dell PowerVault ME5','rack-b01',8,4,1250,[443]],
    ['mgmt-01','MGMT-01','192.0.2.80','linux','Management server','Dell PowerEdge R350','rack-a02',32,1,230,[22]]
  ];
  const servers = entries.map(([id,name,host,os,role,model,rackId,startU,units,watts,ports]) => ({id,name,host,os,role,model,rackId,startU,units,watts,ports,demo:true}));
  const check = (name, status, message, category='system') => ({name,status,message,category});
  const results = servers.map((s,i) => ({serverId:s.id,checkedAt:new Date(Date.now()-(i+1)*75000).toISOString(),source:'demo',checks:[
    check('DNS resolution','healthy',`${s.name.toLowerCase()}.example.test resolves correctly`,'network'),
    check('TCP connectivity','healthy',`Configured ports ${s.ports.join(', ')} are reachable`,'network'),
    ...(s.os === 'windows' ? [check('Windows services','healthy','Required services are running'),check('Disk capacity',s.id==='file-01'?'warning':'healthy',s.id==='file-01'?'D: volume is 86% full · 140 GB remaining':'All volumes below 80% usage'),check('Time synchronization','healthy','Windows Time reports a synchronized source','time')] : s.os === 'linux' ? [check('CPU load',s.id==='db-01'?'critical':'healthy',s.id==='db-01'?'1-minute load 15.8 on 8 logical CPUs':'Load is within expected range'),check('Memory utilization','healthy','Memory utilization is below 80%'),check('Filesystem capacity','healthy','Filesystems and inodes below 80% usage'),check('Failed services','healthy','No failed systemd services'),check('Time synchronization','healthy','NTP synchronization is active','time')] : []),
    ...(s.role==='Domain controller'?[check('AD replication',s.id==='dc-02'?'warning':'healthy',s.id==='dc-02'?'Replication error 1722: RPC server unavailable from DC-01':'Replication partners report no failures','ad'),check('Domain controller diagnostics','healthy','DCDiag diagnostic tests passed','ad')]:[])
  ]}));
  return {racks,servers,results};
}
