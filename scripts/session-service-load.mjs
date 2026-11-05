// Linux control-plane load test. Reports service RSS/CPU, not the driver's resources.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root=resolve(import.meta.dirname,"..");const work=mkdtempSync(join(tmpdir(),"sh-sessions-load-"));
const studios=Number(process.env.LOAD_STUDIOS||100), guests=Number(process.env.LOAD_GUESTS||6), seconds=Number(process.env.LOAD_SECONDS||30);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const assert=(ok,m)=>{if(!ok)throw Error(m);};
const server=createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));const port=server.address().port;await new Promise(r=>server.close(r));const origin=`http://localhost:${port}`;
const binary=process.env.SESSIONS_BIN||join(root,"target/release/streamhive-sessions");
const service=spawn(binary,[],{env:{...process.env,PUBLIC_URL:origin,LISTEN_ADDR:`127.0.0.1:${port}`,DATA_DIR:work,REGISTRATIONS_PER_HOUR:"10000",REQUESTS_PER_MINUTE:"50000",MAX_CONNECTIONS:String(studios*(guests+1)+100)},stdio:["ignore","ignore","pipe"]});
let errors="";service.stderr.on("data",d=>errors=(errors+d).slice(-2000));const sockets=[];let payloadBytes=0,messages=0,peakRss=0;let success=false;
const stat=()=>{const fields=readFileSync(`/proc/${service.pid}/stat`,"utf8").split(") ")[1].split(" ");const cpu=Number(fields[11])+Number(fields[12]);const rss=Number(readFileSync(`/proc/${service.pid}/status`,"utf8").match(/VmRSS:\s+(\d+)/)?.[1]||0);peakRss=Math.max(peakRss,rss);return {cpu,rss};};
const request=async(path,body,token)=>{const response=await fetch(origin+"/api/v1"+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert(response.ok,JSON.stringify(data));return {data,cookie:response.headers.get("set-cookie")?.split(';')[0]};};
const connect=(sid,headers)=>new Promise((resolve,reject)=>{const ws=new WebSocket(`${origin.replace("http:","ws:")}/api/v1/events?session_id=${sid}`,{headers});sockets.push(ws);const timer=setTimeout(()=>reject(Error("WebSocket snapshot timeout")),20000);let first=true;ws.onmessage=e=>{payloadBytes+=Buffer.byteLength(String(e.data));messages++;if(first){first=false;clearTimeout(timer);resolve(ws);}};ws.onerror=()=>{clearTimeout(timer);reject(Error("WebSocket failed"));};});
async function batch(items,fn,n=15){for(let i=0;i<items.length;i+=n)await Promise.all(items.slice(i,i+n).map(fn));}
try {
 for(let i=0;;i++){try{if((await fetch(origin+"/healthz")).ok)break;}catch{}assert(i<100,"service unavailable: "+errors);await sleep(100);}
 const baseline=stat();const rooms=[];
 await batch(Array.from({length:studios},(_,i)=>i),async i=>{
  const token=(await request("/installations",{})).data.credential;const sid=(await request("/sessions/current",{},token)).data.session.id;const invitation=(await request(`/sessions/${sid}/invitations`,{},token)).data.url.split('/').pop();const room={token,sid,people:[]};rooms.push(room);
  await connect(sid,{Authorization:`Bearer ${token}`});
  for(let g=0;g<guests;g++){const join=await request(`/join/${invitation}`,{name:`Guest ${i}-${g}`});room.people.push(join.data.participant_id);await connect(sid,{Cookie:join.cookie,Origin:origin});}
 });
 assert(sockets.every(s=>s.readyState===WebSocket.OPEN),"not every connection is open");
 const ready=stat();const ticks=Number(execFileSync("getconf",["CLK_TCK"]).toString());const began=performance.now();const startBytes=payloadBytes;const startMessages=messages;const latency=[];
 const sample=setInterval(()=>{try{stat();}catch{}},250);
 await batch(rooms,async room=>{const start=performance.now();await request(`/sessions/${room.sid}/participants/${room.people[0]}`,{action:"admit"},room.token);latency.push(performance.now()-start);},10);
 await sleep(seconds*1000);clearInterval(sample);const end=stat();const duration=(performance.now()-began)/1000;latency.sort((a,b)=>a-b);
 const report={build:binary.includes("/release/")?"release":"custom",studios,guests_per_studio:guests,connections:sockets.length,open_connections:sockets.filter(s=>s.readyState===WebSocket.OPEN).length,duration_seconds:+duration.toFixed(2),baseline_rss_mib:+(baseline.rss/1024).toFixed(2),loaded_rss_mib:+(ready.rss/1024).toFixed(2),peak_rss_mib:+(peakRss/1024).toFixed(2),cpu_percent_one_core:+((end.cpu-ready.cpu)/ticks/duration*100).toFixed(2),admission_p50_ms:+latency[Math.floor(latency.length*.5)].toFixed(2),admission_p95_ms:+latency[Math.min(latency.length-1,Math.floor(latency.length*.95))].toFixed(2),snapshot_messages:messages-startMessages,json_payload_bytes:payloadBytes-startBytes,notes:"Local driver; no multimedia or TLS; includes admission burst and idle heartbeat interval. Setup limits raised because all clients share one IP. JSON bytes exclude framing, ping/pong and TLS."};
 assert(report.open_connections===report.connections,"connections dropped during test");writeFileSync(join(work,"report.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));success=true;
} catch(e){console.error(e.message,errors);}
finally{for(const ws of sockets)ws.close();service.kill("SIGTERM");for(let i=0;i<50&&service.exitCode===null;i++)await sleep(100);if(service.exitCode===null)service.kill("SIGKILL");console.log("Artifacts:",work);process.exit(success?0:1);}
