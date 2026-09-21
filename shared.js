/* ============================================================
   shared.js — Calculadora de Custo de Corte Laser
   Código e dados partilhados pelas 3 páginas:
   index.html (Orçamentação), encomendas.html, definicoes.html
   Tudo exposto sob o objeto global LC.
   ============================================================ */
(function(){
  "use strict";
  const LC = {};

  /* ---------------------------------------------------------------- */
  /* FORMATTERS                                                        */
  /* ---------------------------------------------------------------- */
  LC.fmtEUR = n => '€' + (isFinite(n) ? n.toFixed(2) : '0.00').replace('.', ',');
  LC.fmtNum = (n, d) => isFinite(n) ? n.toLocaleString('pt-PT', {minimumFractionDigits:d||0, maximumFractionDigits:d||0}) : '—';
  LC.escapeHtml = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  LC.sanitizeFileName = s => String(s||'').trim().replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,' ').slice(0,120) || 'sem-nome';

  /* ---------------------------------------------------------------- */
  /* DXF PARSER                                                        */
  /* ---------------------------------------------------------------- */
  function dist(a,b){ return Math.hypot(b.x-a.x, b.y-a.y); }

  function bulgeSegment(p1,p2,bulge,segments){
    segments = segments || 20;
    const chord = dist(p1,p2);
    if (Math.abs(bulge) < 1e-9 || chord < 1e-9) return { points:[p2], length:chord };
    const theta = 4*Math.atan(bulge);
    const radius = Math.abs(chord/(2*Math.sin(theta/2)));
    const sign = bulge >= 0 ? 1 : -1;
    const mx=(p1.x+p2.x)/2, my=(p1.y+p2.y)/2;
    const dx=p2.x-p1.x, dy=p2.y-p1.y;
    const ux=-dy/chord, uy=dx/chord;
    const h=Math.sqrt(Math.max(radius*radius-(chord/2)*(chord/2),0));
    const cx=mx-sign*ux*h, cy=my-sign*uy*h;
    const a1=Math.atan2(p1.y-cy,p1.x-cx);
    const points=[];
    for(let i=1;i<=segments;i++){
      const a=a1+(theta*i)/segments;
      points.push({x:cx+radius*Math.cos(a), y:cy+radius*Math.sin(a)});
    }
    return { points, length:Math.abs(radius*theta) };
  }

  function expandBulgePolyline(rawPts, closed){
    const full=[rawPts[0]];
    const n=rawPts.length;
    const count = closed ? n : n-1;
    for(let i=0;i<count;i++){
      const p1=rawPts[i], p2=rawPts[(i+1)%n];
      if(!p2) continue;
      const seg=bulgeSegment(p1,p2,p1.bulge||0);
      full.push.apply(full, seg.points);
    }
    return full;
  }

  function finalizeContour(points, closed){
    let length=0;
    for(let i=0;i<points.length-1;i++) length += dist(points[i], points[i+1]);
    if(closed) length += dist(points[points.length-1], points[0]);
    let area=0;
    if(closed){
      for(let i=0;i<points.length;i++){
        const p1=points[i], p2=points[(i+1)%points.length];
        area += p1.x*p2.y - p2.x*p1.y;
      }
      area = Math.abs(area)/2;
    }
    return { points, closed, length, area };
  }

  function parseDXF(text){
    const rawLines = text.split(/\r\n|\r|\n/);
    const tokens=[];
    for(let i=0;i+1<rawLines.length;i+=2){
      const code=parseInt(rawLines[i].trim(),10);
      const value=rawLines[i+1].trim();
      if(!Number.isFinite(code)) continue;
      tokens.push({code,value});
    }
    let start=-1, end=-1;
    for(let i=0;i<tokens.length;i++){
      if(tokens[i].code===2 && tokens[i].value==='ENTITIES' && tokens[i-1] && tokens[i-1].code===0 && tokens[i-1].value==='SECTION'){
        start=i+1;
      }
      if(start>=0 && tokens[i].code===0 && tokens[i].value==='ENDSEC' && i>start){ end=i; break; }
    }
    if(start<0) throw new Error('Secção ENTITIES não encontrada no ficheiro DXF.');
    if(end<0) end=tokens.length;
    const entityTokens = tokens.slice(start,end);

    const rawEntities=[];
    let current=null;
    for(const t of entityTokens){
      if(t.code===0){
        if(current) rawEntities.push(current);
        current={type:t.value, items:[]};
      } else if(current) current.items.push(t);
    }
    if(current) rawEntities.push(current);

    const contours=[];
    const warnings=new Set();
    const get=(ent,code)=>ent.items.filter(i=>i.code===code);

    for(let idx=0; idx<rawEntities.length; idx++){
      const ent = rawEntities[idx];
      if(ent.type==='LINE'){
        const x1=parseFloat((get(ent,10)[0]||{}).value), y1=parseFloat((get(ent,20)[0]||{}).value);
        const x2=parseFloat((get(ent,11)[0]||{}).value), y2=parseFloat((get(ent,21)[0]||{}).value);
        if([x1,y1,x2,y2].every(Number.isFinite)) contours.push(finalizeContour([{x:x1,y:y1},{x:x2,y:y2}], false));
      } else if(ent.type==='CIRCLE'){
        const cx=parseFloat((get(ent,10)[0]||{}).value), cy=parseFloat((get(ent,20)[0]||{}).value), rad=parseFloat((get(ent,40)[0]||{}).value);
        if([cx,cy,rad].every(Number.isFinite)){
          const pts=[]; const N=64;
          for(let i=0;i<N;i++){ const a=(i/N)*2*Math.PI; pts.push({x:cx+rad*Math.cos(a), y:cy+rad*Math.sin(a)}); }
          contours.push({points:pts, closed:true, length:2*Math.PI*rad, area:Math.PI*rad*rad});
        }
      } else if(ent.type==='ARC'){
        const cx=parseFloat((get(ent,10)[0]||{}).value), cy=parseFloat((get(ent,20)[0]||{}).value), rad=parseFloat((get(ent,40)[0]||{}).value);
        let a1=parseFloat((get(ent,50)[0]||{}).value), a2=parseFloat((get(ent,51)[0]||{}).value);
        if([cx,cy,rad,a1,a2].every(Number.isFinite)){
          a1=a1*Math.PI/180; a2=a2*Math.PI/180;
          let sweep=a2-a1; if(sweep<=0) sweep+=2*Math.PI;
          const N=Math.max(8, Math.round(sweep/(Math.PI/32)));
          const pts=[];
          for(let i=0;i<=N;i++){ const a=a1+sweep*i/N; pts.push({x:cx+rad*Math.cos(a), y:cy+rad*Math.sin(a)}); }
          contours.push({points:pts, closed:false, length:rad*sweep, area:0});
        }
      } else if(ent.type==='LWPOLYLINE'){
        const verts=[]; let cur=null;
        for(const it of ent.items){
          if(it.code===10){ if(cur) verts.push(cur); cur={x:parseFloat(it.value), y:0, bulge:0}; }
          else if(it.code===20 && cur) cur.y=parseFloat(it.value);
          else if(it.code===42 && cur) cur.bulge=parseFloat(it.value);
        }
        if(cur) verts.push(cur);
        const flagsTok=get(ent,70)[0];
        const flags = flagsTok ? parseInt(flagsTok.value,10) : 0;
        const closed = (flags & 1) === 1;
        if(verts.length>=2) contours.push(finalizeContour(expandBulgePolyline(verts, closed), closed));
      } else if(ent.type==='POLYLINE'){
        const flagsTok=get(ent,70)[0];
        const flags = flagsTok ? parseInt(flagsTok.value,10) : 0;
        const closed = (flags & 1) === 1;
        const verts=[];
        let j=idx+1;
        while(j<rawEntities.length && rawEntities[j].type==='VERTEX'){
          const v=rawEntities[j];
          const x=parseFloat((get(v,10)[0]||{}).value), y=parseFloat((get(v,20)[0]||{}).value);
          const bTok=get(v,42)[0];
          const bulge = bTok ? parseFloat(bTok.value) : 0;
          if(Number.isFinite(x) && Number.isFinite(y)) verts.push({x,y,bulge});
          j++;
        }
        if(j<rawEntities.length && rawEntities[j].type==='SEQEND') idx=j; else idx=j-1;
        if(verts.length>=2) contours.push(finalizeContour(expandBulgePolyline(verts, closed), closed));
      } else if(ent.type==='SPLINE' || ent.type==='ELLIPSE'){
        warnings.add(ent.type);
        const pts=[]; let cur=null;
        for(const it of ent.items){
          if(it.code===10 || it.code===11){ if(cur) pts.push(cur); cur={x:parseFloat(it.value), y:0}; }
          else if((it.code===20 || it.code===21) && cur) cur.y=parseFloat(it.value);
        }
        if(cur) pts.push(cur);
        if(pts.length>=2) contours.push(finalizeContour(pts, false));
      }
    }

    // Muitos CAD exportam um contorno fechado como vários segmentos soltos (ex: um retângulo
    // como 4 LINE separadas, em vez de uma polilinha) — cada um nasce "aberto" mas, juntos,
    // formam uma forma fechada. Aqui juntam-se pelas pontas que coincidem, para a forma ser
    // corretamente reconhecida como fechada (conta para as perfurações detetadas automaticamente).
    // O perímetro total nunca muda com isto — já estava certo antes, é só a contagem de furos.
    const STITCH_TOL = 0.01; // mm — tolerância para duas pontas serem "a mesma"
    const same = (a,b) => dist(a,b) <= STITCH_TOL;
    const closedIn = contours.filter(c=>c.closed);
    const openIn = contours.filter(c=>!c.closed).map(c=>({points: c.points.slice(), used:false}));
    const stitched = [];
    for(let i=0;i<openIn.length;i++){
      if(openIn[i].used) continue;
      openIn[i].used = true;
      let chain = openIn[i].points.slice();
      let closedLoop = false;
      let grew = true;
      while(grew){
        grew = false;
        if(same(chain[0], chain[chain.length-1]) && chain.length>2){ closedLoop = true; break; }
        for(let j=0;j<openIn.length;j++){
          if(openIn[j].used) continue;
          const p = openIn[j].points;
          const tail = chain[chain.length-1];
          if(same(tail, p[0])){ chain = chain.concat(p.slice(1)); openIn[j].used = true; grew = true; break; }
          if(same(tail, p[p.length-1])){ chain = chain.concat(p.slice(0,-1).reverse()); openIn[j].used = true; grew = true; break; }
          const head = chain[0];
          if(same(head, p[p.length-1])){ chain = p.slice(0,-1).concat(chain); openIn[j].used = true; grew = true; break; }
          if(same(head, p[0])){ chain = p.slice(1).reverse().concat(chain); openIn[j].used = true; grew = true; break; }
        }
      }
      if(!closedLoop && chain.length>2 && same(chain[0], chain[chain.length-1])) closedLoop = true;
      stitched.push(finalizeContour(chain, closedLoop));
    }
    const finalContours = closedIn.concat(stitched);

    const allPoints = finalContours.reduce((acc,c)=>acc.concat(c.points), []);
    const xs=allPoints.map(p=>p.x), ys=allPoints.map(p=>p.y);
    const bbox = allPoints.length ? { minX:Math.min.apply(null,xs), maxX:Math.max.apply(null,xs), minY:Math.min.apply(null,ys), maxY:Math.max.apply(null,ys) } : null;

    return {
      contours: finalContours,
      warnings: Array.from(warnings),
      totalLength: finalContours.reduce((s,c)=>s+c.length,0),
      bbox,
      closedContours: finalContours.filter(c=>c.closed),
      openContours: finalContours.filter(c=>!c.closed),
    };
  }
  LC.parseDXF = parseDXF;

  /* ---------------------------------------------------------------- */
  /* DEFAULTS                                                          */
  /* ---------------------------------------------------------------- */
  LC.DEFAULT_MATERIALS = [
    {id:'m1',  name:'Aço Carbono', thickness:1,  speed:6000, density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m2',  name:'Aço Carbono', thickness:2,  speed:4500, density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m3',  name:'Aço Carbono', thickness:3,  speed:3500, density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m4',  name:'Aço Carbono', thickness:4,  speed:2500, density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m5',  name:'Aço Carbono', thickness:5,  speed:1800, density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m6',  name:'Aço Carbono', thickness:6,  speed:1400, density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m7',  name:'Aço Carbono', thickness:8,  speed:900,  density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m8',  name:'Aço Carbono', thickness:10, speed:650,  density:7.85, pricePerKg:1.3, markupPct:0},
    {id:'m9',  name:'Aço Inox',    thickness:1,  speed:5000, density:8.00, pricePerKg:4.5, markupPct:0},
    {id:'m10', name:'Aço Inox',    thickness:2,  speed:3500, density:8.00, pricePerKg:4.5, markupPct:0},
    {id:'m11', name:'Aço Inox',    thickness:3,  speed:2200, density:8.00, pricePerKg:4.5, markupPct:0},
    {id:'m12', name:'Aço Inox',    thickness:4,  speed:1500, density:8.00, pricePerKg:4.5, markupPct:0},
    {id:'m13', name:'Aço Inox',    thickness:5,  speed:1000, density:8.00, pricePerKg:4.5, markupPct:0},
    {id:'m14', name:'Aço Inox',    thickness:6,  speed:700,  density:8.00, pricePerKg:4.5, markupPct:0},
    {id:'m15', name:'Alumínio',    thickness:1,  speed:5500, density:2.70, pricePerKg:3.8, markupPct:0},
    {id:'m16', name:'Alumínio',    thickness:2,  speed:4000, density:2.70, pricePerKg:3.8, markupPct:0},
    {id:'m17', name:'Alumínio',    thickness:3,  speed:3000, density:2.70, pricePerKg:3.8, markupPct:0},
    {id:'m18', name:'Alumínio',    thickness:4,  speed:2000, density:2.70, pricePerKg:3.8, markupPct:0},
    {id:'m19', name:'Alumínio',    thickness:5,  speed:1400, density:2.70, pricePerKg:3.8, markupPct:0},
    {id:'m20', name:'Alumínio',    thickness:6,  speed:1000, density:2.70, pricePerKg:3.8, markupPct:0},
  ];
  LC.DEFAULT_MACHINE = { hourlyRate:45, designRate:30, setupRate:30, pierceTime:0.8, areaBasis:'bbox', defaultSetupMin:5, wasteMarginMm:5, alertQuoteDays:7, alertRealTimeDays:2, angleCutFactor:1.4 };

  LC.DEFAULT_TUBE_PROFILES = [
    {id:'t1', name:'Quadrado 40x40x2mm', perimeterMm:160, speed:4000, pricePerM:3.20, markupPct:0, defaultWastePct:10, barLengthMm:6000},
    {id:'t2', name:'Retangular 60x40x2mm', perimeterMm:200, speed:3500, pricePerM:4.10, markupPct:0, defaultWastePct:10, barLengthMm:6000},
    {id:'t3', name:'Redondo Ø33.7x2mm', perimeterMm:106, speed:4200, pricePerM:2.20, markupPct:0, defaultWastePct:10, barLengthMm:6000},
  ];

  /* ---------------------------------------------------------------- */
  /* STORAGE (Claude artifact storage -> localStorage -> memory only)  */
  /* ---------------------------------------------------------------- */
  let storageMode = 'none'; // 'cloud' | 'local' | 'none'
  if(typeof window.storage !== 'undefined'){
    storageMode = 'cloud';
  } else {
    try{ localStorage.setItem('__lc_test__','1'); localStorage.removeItem('__lc_test__'); storageMode = 'local'; }
    catch(e){ storageMode = 'none'; }
  }
  LC.storageMode = storageMode;

  async function storageGet(key){
    if(storageMode==='cloud'){
      try{ const r = await window.storage.get(key, false); return (r && r.value) ? r.value : null; }
      catch(e){ return null; }
    }
    if(storageMode==='local'){
      try{ return localStorage.getItem(key); }catch(e){ return null; }
    }
    return null;
  }
  async function storageSet(key, value){
    if(storageMode==='cloud'){
      try{ await window.storage.set(key, value, false); }catch(e){}
      return;
    }
    if(storageMode==='local'){
      try{ localStorage.setItem(key, value); }catch(e){}
    }
  }
  LC.storageGet = storageGet;
  LC.storageSet = storageSet;

  LC.loadTubeProfiles = async function(){
    const raw = await storageGet('laser_tube_profiles_v1');
    if(raw){ try{ return JSON.parse(raw); }catch(e){} }
    return JSON.parse(JSON.stringify(LC.DEFAULT_TUBE_PROFILES));
  };
  LC.saveTubeProfiles = async function(list){
    await storageSet('laser_tube_profiles_v1', JSON.stringify(list));
  };

  LC.loadMaterials = async function(){
    const raw = await storageGet('laser_materials_v1');
    if(raw){ try{ return JSON.parse(raw); }catch(e){} }
    return JSON.parse(JSON.stringify(LC.DEFAULT_MATERIALS));
  };
  LC.saveMaterials = async function(list){
    await storageSet('laser_materials_v1', JSON.stringify(list));
  };
  LC.loadMachine = async function(){
    const raw = await storageGet('laser_machine_v1');
    if(raw){ try{ return Object.assign({}, LC.DEFAULT_MACHINE, JSON.parse(raw)); }catch(e){} }
    return Object.assign({}, LC.DEFAULT_MACHINE);
  };
  LC.saveMachine = async function(m){
    await storageSet('laser_machine_v1', JSON.stringify(m));
  };
  LC.loadOrders = async function(){
    const raw = await storageGet('laser_orders_v1');
    if(raw){ try{ const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }catch(e){} }
    return [];
  };
  LC.saveOrders = async function(list){
    await storageSet('laser_orders_v1', JSON.stringify(list));
  };
  LC.loadRemoteConfig = async function(){
    const raw = await storageGet('laser_remote_config_v1');
    if(raw){ try{ const cfg = JSON.parse(raw); if(cfg && cfg.configured) return cfg; }catch(e){} }
    return { configured:false, url:'', key:'' };
  };
  LC.saveRemoteConfig = async function(cfg){
    await storageSet('laser_remote_config_v1', JSON.stringify(cfg));
  };

  /* ---------------------------------------------------------------- */
  /* SESSÃO REMOTA (Supabase Auth) — opcional: se não houver sessão,    */
  /* os pedidos continuam a usar só a anon key, como sempre.           */
  /* ---------------------------------------------------------------- */
  LC.loadRemoteSession = async function(){
    const raw = await storageGet('laser_remote_session_v1');
    if(raw){ try{ return JSON.parse(raw); }catch(e){} }
    return null;
  };
  LC.saveRemoteSession = async function(session){
    await storageSet('laser_remote_session_v1', JSON.stringify(session));
  };
  LC.clearRemoteSession = async function(){
    await storageSet('laser_remote_session_v1', '');
  };
  LC.remoteSignIn = async function(remoteCfg, email, password){
    const res = await fetch(remoteBase(remoteCfg) + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: remoteCfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error_description || data.msg || data.error || ('HTTP ' + res.status));
    const session = {
      access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in||3600)*1000, email: (data.user && data.user.email) || email,
    };
    await LC.saveRemoteSession(session);
    return session;
  };
  LC.remoteSignOut = async function(){
    await LC.clearRemoteSession();
  };
  async function remoteRefreshSession(remoteCfg, session){
    try{
      const res = await fetch(remoteBase(remoteCfg) + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: remoteCfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if(!res.ok) return null;
      const data = await res.json();
      const fresh = {
        access_token: data.access_token, refresh_token: data.refresh_token || session.refresh_token,
        expires_at: Date.now() + (data.expires_in||3600)*1000, email: session.email,
      };
      await LC.saveRemoteSession(fresh);
      return fresh;
    }catch(e){ return null; }
  }
  // Devolve um token de acesso válido (renovando-o se estiver perto de expirar), ou null se
  // não houver sessão iniciada — nesse caso os pedidos caem para a anon key, como acontecia
  // antes de existir login.
  async function remoteEnsureSession(remoteCfg){
    let session = await LC.loadRemoteSession();
    if(!session || !session.refresh_token) return null;
    if(session.expires_at - Date.now() < 60000){
      session = await remoteRefreshSession(remoteCfg, session);
      if(!session){ await LC.clearRemoteSession(); return null; }
    }
    return session.access_token;
  }
  LC.remoteEnsureSession = remoteEnsureSession;

  /* ---------------------------------------------------------------- */
  /* REMOTE (Supabase REST) — all functions take remoteCfg explicitly  */
  /* ---------------------------------------------------------------- */
  function remoteBase(remoteCfg){ return remoteCfg.url.replace(/\/$/, ''); }
  async function remoteHeaders(remoteCfg, extra){
    const token = (await remoteEnsureSession(remoteCfg)) || remoteCfg.key;
    return Object.assign({ apikey: remoteCfg.key, Authorization: 'Bearer ' + token }, extra || {});
  }
  function orderToRow(o){
    return {
      id: o.id, client: o.client || null, order_name: o.orderName || null, order_number: o.orderNumber || null,
      created_at: o.createdAt || new Date().toISOString(),
      mode: o.mode, dxf_file_name: o.dxfFileName || null, dxf_text: o.dxfText || null, manual: o.manual || null,
      material_id: o.materialId || null, material_snapshot: o.materialSnapshot || null, quantity: o.quantity || 1,
      machine_snapshot: o.machineSnapshot || null, cost_snapshot: o.costSnapshot || null,
      comments: o.comments || null,
      client_ref: o.clientRef || null,
      order_state: o.orderState || null,
      piece_type: o.pieceType || 'sheet',
      was_quoted: o.wasQuoted || false,
      tube_inputs: o.tubeInputs || null,
    };
  }
  function rowToOrder(r){
    return {
      id: r.id, client: r.client, orderName: r.order_name, orderNumber: r.order_number, createdAt: r.created_at, mode: r.mode,
      dxfFileName: r.dxf_file_name, dxfText: r.dxf_text, manual: r.manual, materialId: r.material_id,
      materialSnapshot: r.material_snapshot, quantity: r.quantity, machineSnapshot: r.machine_snapshot, costSnapshot: r.cost_snapshot,
      comments: r.comments,
      clientRef: r.client_ref,
      orderState: r.order_state,
      pieceType: r.piece_type || 'sheet',
      wasQuoted: r.was_quoted || false,
      tubeInputs: r.tube_inputs,
    };
  }
  async function remoteRequestError(res){
    let msg = '';
    try{ const j = await res.json(); msg = j.message || j.hint || ''; }catch(e){}
    return new Error('HTTP ' + res.status + (msg ? (' — ' + msg) : ''));
  }
  // Campos usados pelas páginas que só mostram tabelas/listagens — deliberadamente sem
  // dxf_text, que pode ser um ficheiro DXF inteiro em texto e não serve para nada numa lista.
  const ORDERS_LIST_FIELDS = 'id,client,order_name,order_number,created_at,mode,dxf_file_name,manual,material_id,material_snapshot,quantity,machine_snapshot,cost_snapshot,comments,client_ref,order_state,piece_type,was_quoted,tube_inputs';
  LC.remoteLoadOrders = async function(remoteCfg, opts){
    const fields = (opts && opts.light) ? ORDERS_LIST_FIELDS : '*';
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?select=' + fields + '&order=created_at.desc', { headers: await remoteHeaders(remoteCfg) });
    if(!res.ok) throw await remoteRequestError(res);
    const rows = await res.json();
    return rows.map(rowToOrder);
  };
  LC.remoteLoadOrderById = async function(remoteCfg, id){
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?select=*&id=eq.' + encodeURIComponent(id), { headers: await remoteHeaders(remoteCfg) });
    if(!res.ok) throw await remoteRequestError(res);
    const rows = await res.json();
    return rows.length ? rowToOrder(rows[0]) : null;
  };
  LC.remoteInsertOrder = async function(remoteCfg, rec){
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders', {
      method: 'POST',
      headers: await remoteHeaders(remoteCfg, { 'Content-Type':'application/json', Prefer:'return=minimal' }),
      body: JSON.stringify(orderToRow(rec)),
    });
    if(!res.ok) throw await remoteRequestError(res);
  };
  LC.remoteUpdateFullOrder = async function(remoteCfg, id, rec){
    const row = orderToRow(rec);
    delete row.id;
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: await remoteHeaders(remoteCfg, { 'Content-Type':'application/json', Prefer:'return=minimal' }),
      body: JSON.stringify(row),
    });
    if(!res.ok) throw await remoteRequestError(res);
  };
  LC.remoteDeleteOrder = async function(remoteCfg, id){
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE', headers: await remoteHeaders(remoteCfg),
    });
    if(!res.ok) throw await remoteRequestError(res);
  };
  LC.testRemoteConnection = async function(url, key){
    const base = url.replace(/\/$/, '');
    const res = await fetch(base + '/rest/v1/orders?select=id&limit=1', {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
    if(!res.ok) throw await remoteRequestError(res);
  };

  /* ---------------------------------------------------------------- */
  /* SEQUENTIAL ORDER NUMBER (Encomenda AAAA_NNNN)                     */
  /* ---------------------------------------------------------------- */
  LC.computeNextOrderNumber = async function(remoteCfg, ordersList){
    const year = new Date().getFullYear();
    let maxSeq = 0;
    const scan = (list) => {
      (list||[]).forEach(o=>{
        const m = /^(\d{4})_(\d+)$/.exec((o && (o.orderNumber || o.order_number)) || '');
        if(m && parseInt(m[1],10)===year) maxSeq = Math.max(maxSeq, parseInt(m[2],10));
      });
    };
    if(remoteCfg && remoteCfg.configured){
      try{
        const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?select=order_number&order_number=like.' + year + '_*', { headers: await remoteHeaders(remoteCfg) });
        if(res.ok) scan(await res.json());
      }catch(e){ /* fall back to whatever is already loaded locally */ }
    }
    scan(ordersList);
    return year + '_' + String(maxSeq+1).padStart(5,'0');
  };

  /* ---------------------------------------------------------------- */
  /* PRECISÃO DAS ESTIMATIVAS — compara tempo estimado vs tempo real,   */
  /* agrupado por material/espessura, para ajudar a calibrar a tabela.  */
  /* ---------------------------------------------------------------- */
  LC.summarizeAccuracy = function(orders, materials, tubeProfiles){
    // Depois de se afinar a velocidade de um material/perfil, as encomendas anteriores deixam de
    // contar: foram estimadas com a velocidade antiga e voltariam a sugerir a mesma correção.
    const calibratedAt = {};
    (materials||[]).forEach(m=>{ if(m.speedCalibratedAt) calibratedAt[m.id] = new Date(m.speedCalibratedAt).getTime(); });
    (tubeProfiles||[]).forEach(p=>{ if(p.speedCalibratedAt) calibratedAt[p.id] = new Date(p.speedCalibratedAt).getTime(); });
    const groups = {};
    (orders||[]).forEach(o=>{
      const cs = o.costSnapshot;
      if(!cs || !cs.isFinal) return;
      if(cs.estimadoCuttingTimeMin==null || !isFinite(cs.estimadoCuttingTimeMin)) return;
      if(!isFinite(cs.cuttingTimeMin)) return;
      if(cs.estimadoCuttingTimeMin <= 0) return; // avoid divide-by-zero on the deviation %
      const cal = o.materialId ? calibratedAt[o.materialId] : null;
      if(cal && o.createdAt && new Date(o.createdAt).getTime() <= cal) return;
      const isTube = o.pieceType === 'tube';
      const ms = o.materialSnapshot;
      const key = ms ? (isTube ? ms.name : (ms.name + ' — ' + ms.thickness + 'mm')) : 'Material desconhecido';
      if(!groups[key]) groups[key] = { key, pieceType: isTube?'tube':'sheet', materialId:o.materialId||null, calibratedAt: (o.materialId ? calibratedAt[o.materialId] : null) || null, count:0, sumEstimado:0, sumReal:0, sumDeviationPct:0 };
      const g = groups[key];
      g.count++;
      g.sumEstimado += cs.estimadoCuttingTimeMin;
      g.sumReal += cs.cuttingTimeMin;
      g.sumDeviationPct += ((cs.cuttingTimeMin - cs.estimadoCuttingTimeMin) / cs.estimadoCuttingTimeMin) * 100;
    });
    return Object.values(groups).map(g => ({
      key: g.key,
      pieceType: g.pieceType,
      materialId: g.materialId,
      calibratedAt: g.calibratedAt,
      count: g.count,
      avgEstimado: g.sumEstimado / g.count,
      avgReal: g.sumReal / g.count,
      avgDeviationPct: g.sumDeviationPct / g.count,
    })).sort((a,b) => b.count - a.count);
  };

  /* ---------------------------------------------------------------- */
  /* FINAL COST — recompute from the real cutting time reported after  */
  /* the piece was actually cut. Recalcula sempre material, taxas e margem com os valores ATUAIS   */
  /* das Definições (só o tempo de corte fica fixo) — usa a geometria em bruto gravada com a       */
  /* encomenda para o conseguir fazer do zero. Encomendas antigas sem essa geometria (gravadas      */
  /* antes desta versão) caem no método anterior, que reaproveita os valores da cotação original.   */
  /* ---------------------------------------------------------------- */
  LC.recomputeFinalCost = async function(rec, realCuttingTimeMin){
    const cs = rec.costSnapshot || {};
    const geoSnap = cs.geoSnapshot;
    const qty = rec.quantity || 1;

    // O material não muda ao registar o tempo real — só o custo de corte muda. Por isso o custo
    // real e a margem só precisam de um ajuste (delta), não de um recálculo do zero: evita ficarem
    // presos no valor de quando a encomenda ainda era estimativa.
    function withMarginFields(base, corteCost, totalCost){
      if(cs.realCost != null && isFinite(cs.corteCost)){
        const realCost = cs.realCost - cs.corteCost + corteCost;
        const marginValue = totalCost - realCost;
        const marginPct = realCost > 0 ? (marginValue/realCost)*100 : null;
        return Object.assign(base, { realCost, marginValue, marginPct });
      }
      return base;
    }

    if(geoSnap && geoSnap.perimeterMm){
      try{
        const materials = await LC.loadMaterials();
        const machine = await LC.loadMachine();
        const material = materials.find(m => m.id === rec.materialId);
        if(material){
          const hourlyRate = machine.hourlyRate || 0;
          // O tempo real introduzido é sempre o TOTAL da encomenda (todas as peças, já inclui
          // perfurações) — não se soma nem se multiplica mais nada a este tempo.
          const corteCost = (realCuttingTimeMin/60) * hourlyRate;

          const marginMm = machine.wasteMarginMm || 0;
          let areaMm2;
          if(machine.areaBasis==='net'){
            areaMm2 = geoSnap.netAreaMm2 || 0;
          } else if(geoSnap.widthMm!=null && geoSnap.heightMm!=null){
            areaMm2 = (geoSnap.widthMm+marginMm) * (geoSnap.heightMm+marginMm);
          } else {
            areaMm2 = geoSnap.netAreaMm2 || 0;
          }
          const areaM2 = areaMm2/1e6;
          const weightPerPiece = areaM2 * (material.thickness||0) * (material.density||0);
          const weightTotal = weightPerPiece * qty;
          const effectivePricePerKg = (material.pricePerKg||0) * (1 + (material.markupPct||0)/100);
          const materialCost = weightPerPiece * effectivePricePerKg; // por peça

          const si = cs.setupInputs || {};
          const designTimeMin = si.designTimeMin || 0;
          const setupTimeMin = si.setupTimeMin || 0;
          const designCost = (designTimeMin/60) * (machine.designRate||0);
          const setupCost = (setupTimeMin/60) * (machine.setupRate||0);
          const preCorteCost = designCost + setupCost;

          // corteCost já é total; materialCost é por peça, por isso só este é vezes qty aqui.
          const adj = cs.adjustmentValue || 0;
          const totalCost = corteCost + materialCost*qty + preCorteCost + adj;
          const avgPerPiece = totalCost / qty;

          return Object.assign({}, cs, withMarginFields({
            cuttingTimeMin: realCuttingTimeMin,
            corteCost, materialCost, weightPerPiece, weightTotal,
            designCost, setupCost, preCorteCost,
            totalCost, avgPerPiece,
            isFinal: true,
          }, corteCost, totalCost));
        }
        // material desta encomenda já não existe na tabela — cai para o método antigo abaixo
      }catch(e){ /* falha a ir buscar materiais/máquina atuais — cai para o método antigo abaixo */ }
    }

    // Método antigo (encomendas sem geometria gravada — incluindo TODAS as de tubo, ou material
    // entretanto removido): reaproveita os valores tal como estavam na cotação original.
    const ms = rec.machineSnapshot || {};
    const hourlyRate = ms.hourlyRate || 0;
    const materialCost = cs.materialCost || 0; // por peça
    const preCorteCost = cs.preCorteCost || 0;
    const corteCost = (realCuttingTimeMin/60) * hourlyRate;
    const totalCost = corteCost + materialCost*qty + preCorteCost + (cs.adjustmentValue||0);
    const avgPerPiece = totalCost / qty;
    return Object.assign({}, cs, withMarginFields({
      cuttingTimeMin: realCuttingTimeMin,
      corteCost, totalCost, avgPerPiece,
      isFinal: true,
    }, corteCost, totalCost));
  };

  /* ---------------------------------------------------------------- */
  /* LOCAL FOLDER (File System Access API — Chrome/Edge desktop only)  */
  /* ---------------------------------------------------------------- */
  const HANDLE_DB_NAME = 'laser_calc_handles', HANDLE_STORE = 'handles';
  function openHandleDB(){
    return new Promise((resolve, reject)=>{
      const req = indexedDB.open(HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(HANDLE_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  LC.idbSet = async function(key, value){
    const db = await openHandleDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };
  LC.idbGet = async function(key){
    const db = await openHandleDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  LC.idbDelete = async function(key){
    const db = await openHandleDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  LC.buildSummaryText = function(rec){
    const fmtEUR = LC.fmtEUR, fmtNum = LC.fmtNum;
    const lines = [];
    lines.push('ENCOMENDA ' + (rec.orderNumber || ''));
    lines.push('='.repeat(30));
    lines.push('Nome: ' + (rec.orderName || '—'));
    lines.push('Cliente: ' + (rec.client || '—'));
    lines.push('Data: ' + (rec.createdAt ? new Date(rec.createdAt).toLocaleString('pt-PT') : '—'));
    lines.push('');
    lines.push('Material: ' + (rec.materialSnapshot ? (rec.materialSnapshot.name + ' — ' + rec.materialSnapshot.thickness + ' mm') : '—'));
    lines.push('Quantidade: ' + (rec.quantity || 1));
    if(rec.costSnapshot && rec.costSnapshot.weightPerPiece > 0){
      lines.push('Peso unitário (1 peça): ' + fmtNum(rec.costSnapshot.weightPerPiece,2) + ' kg');
      lines.push('Peso total: ' + fmtNum(rec.costSnapshot.weightTotal,2) + ' kg');
    }
    if(rec.dxfFileName) lines.push('Ficheiro DXF original: ' + rec.dxfFileName);
    if(rec.manual) lines.push('Forma manual: ' + JSON.stringify(rec.manual));
    lines.push('');
    if(rec.costSnapshot){
      lines.push('Custos no momento de gravação (' + (rec.costSnapshot.isFinal ? 'FINAL' : 'estimado') + '):');
      lines.push('  Custo total do material: ' + fmtEUR(rec.costSnapshot.materialCost * (rec.quantity||1)));
      lines.push('  Custo pré-corte (desenho + setup): ' + fmtEUR(rec.costSnapshot.preCorteCost));
      if(rec.costSnapshot.setupInputs){
        const si = rec.costSnapshot.setupInputs;
        const drawLabel = {client_direct:'Desenho do cliente', client_convert:'Conversão de desenho', from_scratch:'Desenho de raiz'}[si.drawingType] || si.drawingType;
        lines.push('    · Desenho: ' + drawLabel + (si.designTimeMin ? ' — ' + si.designTimeMin + ' min (' + fmtEUR(rec.costSnapshot.designCost) + ')' : ''));
        lines.push('    · Setup: ' + si.setupTimeMin + ' min (' + fmtEUR(rec.costSnapshot.setupCost) + ')');
      }
      lines.push('  Custo total do corte: ' + fmtEUR(rec.costSnapshot.corteCost) + ' (' + fmtNum(rec.costSnapshot.cuttingTimeMin,1) + ' min no total, todas as peças, inclui perfurações)');
      lines.push('  TOTAL da encomenda (sem IVA): ' + fmtEUR(rec.costSnapshot.totalCost));
      lines.push('  TOTAL ÷ nº peças (sem IVA): ' + fmtEUR(rec.costSnapshot.avgPerPiece));
    }
    return lines.join('\n');
  };

  LC.writeOrderToLocalFolder = async function(dirHandle, rec){
    if(!dirHandle) return { skipped:true };
    try{
      const clientDir = await dirHandle.getDirectoryHandle(LC.sanitizeFileName(rec.client || 'Sem cliente'), {create:true});
      const baseName = LC.sanitizeFileName((rec.orderNumber ? ('[' + rec.orderNumber + '] ') : '') + (rec.orderName || 'encomenda'));
      if(rec.mode==='dxf' && rec.dxfText){
        const dxfHandle = await clientDir.getFileHandle(baseName + '.dxf', {create:true});
        const w = await dxfHandle.createWritable();
        await w.write(rec.dxfText);
        await w.close();
      }
      const txtHandle = await clientDir.getFileHandle(baseName + ' - resumo.txt', {create:true});
      const w2 = await txtHandle.createWritable();
      await w2.write(LC.buildSummaryText(rec));
      await w2.close();
      return { ok:true };
    }catch(err){
      return { ok:false, error: err.message };
    }
  };

  /* ---------------------------------------------------------------- */
  /* SERVICE WORKER REGISTRATION + UPDATE TOAST (shared across pages)  */
  /* ---------------------------------------------------------------- */
  function showUpdateToast(){
    if(document.getElementById('updateToast')) return;
    const div = document.createElement('div');
    div.id = 'updateToast';
    div.className = 'update-toast';
    div.innerHTML = 'Há uma versão nova desta app. <button id="updateReloadBtn" type="button">Atualizar agora</button>';
    document.body.appendChild(div);
    document.getElementById('updateReloadBtn').addEventListener('click', ()=> window.location.reload());
  }
  LC.registerServiceWorker = function(){
    if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost')){
      window.addEventListener('load', ()=>{
        navigator.serviceWorker.register('sw.js').then(reg=>{
          reg.addEventListener('updatefound', ()=>{
            const nw = reg.installing;
            if(!nw) return;
            nw.addEventListener('statechange', ()=>{
              if(nw.state==='installed' && navigator.serviceWorker.controller) showUpdateToast();
            });
          });
        }).catch(()=>{ /* offline install not available on this host, app still works normally */ });
      });
    }
  };

  LC.ORDER_STATES = {
    quote:      { label:'Orçamentado', cls:'state-quote' },
    production: { label:'Em produção', cls:'state-production' },
    done:       { label:'Concluído',   cls:'state-done' },
    cancelled:  { label:'Cancelada',   cls:'state-cancelled' },
  };
  LC.stateBadgeHTML = function(orderState){
    const st = LC.ORDER_STATES[orderState || 'production'] || LC.ORDER_STATES.production;
    return '<span class="state-badge ' + st.cls + '">' + st.label + '</span>';
  };

  /* ---------------------------------------------------------------- */
  /* SEMANA (segunda a domingo) e RESUMO SEMANAL                        */
  /* ---------------------------------------------------------------- */
  LC.weekBounds = function(ref){
    const d = ref ? new Date(ref) : new Date();
    const day = (d.getDay() + 6) % 7;            // 0 = segunda
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    return { start, end };
  };

  LC.summarizeWeek = function(orders, ref){
    const { start, end } = LC.weekBounds(ref);
    const inWeek = (orders||[]).filter(o=>{
      if(o.orderState === 'cancelled' || !o.createdAt) return false;
      const d = new Date(o.createdAt);
      return d >= start && d < end;
    });

    const byMaterial = {}, byClient = {};
    let cuttingMin = 0;
    inWeek.forEach(o=>{
      const cs = o.costSnapshot, ms = o.materialSnapshot;
      if(ms){
        const k = ms.name + ' ' + ms.thickness + 'mm';
        byMaterial[k] = (byMaterial[k]||0) + 1;
      }
      const c = (o.client||'').trim();
      if(c){
        if(!byClient[c]) byClient[c] = { count:0, value:0 };
        byClient[c].count++;
        byClient[c].value += cs ? (cs.totalCost||0) : 0;
      }
      if(cs && isFinite(cs.cuttingTimeMin)) cuttingMin += cs.cuttingTimeMin;
    });

    const topMaterial = Object.entries(byMaterial).sort((a,b)=>b[1]-a[1])[0] || null;
    const topClient = Object.entries(byClient).sort((a,b)=>b[1].count-a[1].count)[0] || null;

    // semana anterior, só para comparar a contagem
    const prevRef = new Date(start); prevRef.setDate(prevRef.getDate() - 1);
    const pb = LC.weekBounds(prevRef);
    const prevCount = (orders||[]).filter(o=>{
      if(o.orderState === 'cancelled' || !o.createdAt) return false;
      const d = new Date(o.createdAt);
      return d >= pb.start && d < pb.end;
    }).length;

    return {
      start, end, count: inWeek.length, prevCount, cuttingMin,
      topMaterial: topMaterial ? { name: topMaterial[0], count: topMaterial[1] } : null,
      topClient: topClient ? { name: topClient[0], count: topClient[1].count, value: topClient[1].value } : null,
    };
  };

  /* ---------------------------------------------------------------- */
  /* ALERTAS                                                            */
  /* ---------------------------------------------------------------- */
  LC.buildAlerts = function(orders, machine, accuracy){
    const alerts = [];
    const now = Date.now();
    const dayMs = 86400000;
    const quoteDays = machine.alertQuoteDays ?? 7;
    const realDays = machine.alertRealTimeDays ?? 2;

    const staleQuotes = (orders||[]).filter(o=>
      o.orderState === 'quote' && o.createdAt &&
      (now - new Date(o.createdAt).getTime()) > quoteDays*dayMs);
    if(staleQuotes.length){
      alerts.push({
        kind:'warning', title:'Orçamentos parados',
        detail: staleQuotes.length + (staleQuotes.length===1?' sem resposta há +':' sem resposta há +') + quoteDays + ' dias',
        action:'Ver lista', href:'encomendas.html?filter=quote',
      });
    }

    const missingTime = (orders||[]).filter(o=>
      (o.orderState||'production') === 'production' && o.createdAt &&
      o.costSnapshot && !o.costSnapshot.isFinal &&
      (now - new Date(o.createdAt).getTime()) > realDays*dayMs);
    if(missingTime.length){
      alerts.push({
        kind:'danger', title:'Tempo real em falta',
        detail: missingTime.length + (missingTime.length===1?' peça em produção há +':' peças em produção há +') + realDays + ' dias',
        action:'Registar', href:'encomendas.html',
      });
    }

    // Lembrete de cópia de segurança — só faz sentido depois de haver dados que valha a pena
    // guardar, e não incomoda logo no início (instalação nova, poucas encomendas).
    const backupDays = machine.alertBackupDays ?? 14;
    const liveOrders = (orders||[]).filter(o=>o.orderState!=='cancelled');
    if(liveOrders.length >= 5){
      let lastBackup = null;
      try{ lastBackup = localStorage.getItem('laser_last_backup'); }catch(e){}
      const daysSince = lastBackup ? Math.floor((now - new Date(lastBackup).getTime())/dayMs) : null;
      if(daysSince === null || daysSince > backupDays){
        alerts.push({
          kind:'warning', title:'Cópia de segurança',
          detail: daysSince===null ? 'Nunca exportou as encomendas' : ('Última cópia há ' + daysSince + ' dias'),
          action:'Exportar', href:'encomendas.html',
        });
      }
    }

    (accuracy||[]).forEach(row=>{
      if(row.count >= 5 && Math.abs(row.avgDeviationPct) >= 3 && row.materialId){
        alerts.push({
          kind:'accent', title:'Velocidade a afinar',
          detail: row.key + ' · ' + (row.avgDeviationPct>=0?'+':'') + Math.round(row.avgDeviationPct) + '%',
          action:'Afinar', href:'definicoes.html',
        });
      }
    });

    return alerts;
  };

  /* ---------------------------------------------------------------- */
  /* CONVERSÃO DE ORÇAMENTOS                                            */
  /* Quantos orçamentos do período acabaram em produção/concluídos,      */
  /* contra os que ficaram parados ou foram cancelados.                 */
  /* ---------------------------------------------------------------- */
  LC.summarizeConversion = function(orders, sinceDate){
    const since = sinceDate ? new Date(sinceDate).getTime() : 0;
    let won = 0, lost = 0, open = 0;
    (orders||[]).forEach(o=>{
      // Só entram encomendas que estiveram mesmo em orçamento nalgum momento — trabalho que
      // foi direto para produção nunca foi "convertido", não pertence a esta conta.
      if(!o.wasQuoted && o.orderState !== 'quote') return;
      if(!o.createdAt || new Date(o.createdAt).getTime() < since) return;
      const st = o.orderState || 'production';
      if(st === 'production' || st === 'done') won++;
      else if(st === 'cancelled') lost++;
      else if(st === 'quote') open++;
    });
    const decided = won + lost;
    return { won, lost, open, decided, pct: decided ? (won/decided)*100 : null };
  };

  /* Precisão global dos tempos: desvio médio entre real e estimado.     */
  LC.overallAccuracy = function(accuracyRows){
    let n = 0, sum = 0;
    (accuracyRows||[]).forEach(r=>{ n += r.count; sum += r.avgDeviationPct * r.count; });
    return n ? { count:n, avgDeviationPct: sum/n } : null;
  };

  /* ---------------------------------------------------------------- */
  /* MODO CLARO / ESCURO                                               */
  /* Aplicado já no <head> de cada página (evita o "flash" errado);    */
  /* isto só liga o botão do menu e mantém a etiqueta em sincronia.    */
  /* ---------------------------------------------------------------- */
  (function initThemeToggle(){
    const btn = document.getElementById('themeToggleBtn');
    if(!btn) return;
    const label = document.getElementById('themeToggleLabel');
    function sync(){
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if(label) label.textContent = isLight ? 'Modo escuro' : 'Modo claro';
    }
    sync();
    btn.addEventListener('click', ()=>{
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try{ localStorage.setItem('laser_theme', next); }catch(e){}
      sync();
    });
  })();

  /* ---------------------------------------------------------------- */
  /* MODAL DE CONFIRMAÇÃO / AVISO — substitui confirm()/alert() nativos */
  /* para manter o estilo customizado da app em ações destrutivas.     */
  /* ---------------------------------------------------------------- */
  function buildModalOverlay(){
    let overlay = document.getElementById('lcModalOverlay');
    if(overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'lcModalOverlay';
    overlay.className = 'lc-modal-overlay';
    overlay.innerHTML = '<div class="lc-modal" role="alertdialog" aria-modal="true">' +
      '<p class="lc-modal-msg"></p><div class="lc-modal-actions"></div></div>';
    document.body.appendChild(overlay);
    return overlay;
  }
  function openModal(message, buttons){
    return new Promise(resolve=>{
      const overlay = buildModalOverlay();
      overlay.querySelector('.lc-modal-msg').textContent = message;
      const actions = overlay.querySelector('.lc-modal-actions');
      actions.innerHTML = '';
      let focusEl = null;
      function close(result){
        overlay.classList.remove('open');
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onKey(e){
        if(e.key==='Escape') close(buttons.escResult);
      }
      buttons.items.forEach(b=>{
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost-btn' + (b.cls ? ' '+b.cls : '');
        btn.textContent = b.label;
        btn.addEventListener('click', ()=>close(b.result), {once:true});
        actions.appendChild(btn);
        if(b.autofocus) focusEl = btn;
      });
      document.addEventListener('keydown', onKey);
      overlay.classList.add('open');
      if(focusEl) focusEl.focus();
    });
  }
  LC.showConfirm = function(message, opts){
    opts = opts || {};
    return openModal(message, {
      escResult: false,
      items: [
        { label: opts.cancelLabel || 'Cancelar', result:false },
        { label: opts.okLabel || 'Confirmar', result:true, cls: opts.danger ? 'danger' : 'accent', autofocus:true },
      ],
    });
  };
  LC.showAlert = function(message){
    return openModal(message, {
      escResult: undefined,
      items: [ { label:'OK', result:undefined, cls:'accent', autofocus:true } ],
    });
  };

  window.LC = LC;
})();
