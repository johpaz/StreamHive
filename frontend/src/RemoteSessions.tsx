import { useEffect,useState } from "react";
import { api } from "./api";
type Participant={id:string;name:string;status:string};
type Remote={url:string|null;status:string;error?:string|null;media?:boolean;use_media?:boolean;media_active?:boolean;snapshot?:{session:{id:string;host_online:boolean};participants:Participant[];invitations:{id:string;expires:number;revoked:boolean}[]}|null};
const labels:Record<string,string>={unconfigured:"Sin configurar",connecting:"Conectando",connected:"Conectado",reconnecting:"Reconectando",incompatible:"Servidor incompatible"};
export function RemoteSessions({version,pending,run,settings,onInvite}: {
  version:unknown;pending:boolean;run:(action:()=>Promise<unknown>,message?:string)=>Promise<void>;
  settings:boolean;onInvite:(url:string,media?:boolean)=>void;
}) {
  const [remote,setRemote]=useState<Remote|null>(null);const [url,setUrl]=useState("");const [check,setCheck]=useState("");
  useEffect(()=>{let stopped=false;api<Remote>("/remote-server").then(r=>{if(!stopped)setRemote(r);}).catch(()=>{});return()=>{stopped=true;};},[version]);
  // Do not overwrite an URL being edited when presence notifications arrive.
  useEffect(()=>{if(remote?.url)setUrl(remote.url);},[remote?.url]);
  const active=remote?.snapshot?.session;const connected=remote?.status==="connected";
  if(!settings&&!remote?.url)return null;
  return <section className="panel remote-sessions" id={settings?"servidor-sesiones":undefined} aria-label={settings?"Servidor de sesiones":"Invitados del servidor"}>
    <h2>{settings?"Servidor de sesiones":"Invitados del servidor"}</h2>
    {settings&&<>
      <p>Conecta la app a tu VPS. Las credenciales se generan automáticamente; solo necesitas la URL.</p>
      <form onSubmit={e=>{e.preventDefault();void run(async()=>{await api("/remote-server","PUT",{url});setCheck("");},"Servidor guardado");}}>
        <label>URL del servidor VPS<input type="url" required value={url} disabled={pending} placeholder="https://sesiones.tudominio.com" onChange={e=>{setUrl(e.target.value);setCheck("");}}/></label>
        <div className="scene-toolbar"><button type="button" className="button" disabled={pending||!url} onClick={()=>void run(async()=>{const r=await api<{version:string}>("/remote-server/check","POST",{url});setCheck(`Servidor compatible · versión ${r.version}`);})}>Comprobar</button>
        <button className="button primary" disabled={pending||!url}>Guardar y conectar</button>
        {remote?.url&&<button type="button" className="text-button red" disabled={pending} onClick={()=>void run(async()=>{await api("/remote-server","DELETE");setUrl("");setCheck("");},"Servidor desconectado")}>Desconectar servidor</button>}</div>
      </form>
      {check&&<p role="status">{check}</p>}
    </>}
    <p role="status">{labels[remote?.status??"unconfigured"]??"Sin conexión"}{remote?.url?` · ${remote.url}`:""}{remote?.media_active?" · Cámara y audio por el servidor":""}</p>
    {settings&&remote?.url&&remote.media&&<label className="slate-check"><input type="checkbox" checked={remote.use_media!==false} disabled={pending} onChange={e=>{const enabled=e.target.checked;void run(async()=>{await api("/remote-server/media","PUT",{enabled});setRemote(await api<Remote>("/remote-server"));},enabled?"Cámara y audio por el servidor":"Cámara y audio por este equipo");}}/>Usar el servidor para cámara y audio: los invitados entran desde cualquier red. No se cambia en pleno directo.</label>}
    {settings&&remote?.url&&remote.media===false&&remote.status==="connected"&&<p className="hint">Este servidor no tiene cámara ni audio: solo sala de espera y chat. Actualízalo a la versión con LiveKit para que los invitados salgan en cámara.</p>}
    {remote?.error&&<p className="hint">{remote.error}</p>}
    {!!remote?.url&&(!active?<button className="button" disabled={pending||!connected} onClick={()=>void run(()=>api("/remote-session","POST"),"Sesión remota creada")}>Crear sesión remota</button>:<>
      <div className="scene-toolbar"><button className="button primary" disabled={pending||!connected} onClick={()=>void run(async()=>{const i=await api<{url:string}>("/remote-session/invitations","POST");onInvite(i.url,remote?.media_active);})}>Invitar por VPS</button>
      <button className="text-button red" disabled={pending||!connected} onClick={()=>void run(()=>api("/remote-session","DELETE"),"Sesión remota finalizada")}>Finalizar sesión remota</button></div>
      {!remote.snapshot?.participants.length&&<p className="hint">Aún no hay solicitudes de entrada.</p>}
      <ul className="remote-participants" aria-label="Invitados remotos">{remote.snapshot?.participants.map(p=><li key={p.id}>
        <span><b>{p.name}</b><small>{({waiting:"En espera",admitted:"Entrada aprobada",rejected:"Rechazado",removed:"Retirado"} as Record<string,string>)[p.status]}</small></span>
        <div>{(p.status==="waiting"?[['admit','Admitir'],['reject','Rechazar']]:p.status==="admitted"?[['remove','Retirar']]:[]).map(([action,label])=><button key={action} className="button" disabled={pending||!connected} onClick={()=>void run(()=>api(`/remote-session/participants/${p.id}`,"POST",{action}))}>{label}</button>)}</div>
      </li>)}</ul>
      {!!remote.snapshot?.invitations.length&&<details><summary>Invitaciones del servidor</summary>{remote.snapshot.invitations.map(i=><div className="output-row" key={i.id}><span>{i.id.slice(0,8)} · {i.revoked?"Revocada":new Date(i.expires*1000).toLocaleString()}</span>{!i.revoked&&<button className="text-button" disabled={pending||!connected} onClick={()=>void run(()=>api(`/remote-session/invitations/${i.id}`,"DELETE"))}>Revocar</button>}</div>)}</details>}
    </>)}
    <p className="hint">{remote?.media_active?"Los invitados admitidos aparecen en Fuentes → Participantes. La emisión y las grabaciones siguen en este equipo.":"Este servicio gestiona solicitudes y admisión. Las grabaciones y la emisión siguen en este equipo."}</p>
  </section>;
}
