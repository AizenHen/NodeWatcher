import { isIP } from 'node:net';
export const STATUSES = ['healthy', 'warning', 'critical', 'unknown'];
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function overall(checks) {
  if (!checks.length) return 'unknown';
  if (checks.some(c => c.status === 'critical')) return 'critical';
  if (checks.some(c => c.status === 'warning')) return 'warning';
  if (checks.some(c => c.status === 'unknown')) return 'unknown';
  return 'healthy';
}
function fail(message) { throw Object.assign(new Error(message), {status: 400}); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
}
export function string(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be a nonempty string (maximum ${max} characters).`);
  return value.trim();
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
export function validateHost(value) {
  const host = string(value, 'Hostname or IP', 253);
  if (!isIP(host) && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/.test(host)) fail('Enter a valid hostname or IP address without a URL, path, or command options.');
  return host;
}
export function remoteSettings(os, input = {}) {
  const remotePort = integer(input.remotePort ?? (os === 'windows' ? 3389 : 22), 'Remote access port', 1, 65535);
  const sshUser = input.sshUser ?? '';
  if (typeof sshUser !== 'string' || (sshUser && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,63}$/.test(sshUser))) fail('SSH username must use 1–64 letters, numbers, underscores, dots, @ signs, or hyphens, and cannot start with a hyphen.');
  return {remotePort, sshUser: os === 'linux' ? sshUser : ''};
}
export function validateRack(input) {
  object(input, 'Rack');
  return {id: string(input.id, 'Rack ID', 60), name: string(input.name, 'Rack name'), location: string(input.location, 'Location'), units: integer(input.units, 'Rack capacity', 1, 60), maxWatts: integer(input.maxWatts, 'Power budget', 1, 100000)};
}
export function validateServer(input, racks, servers, excludeId = null) {
  object(input, 'Device');
  const id = string(input.id, 'Server ID', 60);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail('Server ID may contain only letters, numbers, underscores and hyphens.');
  const host = validateHost(input.host);
  const deviceType = input.deviceType ?? (['network','storage'].includes(input.os) ? input.os : 'server');
  if (!['server','laptop','desktop','network','storage'].includes(deviceType)) fail('Invalid device type.');
  const optional = (value, name) => value === undefined || value === '' ? '' : string(value, name);
  const assignedUser = optional(input.assignedUser, 'Assigned user');
  const location = optional(input.location, 'Device location');
  const os = string(input.os, 'Operating system');
  if (!['windows', 'linux', 'network', 'storage'].includes(os)) fail('Invalid operating system type.');
  const rackId = typeof input.rackId === 'string' ? input.rackId : '';
  if (['laptop','desktop'].includes(deviceType) && rackId) fail('Laptops and desktop PCs use a location instead of a rack.');
  const units = integer(input.units ?? 1, 'Device height', 1, 60);
  const startU = integer(input.startU ?? 1, 'Starting rack unit', 1, 60);
  if (rackId) {
    const rack = racks.find(r => r.id === rackId);
    if (!rack) fail('Rack does not exist.');
    if (startU + units - 1 > rack.units) fail('Device extends beyond the rack capacity.');
    if (servers.some(s => s.id !== excludeId && s.rackId === rackId && startU < s.startU + s.units && startU + units > s.startU)) fail('This rack position overlaps another device.');
  }
  const ports = input.ports;
  if (!Array.isArray(ports) || ports.length > 12) fail('Specify up to 12 TCP ports.');
  ports.forEach(p => integer(p, 'TCP port', 1, 65535));
  return {id, deviceType, assignedUser, location, name: string(input.name, 'Device name'), host, os, role: string(input.role, 'Role'), model: string(input.model || 'Generic device', 'Model'), rackId, startU, units, watts: integer(input.watts ?? 0, 'Power allocation', 0, 30000), ports: [...new Set(ports)], demo: input.demo === true, ...remoteSettings(os,input)};
}
export function validateResults(results, servers) {
  if (!Array.isArray(results) || !results.length || results.length > 1000) fail('Provide between 1 and 1,000 result records.');
  return results.map(r => {
    object(r, 'Result');
    const serverId = string(r.serverId, 'Server ID', 60);
    const server = servers.find(s => s.id === serverId);
    if (!server) fail(`Unknown server ID: ${serverId}. Add the device to inventory first.`);
    if (server.demo) fail(`Cannot attach real results to demo device ${serverId}. Create a real device first.`);
    const date = Date.parse(r.checkedAt);
    if (!Number.isFinite(date) || date > Date.now() + 300000) fail('checkedAt must be a valid timestamp, no more than 5 minutes in the future.');
    if (!Array.isArray(r.checks) || !r.checks.length || r.checks.length > 100) fail('Each record needs 1–100 checks.');
    let userSnapshot;
    if (r.userSnapshot !== undefined) {
      object(r.userSnapshot, 'User snapshot');
      const snapshot = r.userSnapshot;
      if (!['collected','unavailable'].includes(snapshot.status)) fail('Invalid user snapshot status.');
      if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length > 100) fail('Provide up to 100 user sessions.');
      if (snapshot.status === 'unavailable' && snapshot.sessions.length) fail('Unavailable snapshots cannot contain sessions.');
      userSnapshot = {status:snapshot.status, scope:string(snapshot.scope,'Session scope',200), sessions:snapshot.sessions.map(session=>{
        object(session, 'Session');
        return {user:string(session.user,'Session user'), connection:string(session.connection,'Session connection',120)};
      })};
    }
    return {serverId, checkedAt: new Date(date).toISOString(), source: 'collector', ...(userSnapshot ? {userSnapshot} : {}), checks: r.checks.map(c => {
      object(c, 'Check');
      if (!STATUSES.includes(c.status)) fail('Invalid check status.');
      let metric;
      if(c.metric!==undefined){object(c.metric,'Check metric');if(typeof c.metric.value!=='number'||!Number.isFinite(c.metric.value))fail('Metric value must be a finite number.');metric={value:c.metric.value,unit:string(c.metric.unit,'Metric unit',20)};}
      return {name: string(c.name, 'Check name'), status: c.status, category: string(c.category || 'system', 'Category', 40), message: string(c.message, 'Check message', 2000),...(metric?{metric}:{})};
    })};
  });
}
