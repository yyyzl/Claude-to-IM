// 本任务握手验证限定为本地 stdio，不允许外部网络请求。
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const rejectNetwork = () => { throw new Error('离线 MCP 握手禁止网络请求'); };
net.Socket.prototype.connect = rejectNetwork;
http.request = rejectNetwork;
http.get = rejectNetwork;
https.request = rejectNetwork;
https.get = rejectNetwork;
globalThis.fetch = rejectNetwork;
syncBuiltinESMExports();
