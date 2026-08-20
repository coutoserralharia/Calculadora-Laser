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

    const allPoints = contours.reduce((acc,c)=>acc.concat(c.points), []);
    const xs=allPoints.map(p=>p.x), ys=allPoints.map(p=>p.y);
    const bbox = allPoints.length ? { minX:Math.min.apply(null,xs), maxX:Math.max.apply(null,xs), minY:Math.min.apply(null,ys), maxY:Math.max.apply(null,ys) } : null;

    return {
      contours,
      warnings: Array.from(warnings),
      totalLength: contours.reduce((s,c)=>s+c.length,0),
      bbox,
      closedContours: contours.filter(c=>c.closed),
      openContours: contours.filter(c=>!c.closed),
    };
  }
  LC.parseDXF = parseDXF;

  /* ---------------------------------------------------------------- */
  /* DEFAULTS                                                          */
  /* ---------------------------------------------------------------- */
  LC.DEFAULT_MATERIALS = [
    {id:'m1',  name:'Aço Carbono', thickness:1,  speed:6000, price:9,  density:7.85, pricePerKg:1.3},
    {id:'m2',  name:'Aço Carbono', thickness:2,  speed:4500, price:12, density:7.85, pricePerKg:1.3},
    {id:'m3',  name:'Aço Carbono', thickness:3,  speed:3500, price:15, density:7.85, pricePerKg:1.3},
    {id:'m4',  name:'Aço Carbono', thickness:4,  speed:2500, price:19, density:7.85, pricePerKg:1.3},
    {id:'m5',  name:'Aço Carbono', thickness:5,  speed:1800, price:23, density:7.85, pricePerKg:1.3},
    {id:'m6',  name:'Aço Carbono', thickness:6,  speed:1400, price:27, density:7.85, pricePerKg:1.3},
    {id:'m7',  name:'Aço Carbono', thickness:8,  speed:900,  price:35, density:7.85, pricePerKg:1.3},
    {id:'m8',  name:'Aço Carbono', thickness:10, speed:650,  price:44, density:7.85, pricePerKg:1.3},
    {id:'m9',  name:'Aço Inox',    thickness:1,  speed:5000, price:16, density:8.00, pricePerKg:4.5},
    {id:'m10', name:'Aço Inox',    thickness:2,  speed:3500, price:22, density:8.00, pricePerKg:4.5},
    {id:'m11', name:'Aço Inox',    thickness:3,  speed:2200, price:29, density:8.00, pricePerKg:4.5},
    {id:'m12', name:'Aço Inox',    thickness:4,  speed:1500, price:37, density:8.00, pricePerKg:4.5},
    {id:'m13', name:'Aço Inox',    thickness:5,  speed:1000, price:45, density:8.00, pricePerKg:4.5},
    {id:'m14', name:'Aço Inox',    thickness:6,  speed:700,  price:54, density:8.00, pricePerKg:4.5},
    {id:'m15', name:'Alumínio',    thickness:1,  speed:5500, price:11, density:2.70, pricePerKg:3.8},
    {id:'m16', name:'Alumínio',    thickness:2,  speed:4000, price:15, density:2.70, pricePerKg:3.8},
    {id:'m17', name:'Alumínio',    thickness:3,  speed:3000, price:19, density:2.70, pricePerKg:3.8},
    {id:'m18', name:'Alumínio',    thickness:4,  speed:2000, price:24, density:2.70, pricePerKg:3.8},
    {id:'m19', name:'Alumínio',    thickness:5,  speed:1400, price:29, density:2.70, pricePerKg:3.8},
    {id:'m20', name:'Alumínio',    thickness:6,  speed:1000, price:35, density:2.70, pricePerKg:3.8},
  ];
  LC.DEFAULT_MACHINE = { hourlyRate:45, designRate:30, pierceTime:0.8, margin:0, areaBasis:'bbox', materialCostMode:'area', defaultMaterialLoadMin:5, defaultMachineTuneMin:5 };

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
  /* REMOTE (Supabase REST) — all functions take remoteCfg explicitly  */
  /* ---------------------------------------------------------------- */
  function remoteBase(remoteCfg){ return remoteCfg.url.replace(/\/$/, ''); }
  function remoteHeaders(remoteCfg, extra){
    return Object.assign({ apikey: remoteCfg.key, Authorization: 'Bearer ' + remoteCfg.key }, extra || {});
  }
  function orderToRow(o){
    return {
      id: o.id, client: o.client || null, order_name: o.orderName || null, order_number: o.orderNumber || null,
      created_at: o.createdAt || new Date().toISOString(),
      mode: o.mode, dxf_file_name: o.dxfFileName || null, dxf_text: o.dxfText || null, manual: o.manual || null,
      material_id: o.materialId || null, material_snapshot: o.materialSnapshot || null, quantity: o.quantity || 1,
      machine_snapshot: o.machineSnapshot || null, cost_snapshot: o.costSnapshot || null,
    };
  }
  function rowToOrder(r){
    return {
      id: r.id, client: r.client, orderName: r.order_name, orderNumber: r.order_number, createdAt: r.created_at, mode: r.mode,
      dxfFileName: r.dxf_file_name, dxfText: r.dxf_text, manual: r.manual, materialId: r.material_id,
      materialSnapshot: r.material_snapshot, quantity: r.quantity, machineSnapshot: r.machine_snapshot, costSnapshot: r.cost_snapshot,
    };
  }
  async function remoteRequestError(res){
    let msg = '';
    try{ const j = await res.json(); msg = j.message || j.hint || ''; }catch(e){}
    return new Error('HTTP ' + res.status + (msg ? (' — ' + msg) : ''));
  }
  LC.remoteLoadOrders = async function(remoteCfg){
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?select=*&order=created_at.desc', { headers: remoteHeaders(remoteCfg) });
    if(!res.ok) throw await remoteRequestError(res);
    const rows = await res.json();
    return rows.map(rowToOrder);
  };
  LC.remoteInsertOrder = async function(remoteCfg, rec){
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders', {
      method: 'POST',
      headers: remoteHeaders(remoteCfg, { 'Content-Type':'application/json', Prefer:'return=minimal' }),
      body: JSON.stringify(orderToRow(rec)),
    });
    if(!res.ok) throw await remoteRequestError(res);
  };
  LC.remoteDeleteOrder = async function(remoteCfg, id){
    const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE', headers: remoteHeaders(remoteCfg),
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
        const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?select=order_number&order_number=like.' + year + '_*', { headers: remoteHeaders(remoteCfg) });
        if(res.ok) scan(await res.json());
      }catch(e){ /* fall back to whatever is already loaded locally */ }
    }
    scan(ordersList);
    return year + '_' + String(maxSeq+1).padStart(4,'0');
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
    if(rec.costSnapshot && rec.costSnapshot.weightKg > 0) lines.push('Peso estimado: ' + fmtNum(rec.costSnapshot.weightKg,2) + ' kg');
    if(rec.dxfFileName) lines.push('Ficheiro DXF original: ' + rec.dxfFileName);
    if(rec.manual) lines.push('Forma manual: ' + JSON.stringify(rec.manual));
    lines.push('');
    if(rec.costSnapshot){
      lines.push('Custos no momento de gravação:');
      lines.push('  Tempo de corte: ' + fmtNum(rec.costSnapshot.cuttingTimeMin,2) + ' min');
      lines.push('  Custo de corte: ' + fmtEUR(rec.costSnapshot.cuttingCost));
      lines.push('  Nº de perfurações: ' + (rec.costSnapshot.pierces ?? '—') + ' (' + fmtEUR(rec.costSnapshot.pierceCostTotal) + ')');
      lines.push('  Custo material: ' + fmtEUR(rec.costSnapshot.materialCost));
      lines.push('  Custo setup: ' + fmtEUR(rec.costSnapshot.setupCost));
      if(rec.costSnapshot.setupInputs){
        const si = rec.costSnapshot.setupInputs;
        const drawLabel = {client_direct:'Desenho do cliente', client_convert:'Conversão de desenho', from_scratch:'Desenho de raiz'}[si.drawingType] || si.drawingType;
        lines.push('    · Desenho: ' + drawLabel + (si.designTimeMin ? ' — ' + si.designTimeMin + ' min (' + fmtEUR(rec.costSnapshot.designCost) + ')' : ''));
        lines.push('    · Colocação de material: ' + si.materialLoadMin + ' min');
        lines.push('    · Afinação da máquina: ' + si.machineTuneMin + ' min');
      }
      lines.push('  Preço por peça: ' + fmtEUR(rec.costSnapshot.perPartCost));
      lines.push('  TOTAL: ' + fmtEUR(rec.costSnapshot.totalCost));
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

  window.LC = LC;
})();
