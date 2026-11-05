// Real Traefik TLS + WebSocket proxy smoke. Self-signed TLS is accepted ONLY by this test driver.
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const work=mkdtempSync(join(tmpdir(),"sh-traefik-"));const suffix=Date.now().toString(36);const network=`sh-sessions-${suffix}`,api=`sh-sessions-api-${suffix}`,proxy=`sh-sessions-edge-${suffix}`,volume=`sh-sessions-data-${suffix}`;
const run=(...args)=>execFileSync("podman",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const free=()=>new Promise(r=>{const s=createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p));});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const assert=(v,m)=>{if(!v)throw Error(m);};let success=false;const sockets=[];
try{
 const port=await free();const origin=`https://localhost:${port}`;
 writeFileSync(join(work,"dynamic.yaml"),`http:\n  routers:\n    sessions:\n      entryPoints: [websecure]\n      rule: Host(\`localhost\`)\n      service: sessions\n      tls: {}\n  services:\n    sessions:\n      loadBalancer:\n        servers:\n          - url: http://sessions:8080\n`);
 run("network","create",network);
 run("run","-d","--rm","--name",api,"--read-only","--user","1000:1000","--cap-drop","ALL","--security-opt","no-new-privileges","--tmpfs","/tmp:size=64M,mode=1777","--volume",`${volume}:/data`,"--network",network,"--network-alias","sessions","--memory","384m","--cpus","0.5","-e",`PUBLIC_URL=${origin}`,process.env.SESSIONS_IMAGE||"localhost/streamhive-sessions:review");
 run("run","-d","--rm","--name",proxy,"--network",network,"-p",`127.0.0.1:${port}:443`,"-v",`${join(work,"dynamic.yaml")}:/etc/traefik/dynamic.yaml:ro,Z`,"docker.io/library/traefik:v3.6","--entrypoints.websecure.address=:443","--providers.file.filename=/etc/traefik/dynamic.yaml","--log.level=ERROR");
 for(let i=0;;i++){try{if((await fetch(origin+"/readyz",{tls:{rejectUnauthorized:false}})).ok)break;}catch{}assert(i<100,"Traefik TLS proxy unavailable");await sleep(100);}
 const request=async(path,body,token)=>{const r=await fetch(origin+"/api/v1"+path,{method:body===undefined?"GET":"POST",tls:{rejectUnauthorized:false},headers:{"Content-Type":"application/json",Origin:origin,...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok,`Request failed: ${r.status}`);return {data:await r.json(),cookie:r.headers.get("set-cookie")?.split(';')[0]};};
 assert((await request("/meta")).data.service==="streamhive-sessions","wrong service");
 const token=(await request("/installations",{})).data.credential;const sid=(await request("/sessions/current",{},token)).data.session.id;
 const connect=headers=>new Promise((resolve,reject)=>{const ws=new WebSocket(`${origin.replace("https:","wss:")}/api/v1/events?session_id=${sid}`,{headers,tls:{rejectUnauthorized:false}});sockets.push(ws);const timer=setTimeout(()=>reject(Error("WSS snapshot timeout")),10000);ws.onmessage=e=>{clearTimeout(timer);resolve({ws,snapshot:JSON.parse(e.data).data});};ws.onerror=()=>{clearTimeout(timer);reject(Error("WSS connection failed"));};});
 const owner=await connect({Authorization:`Bearer ${token}`});assert(owner.snapshot.session.host_online,"host not online through WSS");
 const invitation=(await request(`/sessions/${sid}/invitations`,{},token)).data.url.split('/').pop();const joined=await request(`/join/${invitation}`,{name:"Traefik guest"});const guest=await connect({Cookie:joined.cookie,Origin:origin});assert(guest.snapshot.participant.status==="waiting","guest not waiting");
 const admitted=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Admission did not cross WSS proxy")),10000);guest.ws.onmessage=e=>{if(JSON.parse(e.data).data.participant.status==="admitted"){clearTimeout(timer);resolve();}};});
 await request(`/sessions/${sid}/participants/${joined.data.participant_id}`,{action:"admit"},token);await admitted;
 run("exec",api,"streamhive-sessions","healthcheck");console.log("TRAEFIK TLS/WSS OK: metadata, owner and guest sockets, admission and readiness");success=true;
}catch(e){console.error(e.message);for(const name of[api,proxy])try{console.error(run("logs",name).slice(-1500));}catch{}}
finally{for(const socket of sockets)socket.close();for(const name of[proxy,api])try{run("rm","-f",name);}catch{}try{run("volume","rm",volume);}catch{}try{run("network","rm",network);}catch{}console.log("Artifacts:",work);process.exit(success?0:1);}
