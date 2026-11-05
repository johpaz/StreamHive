import { StudioChat } from "./StudioChat";
import { chatSignal } from "./chat";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
type Snapshot = {session:{id:string;host_online:boolean;closed:boolean;expires:number};participant:{id:string;name:string;status:string}|null};
function Guest() {
  const token = location.pathname.startsWith("/join/") ? location.pathname.slice(6) : "";
  const [name,setName]=useState("");const [state,setState]=useState<Snapshot|null>(null);
  const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [session,setSession]=useState("");const [connected,setConnected]=useState(false);
  useEffect(()=>{let stop=false;if(token)void fetch(`/api/v1/join/${encodeURIComponent(token)}`).then(async r=>{if(r.ok&&!stop){const next=await r.json();setState(next);setSession(next.session.id);}}).catch(()=>{});return()=>{stop=true;};},[token]);
  useEffect(()=>{
    if(!session)return;
    let stopped=false;let socket:WebSocket|undefined;let timer:ReturnType<typeof setTimeout>;
    const open=()=>{
      socket=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/api/v1/events?session_id=${encodeURIComponent(session)}`);
      socket.onopen=()=>{setConnected(true);setError("");chatSignal();};
      socket.onmessage=(e)=>{chatSignal(e.data);const m=JSON.parse(e.data);if(m.type==="snapshot"){setState(m.data);if(m.data.session.closed||m.data.session.expires*1000<=Date.now()||["removed","rejected"].includes(m.data.participant?.status)){stopped=true;socket?.close();}}};
      socket.onclose=()=>{setConnected(false);if(!stopped)timer=setTimeout(open,3000);};
    };open();return()=>{stopped=true;clearTimeout(timer);socket?.close();};
  },[session]);
  const status=state?.participant?.status;const closed=Boolean(state?.session.closed||(state&&state.session.expires*1000<Date.now()));
  return <main><span className="brand">StreamHive</span><h1>Entrada de invitados</h1>
    {!token&&!session?<p>Abre el enlace de invitación que te envió el anfitrión.</p>:!session?<form onSubmit={async(e)=>{
      e.preventDefault();setBusy(true);setError("");try{
        const r=await fetch(`/api/v1/join/${encodeURIComponent(token)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});const data=await r.json();if(!r.ok)throw Error(data.error);
        setSession(data.session_id);
      }catch(e){setError(e instanceof Error?e.message:"No se pudo solicitar la entrada");}finally{setBusy(false);}
    }}><p>Escribe tu nombre para que el anfitrión pueda reconocerte.</p><label>Tu nombre<input required maxLength={60} value={name} onChange={e=>setName(e.target.value)} autoComplete="name"/></label><button disabled={busy}>{busy?"Enviando…":"Solicitar entrada"}</button></form>:<>
      <p className="state" role="status">{closed?"La sesión terminó":status==="admitted"?"Entrada aprobada":status==="rejected"?"Solicitud rechazada":status==="removed"?"Tu entrada fue retirada":"Esperando al anfitrión"}</p>
      {state?.participant&&<p>{state.participant.name}</p>}
      {!closed&&!["removed","rejected"].includes(status??"")&&<p>{!connected?"Reconectando con el servidor…":state?.session.host_online?"El anfitrión está conectado.":"El anfitrión no está conectado. Tu solicitud se conserva."}</p>}
    </>}
    {!closed&&status==="admitted"&&state?.participant&&<StudioChat key={session+state.participant.id} me={{id:state.participant.id,role:"guest"}} sessionId={session}/>}
    {error&&<p className="error" role="alert">{error}</p>}
    <p className="notice">Esta página gestiona tu entrada. La conexión de cámara y audio todavía no está incluida en esta versión.</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Guest/>);
