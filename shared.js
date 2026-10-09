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
  // Para pesquisa/comparação de texto sem distinguir acentos nem maiúsculas — "Zé" e "Ze"
  // devem contar como o mesmo nome de cliente.
  LC.searchKey = s => Array.from(String(s||'').normalize('NFD'))
    .filter(ch => { const c = ch.codePointAt(0); return c < 0x0300 || c > 0x036f; }) // remove marcas de acentuação (combining diacritics)
    .join('').toLowerCase();

  // Clientes: o mesmo cliente escrito com outras maiúsculas/minúsculas ou acentos conta como um
  // só. knownClients devolve um nome por cliente (a 1ª forma gravada); canonicalClient devolve o
  // nome já existente para o que foi escrito (ou o escrito, se for um cliente novo) — usado ao
  // gravar, para as encomendas não ficarem espalhadas por "clientes" diferentes.
  // skipId: a encomenda que está a ser gravada não conta como "já existente".
  LC.knownClients = function(orders, skipId){
    const seen = new Map();
    (orders||[]).forEach(o=>{
      if(!o || (skipId && o.id === skipId)) return;
      const n = (o.client||'').trim();
      if(!n) return;
      const k = LC.searchKey(n);
      if(!seen.has(k)) seen.set(k, n);
    });
    return Array.from(seen.values()).sort((a,b)=>a.localeCompare(b,'pt'));
  };
  LC.canonicalClient = function(name, orders, skipId){
    const typed = String(name||'').trim().replace(/\s+/g,' ');
    if(!typed) return '';
    const k = LC.searchKey(typed);
    return LC.knownClients(orders, skipId).find(n=>LC.searchKey(n)===k) || typed;
  };

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

    // Unidades do desenho ($INSUNITS no HEADER) — só para avisar o utilizador; não se converte
    // automaticamente (evita "corrigir" um ficheiro que já estava certo em mm por engano).
    let insUnitsCode = null;
    for(let i=0;i<tokens.length-1;i++){
      if(tokens[i].code===9 && tokens[i].value==='$INSUNITS'){ insUnitsCode = parseInt(tokens[i+1].value,10); break; }
    }
    const UNITS_LABELS = {0:'não especificadas', 1:'polegadas', 2:'pés', 4:'milímetros', 5:'centímetros', 6:'metros'};
    const unitsInfo = {
      code: insUnitsCode,
      label: insUnitsCode==null ? 'não especificadas' : (UNITS_LABELS[insUnitsCode] || 'outra unidade'),
      isMm: insUnitsCode===4,
    };

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
    let hasInserts=false;
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
      } else if(ent.type==='ELLIPSE'){
        const cx=parseFloat((get(ent,10)[0]||{}).value), cy=parseFloat((get(ent,20)[0]||{}).value);
        const mx=parseFloat((get(ent,11)[0]||{}).value), my=parseFloat((get(ent,21)[0]||{}).value);
        const ratioTok=get(ent,40)[0], t1Tok=get(ent,41)[0], t2Tok=get(ent,42)[0];
        const ratio = ratioTok ? parseFloat(ratioTok.value) : 1;
        let t1 = t1Tok ? parseFloat(t1Tok.value) : 0;
        let t2 = t2Tok ? parseFloat(t2Tok.value) : Math.PI*2;
        if([cx,cy,mx,my,ratio].every(Number.isFinite)){
          const a = Math.hypot(mx,my), rot = Math.atan2(my,mx), b = a*ratio;
          let sweep = t2-t1; if(sweep<=0) sweep += Math.PI*2;
          const N = Math.max(16, Math.round(sweep/(Math.PI/32)));
          const pts=[];
          for(let i=0;i<=N;i++){
            const t = t1 + sweep*i/N;
            const ex = a*Math.cos(t), ey = b*Math.sin(t);
            pts.push({ x: cx + ex*Math.cos(rot) - ey*Math.sin(rot), y: cy + ex*Math.sin(rot) + ey*Math.cos(rot) });
          }
          const closed = sweep >= Math.PI*2 - 1e-6;
          contours.push(finalizeContour(pts, closed));
        }
      } else if(ent.type==='SPLINE'){
        warnings.add('SPLINE');
        // Pontos de controlo (10/20) e fit points (11/21) podem coexistir na mesma entidade —
        // nunca se devem concatenar (produz um traço reto a ligar os dois conjuntos). Os fit
        // points seguem melhor a curva desenhada, por isso têm preferência quando existem.
        const controlPts=[], fitPts=[];
        let curC=null, curF=null;
        for(const it of ent.items){
          if(it.code===10){ if(curC) controlPts.push(curC); curC={x:parseFloat(it.value), y:0}; }
          else if(it.code===20 && curC) curC.y=parseFloat(it.value);
          else if(it.code===11){ if(curF) fitPts.push(curF); curF={x:parseFloat(it.value), y:0}; }
          else if(it.code===21 && curF) curF.y=parseFloat(it.value);
        }
        if(curC) controlPts.push(curC);
        if(curF) fitPts.push(curF);
        const pts = fitPts.length>=2 ? fitPts : controlPts;
        if(pts.length>=2) contours.push(finalizeContour(pts, false));
      } else if(ent.type==='INSERT'){
        // Bloco reutilizável (ex: padrão de furos definido uma vez e inserido várias vezes) —
        // não é resolvido, só assinalado, porque pode esconder geometria de corte real.
        hasInserts = true;
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
    // Desenhos com geometria redundante (a mesma aresta desenhada duas vezes, comum em blocos
    // "explodidos" ou em exports com camadas sobrepostas) podiam, antes desta deduplicação, fazer
    // esta função "coser" o troço duplicado a ele próprio e criar um contorno fechado fantasma —
    // inflacionando a contagem de perfurações e o perímetro total sem qualquer aviso ao utilizador.
    const segsEqual = (pa,pb) => {
      if(pa.length !== pb.length) return false;
      if(pa.every((p,i)=>same(p, pb[i]))) return true;
      return pa.every((p,i)=>same(p, pb[pb.length-1-i]));
    };
    const dedupedOpen = [];
    contours.filter(c=>!c.closed).forEach(c=>{
      if(dedupedOpen.some(s=>segsEqual(s.points, c.points))) return;
      dedupedOpen.push(c);
    });
    const openIn = dedupedOpen.map(c=>({points: c.points.slice(), used:false}));
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
      unitsInfo,
      hasInserts,
    };
  }
  LC.parseDXF = parseDXF;

  /* ---------------------------------------------------------------- */
  /* CUSTO DE UMA PEÇA DE CHAPA                                        */
  /* Partilhado entre "Encomenda Chapa" (uma peça à mão) e "Importar   */
  /* DXF" (várias de uma vez) — assim as duas dão sempre o mesmo preço. */
  /* ---------------------------------------------------------------- */
  // Geometria para o cálculo a partir do resultado do parseDXF. pierceOverride: nº de
  // perfurações escrito à mão (ou null para usar as detetadas).
  LC.sheetGeometryFromDXF = function(r, pierceOverride){
    if(!r) return null;
    const bbox = r.bbox;
    const width = bbox ? (bbox.maxX-bbox.minX) : 0;
    const height = bbox ? (bbox.maxY-bbox.minY) : 0;
    const closed = r.closedContours.slice().sort((a,b)=>b.area-a.area);
    let netArea = 0;
    if(closed.length){
      const outer = closed[0].area;
      const holes = closed.slice(1).reduce((s,c)=>s+c.area,0);
      netArea = Math.max(outer-holes, 0);
    }
    const pierces = Number.isFinite(pierceOverride) && pierceOverride>=0 ? pierceOverride : Math.max(closed.length, r.contours.length ? 1 : 0);
    return {
      perimeterMm: r.totalLength,
      bboxAreaMm2: width*height,
      netAreaMm2: netArea,
      width, height,
      pierces,
      hasOpen: r.openContours.length>0,
    };
  };

  // p = { geo, material, qty, machine, isBatch, realTimeMin (null = estimado), drawingType,
  //       designTimeMin, setupTimeMin, adjustmentValue, adjustmentReason }
  LC.computeSheetCost = function(p){
    const geo = p.geo, material = p.material, machine = p.machine;
    const qty = Math.max(1, parseInt(p.qty,10)||1);
    if(!geo || !material || !geo.perimeterMm){
      return { valid:false, geo, material };
    }
    const isFinalTime = Number.isFinite(p.realTimeMin) && p.realTimeMin >= 0;
    const speed = Math.max(material.speed, 1);
    // "unit" = o ficheiro/dimensões são de 1 peça só, multiplica-se pela quantidade (padrão).
    // "batch" = já representam a chapa/corte de todas as peças juntas (aninhadas), não se multiplica.
    const isBatchGeometry = !!p.isBatch;

    // Tempo estimado TOTAL da encomenda: corte + perfurações, multiplicado pela quantidade só
    // quando o ficheiro/dimensões são de 1 peça — se já forem de todas juntas, usa-se tal qual.
    const pierceTimeMinPerPiece = geo.pierces * machine.pierceTime / 60;
    const cuttingTimeMinPerPiece = geo.perimeterMm / speed;
    const estimatedTotalTimeMin = isBatchGeometry
      ? (cuttingTimeMinPerPiece + pierceTimeMinPerPiece)
      : (cuttingTimeMinPerPiece + pierceTimeMinPerPiece) * qty;

    // O "Tempo de corte real" introduzido é sempre o TOTAL para todas as peças da encomenda
    // (já inclui as perfurações de todas elas) — nunca é multiplicado pela quantidade.
    const cuttingTimeMin = isFinalTime ? p.realTimeMin : estimatedTotalTimeMin;
    const corteCost = cuttingTimeMin * (machine.hourlyRate/60);

    // Waste margin: adds to the bounding-box width/height before computing area, to reflect the
    // sheet space around each part that isn't reused (parts aren't nested together). Only applies
    // to the "retângulo envolvente" basis — net (líquida) area is left as an exact calculation.
    const marginMm = machine.wasteMarginMm || 0;
    let areaMm2;
    if(machine.areaBasis==='net'){
      areaMm2 = geo.netAreaMm2;
    } else if(geo.width!=null && geo.height!=null){
      areaMm2 = (geo.width+marginMm) * (geo.height+marginMm);
    } else {
      areaMm2 = geo.bboxAreaMm2; // manual "custom" shape: no width/height to add margin to
    }
    const areaM2 = areaMm2/1e6;
    const weightFromGeometry = areaM2 * (material.thickness||0) * (material.density||0);
    const basePricePerKg = material.pricePerKg||0;
    const effectivePricePerKg = basePricePerKg * (1 + (material.markupPct||0)/100);
    const materialCostFromGeometry = weightFromGeometry * effectivePricePerKg;
    const materialCostBaseFromGeometry = weightFromGeometry * basePricePerKg;   // sem margem
    // Em modo "batch" a área/peso calculados já são o total da encomenda; em modo "unit" são de
    // 1 peça e multiplicam-se pela quantidade. O valor "por peça" fica sempre como referência.
    const weightTotal = isBatchGeometry ? weightFromGeometry : weightFromGeometry * qty;
    const weightPerPiece = weightTotal / qty;
    const materialCostTotal = isBatchGeometry ? materialCostFromGeometry : materialCostFromGeometry * qty;
    const materialCostPerPiece = materialCostTotal / qty;
    const materialCostBaseTotal = isBatchGeometry ? materialCostBaseFromGeometry : materialCostBaseFromGeometry * qty;

    const drawingType = p.drawingType;
    const designTimeMin = drawingType==='client_direct' ? 0 : (p.designTimeMin||0);
    const setupTimeMin = p.setupTimeMin||0;
    const designCost = (designTimeMin/60) * (machine.designRate||0);
    const setupCost = (setupTimeMin/60) * (machine.setupRate||0);
    const preCorteCostRaw = designCost + setupCost;

    const subtotal = corteCost + materialCostTotal + preCorteCostRaw;
    const adjustmentValue = p.adjustmentValue || 0;
    const totalCost = subtotal + adjustmentValue;
    // Custo real para a empresa: tudo igual, mas com o material ao preço de compra (sem margem).
    // O corte e a preparação já são cobrados ao custo/hora interno, por isso não mudam.
    const realCost = corteCost + materialCostBaseTotal + preCorteCostRaw;
    const marginValue = totalCost - realCost;
    const marginPct = realCost > 0 ? (marginValue/realCost)*100 : null;
    const avgPerPiece = totalCost / qty;
    const totalTimeMin = cuttingTimeMin + designTimeMin + setupTimeMin; // cuttingTimeMin já é total e já inclui perfurações

    return {
      valid:true, geo, material, qty,
      cuttingTimeMin, estimatedCuttingTimeMin: estimatedTotalTimeMin, corteCost,
      materialCostTotal, materialCostPerPiece, materialCostBaseTotal, weightPerPiece, weightTotal, isBatchGeometry,
      realCost, marginValue, marginPct,
      drawingType, designTimeMin, setupTimeMin, designCost,
      totalTimeMin,
      preCorteCost: preCorteCostRaw, subtotal, adjustmentValue,
      adjustmentReason: p.adjustmentReason,
      setupCost,
      totalCost, avgPerPiece,
      isFinalDisplay: isFinalTime,
    };
  };

  /* ---------------------------------------------------------------- */
  /* FICHAS IMPRESSAS DE CHAPA — desenho técnico (furos e entalhes) e  */
  /* ficha do operador; usadas pela Encomenda Chapa e pelo Importar DXF. */
  /* ---------------------------------------------------------------- */
  (function(){
  const fmtNum = LC.fmtNum, escapeHtml = LC.escapeHtml;

  function checkCircle(points){
    if(points.length<8) return null;
    let cx=0, cy=0;
    points.forEach(p=>{ cx+=p.x; cy+=p.y; });
    cx/=points.length; cy/=points.length;
    const dists = points.map(p=>Math.hypot(p.x-cx, p.y-cy));
    const rMean = dists.reduce((a,b)=>a+b,0)/dists.length;
    const rMax = Math.max.apply(null,dists), rMin = Math.min.apply(null,dists);
    if(rMean<=0 || (rMax-rMin)/rMean > 0.04) return null; // não é circular o suficiente
    return { diameter: rMean*2, center:{x:cx,y:cy} };
  }
  function detectHoles(closedContours){
    if(!closedContours || closedContours.length<2) return [];
    const holeContours = closedContours.slice().sort((a,b)=>b.area-a.area).slice(1);
    const holes = [];
    holeContours.forEach(c=>{ const circle = checkCircle(c.points); if(circle) holes.push(circle); });
    return holes;
  }
  function classifyHole(contour){
    // Furos redondos, ovais/rasgos e retangulares — cobre os casos mais comuns em chapa cortada
    // a laser. Um furo que não encaixe em nenhum destes fica marcado como "forma irregular", com
    // as dimensões do seu retângulo envolvente como aproximação (melhor que não dar indicação nenhuma).
    const pts = contour.points;
    const circle = checkCircle(pts);
    if(circle) return { kind:'circle', diameter:circle.diameter, center:circle.center };
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    pts.forEach(p=>{ if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x; if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y; });
    const w = maxX-minX, h = maxY-minY;
    const center = {x:(minX+maxX)/2, y:(minY+maxY)/2};
    const corners = [{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}];
    const tol = Math.max(0.5, Math.min(w,h)*0.03);
    const sharpCorners = corners.filter(co => pts.some(p => Math.hypot(p.x-co.x, p.y-co.y) < tol)).length;
    let kind = 'other';
    if(sharpCorners>=3){
      kind = 'rect';
    } else {
      const hull = convexHullPts(pts);
      if(hull.length >= pts.length*0.9) kind = 'oval'; // convexo e sem cantos vivos — oval/rasgo arredondado
    }
    return { kind, width:w, height:h, center, minX, maxX, minY, maxY };
  }
  function detectAllHoles(closedContours){
    if(!closedContours || closedContours.length<2) return [];
    return closedContours.slice().sort((a,b)=>b.area-a.area).slice(1).map(classifyHole);
  }
  function convexHullPts(points){
    const pts = points.slice().sort((a,b)=> a.x-b.x || a.y-b.y);
    if(pts.length<3) return pts.slice();
    const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
    const lower=[];
    for(const p of pts){
      while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
      lower.push(p);
    }
    const upper=[];
    for(let i=pts.length-1;i>=0;i--){
      const p=pts[i];
      while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  function detectNotches(outerPoints, bbox){
    // Deteta reentrâncias (entalhes) em arestas retas alinhadas com os eixos, comparando o
    // contorno real com o seu invólucro convexo — cobre o caso comum de chapas com entalhes
    // retangulares num dos lados. Entalhes curvos/inclinados, ou vários entalhes seguidos na
    // mesma aresta, não são separados individualmente (contam como um único entalhe a abranger
    // toda a zona entre os dois cantos convexos vizinhos).
    if(!outerPoints || outerPoints.length<5) return [];
    const hull = convexHullPts(outerPoints);
    if(hull.length<3) return [];
    let signedArea=0;
    for(let i=0;i<outerPoints.length;i++){
      const p1=outerPoints[i], p2=outerPoints[(i+1)%outerPoints.length];
      signedArea += p1.x*p2.y - p2.x*p1.y;
    }
    const ccw = signedArea>0;
    const EPS = 0.4, MIN_EDGE = 3;
    const n = outerPoints.length;
    const notches = [];
    for(let h=0; h<hull.length; h++){
      const A = hull[h], B = hull[(h+1)%hull.length];
      const ex=B.x-A.x, ey=B.y-A.y;
      if(Math.hypot(ex,ey) < MIN_EDGE) continue;
      const isHoriz = Math.abs(ey) < EPS, isVert = Math.abs(ex) < EPS;
      if(!isHoriz && !isVert) continue;
      const idxA = outerPoints.indexOf(A), idxB = outerPoints.indexOf(B);
      if(idxA<0 || idxB<0) continue;
      const between = [];
      if(ccw){ let i=(idxA+1)%n; while(i!==idxB){ between.push(outerPoints[i]); i=(i+1)%n; } }
      else { let i=(idxA-1+n)%n; while(i!==idxB){ between.push(outerPoints[i]); i=(i-1+n)%n; } }
      if(!between.length) continue;
      const distTo = p => isHoriz ? (p.y-A.y) : (p.x-A.x);
      const projTo = p => isHoriz ? p.x : p.y;
      let deepest = between[0], deepestAbs = Math.abs(distTo(between[0]));
      between.forEach(p=>{ const d=Math.abs(distTo(p)); if(d>deepestAbs){ deepestAbs=d; deepest=p; } });
      if(deepestAbs < EPS) continue;
      // Só os pontos do desvio (não os cantos A/B do casco) definem a extensão do entalhe.
      const allProj = between.map(projTo);
      const alongMin = Math.min.apply(null, allProj), alongMax = Math.max.apply(null, allProj);
      const depthSigned = distTo(deepest);
      let voidMinX, voidMaxX, voidMinY, voidMaxY, edgeName, posFromCorner;
      if(isHoriz){
        voidMinX = alongMin; voidMaxX = alongMax;
        voidMinY = Math.min(A.y, A.y+depthSigned); voidMaxY = Math.max(A.y, A.y+depthSigned);
        edgeName = (A.y - bbox.minY <= bbox.maxY - A.y) ? 'inferior' : 'superior';
        posFromCorner = alongMin - bbox.minX;
      } else {
        voidMinY = alongMin; voidMaxY = alongMax;
        voidMinX = Math.min(A.x, A.x+depthSigned); voidMaxX = Math.max(A.x, A.x+depthSigned);
        edgeName = (A.x - bbox.minX <= bbox.maxX - A.x) ? 'esquerda' : 'direita';
        posFromCorner = alongMin - bbox.minY;
      }
      notches.push({
        width: alongMax-alongMin, depth: deepestAbs, edgeName, posFromCorner,
        voidMinX, voidMaxX, voidMinY, voidMaxY,
        voidCenter: { x:(voidMinX+voidMaxX)/2, y:(voidMinY+voidMaxY)/2 },
      });
    }
    return notches;
  }
  function outerContourOf(closedContours){
    if(!closedContours || !closedContours.length) return null;
    return closedContours.slice().sort((a,b)=>b.area-a.area)[0];
  }

  // drawing = { contours, bbox, closedForHoles } — LC.sheetDrawingFromDXF(parseDXF(...)) ou uma
  // forma manual (retângulo/círculo) montada pela página.
  function buildPrintSVG(drawing, big, dimsMode){
    const contours = (drawing && drawing.contours) || [], bbox = drawing ? drawing.bbox : null;
    const closedForHoles = drawing ? drawing.closedForHoles : null;
    if(!contours.length || !bbox) return '';
    const w = big ? 400 : 300, h = big ? 260 : 200, pad = big ? 20 : 16;
    const cssMaxWidth = big ? 340 : 220;
    // Com cotas, reserva-se uma faixa extra em baixo/à esquerda para as linhas de cota e o texto,
    // para nunca sobrepor o desenho — o resto do enquadramento mantém-se igual.
    const dimBand = big ? 32 : 26;
    const padBottom = dimsMode ? dimBand : pad;
    const padLeft = dimsMode ? dimBand : pad;
    const gw=bbox.maxX-bbox.minX, gh=bbox.maxY-bbox.minY;
    const availW = w-padLeft-pad, availH = h-pad-padBottom;
    const scale = Math.min(availW/(gw||1), availH/(gh||1));
    const offX = padLeft + (availW-gw*scale)/2, offY = padBottom + (availH-gh*scale)/2;
    function tx(p){ return { x: offX+(p.x-bbox.minX)*scale, y: h-(offY+(p.y-bbox.minY)*scale) }; }
    let paths = '';
    contours.forEach(c=>{
      if(c.points.length<2) return;
      const p0 = tx(c.points[0]);
      let d = 'M ' + p0.x.toFixed(1) + ' ' + p0.y.toFixed(1) + ' ';
      for(let i=1;i<c.points.length;i++){ const p=tx(c.points[i]); d += 'L ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' '; }
      if(c.closed) d += 'Z';
      paths += '<path d="'+d+'" fill="none" stroke="#111" stroke-width="1.2"/>';
    });

    let extra = '';
    if(dimsMode){
      const shapeLeft = tx({x:bbox.minX,y:bbox.minY}).x, shapeRight = tx({x:bbox.maxX,y:bbox.minY}).x;
      const shapeBottom = tx({x:bbox.minX,y:bbox.minY}).y, shapeTop = tx({x:bbox.minX,y:bbox.maxY}).y;
      const gap = 7, tick = 3.5, fs = big ? 8.5 : 7.5, dc = '#555';
      const dimY = shapeBottom + gap, dimX = shapeLeft - gap;
      const ln = (x1,y1,x2,y2,sw)=>'<line x1="'+x1.toFixed(1)+'" y1="'+y1.toFixed(1)+'" x2="'+x2.toFixed(1)+'" y2="'+y2.toFixed(1)+'" stroke="'+dc+'" stroke-width="'+sw+'"/>';
      // Cota de largura (linha horizontal por baixo da peça)
      extra += ln(shapeLeft, shapeBottom, shapeLeft, dimY, 0.6);
      extra += ln(shapeRight, shapeBottom, shapeRight, dimY, 0.6);
      extra += ln(shapeLeft, dimY, shapeRight, dimY, 0.7);
      extra += ln(shapeLeft, dimY-tick, shapeLeft, dimY+tick, 0.9);
      extra += ln(shapeRight, dimY-tick, shapeRight, dimY+tick, 0.9);
      extra += '<text x="'+((shapeLeft+shapeRight)/2).toFixed(1)+'" y="'+(dimY+fs+1).toFixed(1)+'" font-size="'+fs+'" font-family="Inter,sans-serif" fill="'+dc+'" text-anchor="middle">'+fmtNum(gw,1)+' mm</text>';
      // Cota de altura (linha vertical à esquerda da peça)
      extra += ln(shapeLeft, shapeTop, dimX, shapeTop, 0.6);
      extra += ln(shapeLeft, shapeBottom, dimX, shapeBottom, 0.6);
      extra += ln(dimX, shapeTop, dimX, shapeBottom, 0.7);
      extra += ln(dimX-tick, shapeTop, dimX+tick, shapeTop, 0.9);
      extra += ln(dimX-tick, shapeBottom, dimX+tick, shapeBottom, 0.9);
      const midY = (shapeTop+shapeBottom)/2;
      extra += '<text x="'+(dimX-2).toFixed(1)+'" y="'+midY.toFixed(1)+'" font-size="'+fs+'" font-family="Inter,sans-serif" fill="'+dc+'" text-anchor="middle" transform="rotate(-90 '+(dimX-2).toFixed(1)+' '+midY.toFixed(1)+')">'+fmtNum(gh,1)+' mm</text>';

      if(dimsMode==='client'){
        // Furos circulares — agrupados por diâmetro para não poluir o desenho quando há vários furos iguais.
        const groups = new Map();
        detectHoles(closedForHoles).forEach(hh=>{
          const key = hh.diameter.toFixed(1);
          if(!groups.has(key)) groups.set(key, {diameter:hh.diameter, count:0, center:hh.center});
          groups.get(key).count++;
        });
        groups.forEach(g=>{
          const c = tx(g.center);
          const label = 'Ø' + fmtNum(g.diameter,1) + (g.count>1 ? ' (×'+g.count+')' : '');
          extra += '<circle cx="'+c.x.toFixed(1)+'" cy="'+c.y.toFixed(1)+'" r="1.3" fill="'+dc+'"/>';
          extra += '<text x="'+c.x.toFixed(1)+'" y="'+(c.y-4).toFixed(1)+'" font-size="'+(fs-0.5)+'" font-family="Inter,sans-serif" fill="'+dc+'" text-anchor="middle">'+label+'</text>';
        });
      } else if(dimsMode==='full'){
        // Ficha do operador: cada furo (redondo, oval ou retangular) numerado individualmente
        // (posição/dimensões na lista abaixo) e cada entalhe assinalado com a sua área e uma
        // etiqueta com a largura×profundidade.
        detectAllHoles(closedForHoles).forEach((hh,i)=>{
          const c = tx(hh.center);
          if(hh.kind!=='circle'){
            const p1 = tx({x:hh.minX,y:hh.minY}), p2 = tx({x:hh.maxX,y:hh.maxY});
            const rx = Math.min(p1.x,p2.x), ry = Math.min(p1.y,p2.y), rw = Math.abs(p2.x-p1.x), rh = Math.abs(p2.y-p1.y);
            extra += '<rect x="'+rx.toFixed(1)+'" y="'+ry.toFixed(1)+'" width="'+rw.toFixed(1)+'" height="'+rh.toFixed(1)+'" fill="none" stroke="'+dc+'" stroke-width="0.5" stroke-dasharray="1.5,1.2"/>';
          }
          extra += '<circle cx="'+c.x.toFixed(1)+'" cy="'+c.y.toFixed(1)+'" r="1.3" fill="'+dc+'"/>';
          extra += '<text x="'+c.x.toFixed(1)+'" y="'+(c.y-4).toFixed(1)+'" font-size="'+(fs-0.5)+'" font-family="Inter,sans-serif" fill="'+dc+'" font-weight="700" text-anchor="middle">'+(i+1)+'</text>';
        });
        const outer = outerContourOf(closedForHoles);
        if(outer){
          detectNotches(outer.points, bbox).forEach((nn,i)=>{
            const p1 = tx({x:nn.voidMinX,y:nn.voidMinY}), p2 = tx({x:nn.voidMaxX,y:nn.voidMaxY});
            const rx = Math.min(p1.x,p2.x), ry = Math.min(p1.y,p2.y), rw = Math.abs(p2.x-p1.x), rh = Math.abs(p2.y-p1.y);
            extra += '<rect x="'+rx.toFixed(1)+'" y="'+ry.toFixed(1)+'" width="'+rw.toFixed(1)+'" height="'+rh.toFixed(1)+'" fill="none" stroke="'+dc+'" stroke-width="0.5" stroke-dasharray="2,1.5"/>';
            const cx = (p1.x+p2.x)/2, cy = (p1.y+p2.y)/2;
            extra += '<text x="'+cx.toFixed(1)+'" y="'+(cy-2).toFixed(1)+'" font-size="'+(fs-0.5)+'" font-family="Inter,sans-serif" fill="'+dc+'" font-weight="700" text-anchor="middle">N'+(i+1)+'</text>';
            extra += '<text x="'+cx.toFixed(1)+'" y="'+(cy+7).toFixed(1)+'" font-size="'+(fs-1.5)+'" font-family="Inter,sans-serif" fill="'+dc+'" text-anchor="middle">'+fmtNum(nn.width,1)+'×'+fmtNum(nn.depth,1)+'</text>';
          });
        }
      }
    }

    return '<svg viewBox="0 0 '+w+' '+h+'" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:'+cssMaxWidth+'px;height:auto;border:1px solid #ccc;display:block;margin:0 auto;">'+paths+extra+'</svg>';
  }

  function pRow(label, value){
    return '<div class="p-row"><span class="p-label">'+label+'</span><span class="p-value">'+value+'</span></div>';
  }

  // Ficha do operador ("Ordem de Corte — Operador") de uma peça de chapa — a mesma folha para a
  // Encomenda Chapa e para o Importar DXF (várias fichas seguidas).
  // d = { orderNumber, orderName, client, source, material, qty, geo, weightPerPiece,
  //       drawing (ver buildPrintSVG), dxf (resultado do parseDXF, ou null), comments, dateStr }
  function operatorSheetHTML(d){
    const material = d.material, geo = d.geo;
    let html = '';
    html += '<div class="p-logo"><img src="logo.svg" alt="Serralharia José Gabriel P. V. do Couto"></div>';
    html += '<div class="p-title">Ordem de Corte — Operador</div>';
    html += '<div class="p-meta">Gerado em ' + d.dateStr + '</div>';

    const svg = buildPrintSVG(d.drawing, true, 'full');
    html += '<div class="p-section">';
    html += pRow('Nº da encomenda', d.orderNumber || '—');
    html += pRow('Encomenda / peça', escapeHtml(d.orderName || '—'));
    html += pRow('Cliente', escapeHtml(d.client || '—'));
    html += pRow('Ficheiro / forma', escapeHtml(d.source));
    html += '</div>';

    html += '<div class="p-preview-big">' + (svg || '<div class="p-noprev">Sem pré-visualização disponível</div>') + '</div>';

    html += '<div class="p-section">';
    html += pRow('Material', material ? material.name : '—');
    html += pRow('Espessura', material ? (material.thickness + ' mm') : '—');
    html += pRow('Quantidade a produzir', d.qty);
    html += '</div>';

    html += '<div class="p-section">';
    html += pRow('Dimensões (L × A)', (geo && geo.width) ? (fmtNum(geo.width,1) + ' × ' + fmtNum(geo.height,1) + ' mm') : '—');
    html += pRow('Perímetro de corte', geo ? (fmtNum(geo.perimeterMm/10,1) + ' cm') : '—');
    html += pRow('Nº de perfurações', geo ? geo.pierces : '—');
    if(d.weightPerPiece > 0) html += pRow('Peso de 1 peça', fmtNum(d.weightPerPiece,2) + ' kg');
    html += '</div>';

    if(d.dxf){
      const dBbox = d.dxf.bbox;
      const holesFull = detectAllHoles(d.dxf.closedContours);
      const holeShapeName = { rect:'retangular', oval:'oval', other:'forma irregular — aprox.' };
      if(holesFull.length){
        html += '<div class="p-section"><div class="p-costs-title">Furos (posição a partir do canto inferior esquerdo)</div>';
        holesFull.forEach((hh,i)=>{
          const x = hh.center.x - dBbox.minX, y = hh.center.y - dBbox.minY;
          const label = hh.kind==='circle'
            ? 'Ø' + fmtNum(hh.diameter,1) + ' mm'
            : fmtNum(hh.width,1) + ' × ' + fmtNum(hh.height,1) + ' mm (' + holeShapeName[hh.kind] + ')';
          html += pRow((i+1) + ' — ' + label, 'X: ' + fmtNum(x,1) + ' mm · Y: ' + fmtNum(y,1) + ' mm');
        });
        html += '</div>';
      }
      const outerForNotches = outerContourOf(d.dxf.closedContours);
      const notchesFull = outerForNotches ? detectNotches(outerForNotches.points, dBbox) : [];
      if(notchesFull.length){
        html += '<div class="p-section"><div class="p-costs-title">Entalhes</div>';
        notchesFull.forEach((nn,i)=>{
          html += pRow('N' + (i+1) + ' — ' + fmtNum(nn.width,1) + ' × ' + fmtNum(nn.depth,1) + ' mm', 'a ' + fmtNum(nn.posFromCorner,1) + ' mm do canto — aresta ' + nn.edgeName);
        });
        html += '</div>';
      }
    }

    html += '<div class="p-realtime-box">Tempo de corte real (TOTAL da encomenda, todas as peças): __________________ min &nbsp;&nbsp;&nbsp; Nº de perfurações (se diferente): __________</div>';

    const operatorCommentsText = (d.comments || '').trim();
    if(operatorCommentsText){
      html += '<div class="p-notes-box"><div class="p-notes-title">Comentários internos</div>' +
        '<div class="p-notes-text">' + escapeHtml(operatorCommentsText).replace(/\n/g,'<br>') + '</div>' +
        '</div>';
    }

    html += '<div class="p-sign"><div>Operador: ______________________</div><div>Data: ______________</div></div>';
    return html;
  }

  LC.sheetDrawingFromDXF = r => r ? { contours:r.contours, bbox:r.bbox, closedForHoles:r.closedContours } : null;
  LC.buildSheetPrintSVG = buildPrintSVG;
  LC.detectSheetHoles = detectHoles;
  LC.pRow = pRow;
  LC.operatorSheetHTML = operatorSheetHTML;
  })();

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
  LC.DEFAULT_MACHINE = { hourlyRate:45, designRate:30, setupRate:30, pierceTime:0.8, areaBasis:'bbox', defaultSetupMin:5, wasteMarginMm:5, alertQuoteDays:7, alertRealTimeDays:2, angleCutFactor:1.4, tubeMarkup:1.5, tubeBarLengthMm:6000, tubeClampMm:400 };

  LC.DEFAULT_TUBE_PROFILES = [
    {id:'preto-redondo-3_8_s_rie_ligeira', material:'preto', shape:'redondo', name:'3/8" série ligeira', w:17.2, h:17.2, t:2, inch:true, costPerM:1.47},
    {id:'preto-redondo-1_2_s_rie_m_dia', material:'preto', shape:'redondo', name:'1/2" série média', w:21.3, h:21.3, t:2.65, inch:true, costPerM:0},
    {id:'preto-redondo-1_2', material:'preto', shape:'redondo', name:'1/2"', w:21.3, h:21.3, t:null, inch:true, costPerM:1.85},
    {id:'preto-redondo-3_4_s_rie_m_dia', material:'preto', shape:'redondo', name:'3/4" série média', w:26.9, h:26.9, t:2.65, inch:true, costPerM:1.5},
    {id:'preto-redondo-3_4', material:'preto', shape:'redondo', name:'3/4"', w:26.9, h:26.9, t:null, inch:true, costPerM:1.84},
    {id:'preto-redondo-1_s_rie_m_dia', material:'preto', shape:'redondo', name:'1" série média', w:33.7, h:33.7, t:3.25, inch:true, costPerM:3.15},
    {id:'preto-redondo-1', material:'preto', shape:'redondo', name:'1"', w:33.7, h:33.7, t:null, inch:true, costPerM:2.65},
    {id:'preto-redondo-1_1_4', material:'preto', shape:'redondo', name:'1 1/4"', w:42.4, h:42.4, t:null, inch:true, costPerM:3.35},
    {id:'preto-redondo-1_1_4_s_rie_m_dia', material:'preto', shape:'redondo', name:'1 1/4" série média', w:42.4, h:42.4, t:3.25, inch:true, costPerM:3.9},
    {id:'preto-redondo-1_1_2', material:'preto', shape:'redondo', name:'1 1/2"', w:48.3, h:48.3, t:null, inch:true, costPerM:4.5},
    {id:'preto-redondo-1_1_2_s_rie_m_dia', material:'preto', shape:'redondo', name:'1 1/2" série média', w:48.3, h:48.3, t:3.25, inch:true, costPerM:4.2},
    {id:'preto-redondo-2', material:'preto', shape:'redondo', name:'2"', w:60.3, h:60.3, t:null, inch:true, costPerM:3.75},
    {id:'preto-redondo-2_s_rie_m_dia', material:'preto', shape:'redondo', name:'2" série média', w:60.3, h:60.3, t:3.65, inch:true, costPerM:5.95},
    {id:'preto-redondo-2_1_2_s_rie_ligeira', material:'preto', shape:'redondo', name:'2 1/2" série ligeira', w:76.1, h:76.1, t:3.25, inch:true, costPerM:7.4},
    {id:'preto-redondo-2_1_2_s_rie_m_dia', material:'preto', shape:'redondo', name:'2 1/2" série média', w:76.1, h:76.1, t:3.65, inch:true, costPerM:7.95},
    {id:'preto-redondo-3', material:'preto', shape:'redondo', name:'3"', w:88.9, h:88.9, t:null, inch:true, costPerM:9.8},
    {id:'preto-redondo-3_s_rie_m_dia', material:'preto', shape:'redondo', name:'3" série média', w:88.9, h:88.9, t:4.05, inch:true, costPerM:10.85},
    {id:'preto-redondo-3_1_2_s_rie_m_dia', material:'preto', shape:'redondo', name:'3 1/2" série média', w:101.6, h:101.6, t:4.05, inch:true, costPerM:0},
    {id:'preto-redondo-3_1_2_s_rie_ligeira', material:'preto', shape:'redondo', name:'3 1/2" série ligeira', w:101.6, h:101.6, t:3.65, inch:true, costPerM:8.4},
    {id:'preto-redondo-4_s_rie_ligeira', material:'preto', shape:'redondo', name:'4" série ligeira', w:114.3, h:114.3, t:4.05, inch:true, costPerM:10.5},
    {id:'preto-redondo-4_s_rie_m_dia', material:'preto', shape:'redondo', name:'4" série média', w:114.3, h:114.3, t:4.5, inch:true, costPerM:20.61},
    {id:'preto-redondo-5_s_rie_m_dia', material:'preto', shape:'redondo', name:'5" série média', w:139.7, h:139.7, t:4.85, inch:true, costPerM:0},
    {id:'preto-redondo-6_s_rie_m_dia', material:'preto', shape:'redondo', name:'6" série média', w:168.3, h:168.3, t:4.85, inch:true, costPerM:30},
    {id:'preto-redondo-40x1_5', material:'preto', shape:'redondo', name:'Ø40x1,5', w:40, h:40, t:1.5, inch:false, costPerM:0},
    {id:'preto-redondo-40x2', material:'preto', shape:'redondo', name:'Ø40x2', w:40, h:40, t:2, inch:false, costPerM:2.75},
    {id:'preto-redondo-30x1_5', material:'preto', shape:'redondo', name:'Ø30x1,5', w:30, h:30, t:1.5, inch:false, costPerM:0},
    {id:'preto-redondo-60x1_5', material:'preto', shape:'redondo', name:'Ø60x1,5', w:60, h:60, t:1.5, inch:false, costPerM:2.7},
    {id:'preto-redondo-60x2', material:'preto', shape:'redondo', name:'Ø60x2', w:60, h:60, t:2, inch:false, costPerM:0},
    {id:'preto-redondo-80x2', material:'preto', shape:'redondo', name:'Ø80x2', w:80, h:80, t:2, inch:false, costPerM:5.6},
    {id:'preto-quadrado-16x16x1_5', material:'preto', shape:'quadrado', name:'16x16x1,5', w:16, h:16, t:1.5, inch:false, costPerM:1.05},
    {id:'preto-quadrado-20x20x1_5', material:'preto', shape:'quadrado', name:'20x20x1,5', w:20, h:20, t:1.5, inch:false, costPerM:1.15},
    {id:'preto-quadrado-25x25x1_5', material:'preto', shape:'quadrado', name:'25x25x1,5', w:25, h:25, t:1.5, inch:false, costPerM:1.45},
    {id:'preto-quadrado-30x30x1_5', material:'preto', shape:'quadrado', name:'30x30x1,5', w:30, h:30, t:1.5, inch:false, costPerM:1.55},
    {id:'preto-quadrado-35x35x1_5', material:'preto', shape:'quadrado', name:'35x35x1,5', w:35, h:35, t:1.5, inch:false, costPerM:1.69},
    {id:'preto-quadrado-40x40x1_5', material:'preto', shape:'quadrado', name:'40x40x1,5', w:40, h:40, t:1.5, inch:false, costPerM:1.9},
    {id:'preto-quadrado-45x45x1_5', material:'preto', shape:'quadrado', name:'45x45x1,5', w:45, h:45, t:1.5, inch:false, costPerM:0},
    {id:'preto-quadrado-50x50x1_5', material:'preto', shape:'quadrado', name:'50x50x1,5', w:50, h:50, t:1.5, inch:false, costPerM:2.55},
    {id:'preto-quadrado-60x60x1_5', material:'preto', shape:'quadrado', name:'60x60x1,5', w:60, h:60, t:1.5, inch:false, costPerM:3.15},
    {id:'preto-quadrado-80x80x1_5', material:'preto', shape:'quadrado', name:'80x80x1,5', w:80, h:80, t:1.5, inch:false, costPerM:0},
    {id:'preto-quadrado-100x100x1_5', material:'preto', shape:'quadrado', name:'100x100x1,5', w:100, h:100, t:1.5, inch:false, costPerM:0},
    {id:'preto-quadrado-20x20x2', material:'preto', shape:'quadrado', name:'20x20x2', w:20, h:20, t:2, inch:false, costPerM:1.4},
    {id:'preto-quadrado-30x30x2', material:'preto', shape:'quadrado', name:'30x30x2', w:30, h:30, t:2, inch:false, costPerM:2},
    {id:'preto-quadrado-30x30x3', material:'preto', shape:'quadrado', name:'30x30x3', w:30, h:30, t:3, inch:false, costPerM:4.33},
    {id:'preto-quadrado-35x35x2', material:'preto', shape:'quadrado', name:'35x35x2', w:35, h:35, t:2, inch:false, costPerM:3.35},
    {id:'preto-quadrado-40x40x2', material:'preto', shape:'quadrado', name:'40x40x2', w:40, h:40, t:2, inch:false, costPerM:2.85},
    {id:'preto-quadrado-40x40x3', material:'preto', shape:'quadrado', name:'40x40x3', w:40, h:40, t:3, inch:false, costPerM:3.85},
    {id:'preto-quadrado-40x40x4', material:'preto', shape:'quadrado', name:'40x40x4', w:40, h:40, t:4, inch:false, costPerM:5},
    {id:'preto-quadrado-45x45x3', material:'preto', shape:'quadrado', name:'45x45x3', w:45, h:45, t:3, inch:false, costPerM:6.85},
    {id:'preto-quadrado-50x50x2', material:'preto', shape:'quadrado', name:'50x50x2', w:50, h:50, t:2, inch:false, costPerM:3.95},
    {id:'preto-quadrado-50x50x3', material:'preto', shape:'quadrado', name:'50x50x3', w:50, h:50, t:3, inch:false, costPerM:4.95},
    {id:'preto-quadrado-50x50x4', material:'preto', shape:'quadrado', name:'50x50x4', w:50, h:50, t:4, inch:false, costPerM:7.35},
    {id:'preto-quadrado-50x50x5', material:'preto', shape:'quadrado', name:'50x50x5', w:50, h:50, t:5, inch:false, costPerM:7.65},
    {id:'preto-quadrado-60x60x2', material:'preto', shape:'quadrado', name:'60x60x2', w:60, h:60, t:2, inch:false, costPerM:5.85},
    {id:'preto-quadrado-60x60x3', material:'preto', shape:'quadrado', name:'60x60x3', w:60, h:60, t:3, inch:false, costPerM:5.6},
    {id:'preto-quadrado-60x60x4', material:'preto', shape:'quadrado', name:'60x60x4', w:60, h:60, t:4, inch:false, costPerM:13.06},
    {id:'preto-quadrado-70x70x3', material:'preto', shape:'quadrado', name:'70x70x3', w:70, h:70, t:3, inch:false, costPerM:8},
    {id:'preto-quadrado-70x70x4', material:'preto', shape:'quadrado', name:'70x70x4', w:70, h:70, t:4, inch:false, costPerM:10},
    {id:'preto-quadrado-80x80x2', material:'preto', shape:'quadrado', name:'80x80x2', w:80, h:80, t:2, inch:false, costPerM:5.65},
    {id:'preto-quadrado-80x80x3', material:'preto', shape:'quadrado', name:'80x80x3', w:80, h:80, t:3, inch:false, costPerM:10.45},
    {id:'preto-quadrado-80x80x4', material:'preto', shape:'quadrado', name:'80x80x4', w:80, h:80, t:4, inch:false, costPerM:12.2},
    {id:'preto-quadrado-100x100x2', material:'preto', shape:'quadrado', name:'100x100x2', w:100, h:100, t:2, inch:false, costPerM:8.5},
    {id:'preto-quadrado-100x100x3', material:'preto', shape:'quadrado', name:'100x100x3', w:100, h:100, t:3, inch:false, costPerM:11.5},
    {id:'preto-quadrado-100x100x4', material:'preto', shape:'quadrado', name:'100x100x4', w:100, h:100, t:4, inch:false, costPerM:14.2},
    {id:'preto-quadrado-120x120x2', material:'preto', shape:'quadrado', name:'120x120x2', w:120, h:120, t:2, inch:false, costPerM:0},
    {id:'preto-quadrado-120x120x3', material:'preto', shape:'quadrado', name:'120x120x3', w:120, h:120, t:3, inch:false, costPerM:15.8},
    {id:'preto-quadrado-120x120x4', material:'preto', shape:'quadrado', name:'120x120x4', w:120, h:120, t:4, inch:false, costPerM:17.8},
    {id:'preto-quadrado-120x120x8', material:'preto', shape:'quadrado', name:'120x120x8', w:120, h:120, t:8, inch:false, costPerM:39},
    {id:'preto-quadrado-140x140x3', material:'preto', shape:'quadrado', name:'140x140x3', w:140, h:140, t:3, inch:false, costPerM:16},
    {id:'preto-quadrado-140x140x4', material:'preto', shape:'quadrado', name:'140x140x4', w:140, h:140, t:4, inch:false, costPerM:19},
    {id:'preto-quadrado-150x150x3', material:'preto', shape:'quadrado', name:'150x150x3', w:150, h:150, t:3, inch:false, costPerM:16},
    {id:'preto-quadrado-150x150x4', material:'preto', shape:'quadrado', name:'150x150x4', w:150, h:150, t:4, inch:false, costPerM:21.8},
    {id:'preto-quadrado-160x160x4', material:'preto', shape:'quadrado', name:'160x160x4', w:160, h:160, t:4, inch:false, costPerM:12.54},
    {id:'preto-quadrado-200x200x4', material:'preto', shape:'quadrado', name:'200x200x4', w:200, h:200, t:4, inch:false, costPerM:25},
    {id:'preto-retangular-180x100x4', material:'preto', shape:'retangular', name:'180x100x4', w:180, h:100, t:4, inch:false, costPerM:21},
    {id:'preto-retangular-30x10x1_5', material:'preto', shape:'retangular', name:'30x10x1,5', w:30, h:10, t:1.5, inch:false, costPerM:0},
    {id:'preto-retangular-30x15x1_5', material:'preto', shape:'retangular', name:'30x15x1,5', w:30, h:15, t:1.5, inch:false, costPerM:1.45},
    {id:'preto-retangular-30x20x1_5', material:'preto', shape:'retangular', name:'30x20x1,5', w:30, h:20, t:1.5, inch:false, costPerM:1.85},
    {id:'preto-retangular-35x15x1_5', material:'preto', shape:'retangular', name:'35x15x1,5', w:35, h:15, t:1.5, inch:false, costPerM:1.45},
    {id:'preto-retangular-35x20x1_5', material:'preto', shape:'retangular', name:'35x20x1,5', w:35, h:20, t:1.5, inch:false, costPerM:0},
    {id:'preto-retangular-40x10x1_5', material:'preto', shape:'retangular', name:'40x10x1,5', w:40, h:10, t:1.5, inch:false, costPerM:1.45},
    {id:'preto-retangular-40x25x1_5', material:'preto', shape:'retangular', name:'40x25x1,5', w:40, h:25, t:1.5, inch:false, costPerM:2.39},
    {id:'preto-retangular-40x20x1_5', material:'preto', shape:'retangular', name:'40x20x1,5', w:40, h:20, t:1.5, inch:false, costPerM:1.65},
    {id:'preto-retangular-40x30x1_5', material:'preto', shape:'retangular', name:'40x30x1,5', w:40, h:30, t:1.5, inch:false, costPerM:2.45},
    {id:'preto-retangular-50x10x1_5', material:'preto', shape:'retangular', name:'50x10x1,5', w:50, h:10, t:1.5, inch:false, costPerM:2.2},
    {id:'preto-retangular-50x20x1_5', material:'preto', shape:'retangular', name:'50x20x1,5', w:50, h:20, t:1.5, inch:false, costPerM:2},
    {id:'preto-retangular-50x25x1_5', material:'preto', shape:'retangular', name:'50x25x1,5', w:50, h:25, t:1.5, inch:false, costPerM:2},
    {id:'preto-retangular-50x30x1_5', material:'preto', shape:'retangular', name:'50x30x1,5', w:50, h:30, t:1.5, inch:false, costPerM:2.15},
    {id:'preto-retangular-60x10x1_5', material:'preto', shape:'retangular', name:'60x10x1,5', w:60, h:10, t:1.5, inch:false, costPerM:2.5},
    {id:'preto-retangular-60x20x1_5', material:'preto', shape:'retangular', name:'60x20x1,5', w:60, h:20, t:1.5, inch:false, costPerM:2.35},
    {id:'preto-retangular-60x30x1_5', material:'preto', shape:'retangular', name:'60x30x1,5', w:60, h:30, t:1.5, inch:false, costPerM:2.89},
    {id:'preto-retangular-80x20x1_5', material:'preto', shape:'retangular', name:'80x20x1,5', w:80, h:20, t:1.5, inch:false, costPerM:4},
    {id:'preto-retangular-60x40x1_5', material:'preto', shape:'retangular', name:'60x40x1,5', w:60, h:40, t:1.5, inch:false, costPerM:2.95},
    {id:'preto-retangular-80x40x1_5', material:'preto', shape:'retangular', name:'80x40x1,5', w:80, h:40, t:1.5, inch:false, costPerM:3.35},
    {id:'preto-retangular-80x60x1_5', material:'preto', shape:'retangular', name:'80x60x1,5', w:80, h:60, t:1.5, inch:false, costPerM:0},
    {id:'preto-retangular-100x20x1_5', material:'preto', shape:'retangular', name:'100x20x1,5', w:100, h:20, t:1.5, inch:false, costPerM:3.35},
    {id:'preto-retangular-100x40x1_5', material:'preto', shape:'retangular', name:'100x40x1,5', w:100, h:40, t:1.5, inch:false, costPerM:0},
    {id:'preto-retangular-30x20x2', material:'preto', shape:'retangular', name:'30x20x2', w:30, h:20, t:2, inch:false, costPerM:1.85},
    {id:'preto-retangular-40x20x2', material:'preto', shape:'retangular', name:'40x20x2', w:40, h:20, t:2, inch:false, costPerM:1.98},
    {id:'preto-retangular-40x25x2', material:'preto', shape:'retangular', name:'40x25x2', w:40, h:25, t:2, inch:false, costPerM:0},
    {id:'preto-retangular-40x30x2', material:'preto', shape:'retangular', name:'40x30x2', w:40, h:30, t:2, inch:false, costPerM:2.99},
    {id:'preto-retangular-50x30x2', material:'preto', shape:'retangular', name:'50x30x2', w:50, h:30, t:2, inch:false, costPerM:3.95},
    {id:'preto-retangular-50x30x3', material:'preto', shape:'retangular', name:'50x30x3', w:50, h:30, t:3, inch:false, costPerM:3.45},
    {id:'preto-retangular-60x20x2', material:'preto', shape:'retangular', name:'60x20x2', w:60, h:20, t:2, inch:false, costPerM:3.95},
    {id:'preto-retangular-60x30x2', material:'preto', shape:'retangular', name:'60x30x2', w:60, h:30, t:2, inch:false, costPerM:4.2},
    {id:'preto-retangular-60x30x3', material:'preto', shape:'retangular', name:'60x30x3', w:60, h:30, t:3, inch:false, costPerM:4.6},
    {id:'preto-retangular-60x40x2', material:'preto', shape:'retangular', name:'60x40x2', w:60, h:40, t:2, inch:false, costPerM:3.6},
    {id:'preto-retangular-60x40x3', material:'preto', shape:'retangular', name:'60x40x3', w:60, h:40, t:3, inch:false, costPerM:4.91},
    {id:'preto-retangular-80x20x2', material:'preto', shape:'retangular', name:'80x20x2', w:80, h:20, t:2, inch:false, costPerM:0},
    {id:'preto-retangular-80x40x2', material:'preto', shape:'retangular', name:'80x40x2', w:80, h:40, t:2, inch:false, costPerM:4.2},
    {id:'preto-retangular-80x40x3', material:'preto', shape:'retangular', name:'80x40x3', w:80, h:40, t:3, inch:false, costPerM:7.87},
    {id:'preto-retangular-80x40x4', material:'preto', shape:'retangular', name:'80x40x4', w:80, h:40, t:4, inch:false, costPerM:7.95},
    {id:'preto-retangular-80x60x2', material:'preto', shape:'retangular', name:'80x60x2', w:80, h:60, t:2, inch:false, costPerM:0},
    {id:'preto-retangular-80x60x3', material:'preto', shape:'retangular', name:'80x60x3', w:80, h:60, t:3, inch:false, costPerM:8.45},
    {id:'preto-retangular-100x40x2', material:'preto', shape:'retangular', name:'100x40x2', w:100, h:40, t:2, inch:false, costPerM:5.65},
    {id:'preto-retangular-100x50x2', material:'preto', shape:'retangular', name:'100x50x2', w:100, h:50, t:2, inch:false, costPerM:5.95},
    {id:'preto-retangular-100x50x3', material:'preto', shape:'retangular', name:'100x50x3', w:100, h:50, t:3, inch:false, costPerM:9},
    {id:'preto-retangular-100x50x4', material:'preto', shape:'retangular', name:'100x50x4', w:100, h:50, t:4, inch:false, costPerM:9.95},
    {id:'preto-retangular-100x60x2', material:'preto', shape:'retangular', name:'100x60x2', w:100, h:60, t:2, inch:false, costPerM:11.65},
    {id:'preto-retangular-100x60x3', material:'preto', shape:'retangular', name:'100x60x3', w:100, h:60, t:3, inch:false, costPerM:12},
    {id:'preto-retangular-100x60x4', material:'preto', shape:'retangular', name:'100x60x4', w:100, h:60, t:4, inch:false, costPerM:13.5},
    {id:'preto-retangular-100x80x3', material:'preto', shape:'retangular', name:'100x80x3', w:100, h:80, t:3, inch:false, costPerM:0},
    {id:'preto-retangular-100x80x4', material:'preto', shape:'retangular', name:'100x80x4', w:100, h:80, t:4, inch:false, costPerM:0},
    {id:'preto-retangular-120x60x2', material:'preto', shape:'retangular', name:'120x60x2', w:120, h:60, t:2, inch:false, costPerM:8.85},
    {id:'preto-retangular-120x60x3', material:'preto', shape:'retangular', name:'120x60x3', w:120, h:60, t:3, inch:false, costPerM:8},
    {id:'preto-retangular-120x60x4', material:'preto', shape:'retangular', name:'120x60x4', w:120, h:60, t:4, inch:false, costPerM:0},
    {id:'preto-retangular-120x80x3', material:'preto', shape:'retangular', name:'120x80x3', w:120, h:80, t:3, inch:false, costPerM:0},
    {id:'preto-retangular-140x80x3', material:'preto', shape:'retangular', name:'140x80x3', w:140, h:80, t:3, inch:false, costPerM:12},
    {id:'preto-retangular-140x60x3', material:'preto', shape:'retangular', name:'140x60x3', w:140, h:60, t:3, inch:false, costPerM:10.47},
    {id:'preto-retangular-160x80x3', material:'preto', shape:'retangular', name:'160x80x3', w:160, h:80, t:3, inch:false, costPerM:18},
    {id:'preto-retangular-160x80x4', material:'preto', shape:'retangular', name:'160x80x4', w:160, h:80, t:4, inch:false, costPerM:23.5},
    {id:'preto-retangular-180x80x3', material:'preto', shape:'retangular', name:'180x80x3', w:180, h:80, t:3, inch:false, costPerM:14},
    {id:'preto-retangular-200x100x3', material:'preto', shape:'retangular', name:'200x100x3', w:200, h:100, t:3, inch:false, costPerM:0},
    {id:'preto-retangular-200x100x6', material:'preto', shape:'retangular', name:'200x100x6', w:200, h:100, t:6, inch:false, costPerM:32},
    {id:'preto-retangular-200x100x4', material:'preto', shape:'retangular', name:'200x100x4', w:200, h:100, t:4, inch:false, costPerM:31},
    {id:'galvanizado-redondo-3_8_s_rie_ligeira', material:'galvanizado', shape:'redondo', name:'3/8" série ligeira', w:17.2, h:17.2, t:2, inch:true, costPerM:0},
    {id:'galvanizado-redondo-1_2_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'1/2" série média', w:21.3, h:21.3, t:2.65, inch:true, costPerM:2.85},
    {id:'galvanizado-redondo-1_2', material:'galvanizado', shape:'redondo', name:'1/2"', w:21.3, h:21.3, t:null, inch:true, costPerM:2.1},
    {id:'galvanizado-redondo-3_4_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'3/4" série média', w:26.9, h:26.9, t:2.65, inch:true, costPerM:4.82},
    {id:'galvanizado-redondo-3_4', material:'galvanizado', shape:'redondo', name:'3/4"', w:26.9, h:26.9, t:null, inch:true, costPerM:2.9},
    {id:'galvanizado-redondo-1_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'1" série média', w:33.7, h:33.7, t:3.25, inch:true, costPerM:3.45},
    {id:'galvanizado-redondo-1', material:'galvanizado', shape:'redondo', name:'1"', w:33.7, h:33.7, t:null, inch:true, costPerM:3.25},
    {id:'galvanizado-redondo-1_1_4', material:'galvanizado', shape:'redondo', name:'1 1/4"', w:42.4, h:42.4, t:null, inch:true, costPerM:4.65},
    {id:'galvanizado-redondo-1_1_4_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'1 1/4" série média', w:42.4, h:42.4, t:3.25, inch:true, costPerM:0},
    {id:'galvanizado-redondo-1_1_2', material:'galvanizado', shape:'redondo', name:'1 1/2"', w:48.3, h:48.3, t:null, inch:true, costPerM:5.95},
    {id:'galvanizado-redondo-1_1_2_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'1 1/2" série média', w:48.3, h:48.3, t:3.25, inch:true, costPerM:5.95},
    {id:'galvanizado-redondo-2', material:'galvanizado', shape:'redondo', name:'2"', w:60.3, h:60.3, t:null, inch:true, costPerM:6.5},
    {id:'galvanizado-redondo-2_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'2" série média', w:60.3, h:60.3, t:3.65, inch:true, costPerM:8.9},
    {id:'galvanizado-redondo-2_1_2_s_rie_ligeira', material:'galvanizado', shape:'redondo', name:'2 1/2" série ligeira', w:76.1, h:76.1, t:3.25, inch:true, costPerM:8.8},
    {id:'galvanizado-redondo-2_1_2_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'2 1/2" série média', w:76.1, h:76.1, t:3.65, inch:true, costPerM:9.98},
    {id:'galvanizado-redondo-3_s_rie_ligeira', material:'galvanizado', shape:'redondo', name:'3" série ligeira', w:88.9, h:88.9, t:3.65, inch:true, costPerM:14.95},
    {id:'galvanizado-redondo-3_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'3" série média', w:88.9, h:88.9, t:4.05, inch:true, costPerM:13},
    {id:'galvanizado-redondo-3_1_2_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'3 1/2" série média', w:101.6, h:101.6, t:4.05, inch:true, costPerM:13.5},
    {id:'galvanizado-redondo-3_1_2_s_rie_ligeira', material:'galvanizado', shape:'redondo', name:'3 1/2" série ligeira', w:101.6, h:101.6, t:3.65, inch:true, costPerM:19.99},
    {id:'galvanizado-redondo-4_s_rie_ligeira', material:'galvanizado', shape:'redondo', name:'4" série ligeira', w:114.3, h:114.3, t:4.05, inch:true, costPerM:13.21},
    {id:'galvanizado-redondo-4_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'4" série média', w:114.3, h:114.3, t:4.5, inch:true, costPerM:16.53},
    {id:'galvanizado-redondo-5_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'5" série média', w:139.7, h:139.7, t:4.85, inch:true, costPerM:30},
    {id:'galvanizado-redondo-6_s_rie_m_dia', material:'galvanizado', shape:'redondo', name:'6" série média', w:168.3, h:168.3, t:4.85, inch:true, costPerM:36},
    {id:'galvanizado-redondo-40x1_5', material:'galvanizado', shape:'redondo', name:'Ø40x1,5', w:40, h:40, t:1.5, inch:false, costPerM:1.95},
    {id:'galvanizado-redondo-40x2', material:'galvanizado', shape:'redondo', name:'Ø40x2', w:40, h:40, t:2, inch:false, costPerM:2.95},
    {id:'galvanizado-redondo-30x1_5', material:'galvanizado', shape:'redondo', name:'Ø30x1,5', w:30, h:30, t:1.5, inch:false, costPerM:1.5},
    {id:'galvanizado-redondo-60x1_5', material:'galvanizado', shape:'redondo', name:'Ø60x1,5', w:60, h:60, t:1.5, inch:false, costPerM:3},
    {id:'galvanizado-redondo-60x2', material:'galvanizado', shape:'redondo', name:'Ø60x2', w:60, h:60, t:2, inch:false, costPerM:3.45},
    {id:'galvanizado-redondo-80x2', material:'galvanizado', shape:'redondo', name:'Ø80x2', w:80, h:80, t:2, inch:false, costPerM:6.2},
    {id:'galvanizado-quadrado-16x16x1_5', material:'galvanizado', shape:'quadrado', name:'16x16x1,5', w:16, h:16, t:1.5, inch:false, costPerM:1.1},
    {id:'galvanizado-quadrado-20x20x1_5', material:'galvanizado', shape:'quadrado', name:'20x20x1,5', w:20, h:20, t:1.5, inch:false, costPerM:1.2},
    {id:'galvanizado-quadrado-25x25x1_5', material:'galvanizado', shape:'quadrado', name:'25x25x1,5', w:25, h:25, t:1.5, inch:false, costPerM:1.55},
    {id:'galvanizado-quadrado-30x30x1_5', material:'galvanizado', shape:'quadrado', name:'30x30x1,5', w:30, h:30, t:1.5, inch:false, costPerM:1.75},
    {id:'galvanizado-quadrado-35x35x1_5', material:'galvanizado', shape:'quadrado', name:'35x35x1,5', w:35, h:35, t:1.5, inch:false, costPerM:2},
    {id:'galvanizado-quadrado-40x40x1_5', material:'galvanizado', shape:'quadrado', name:'40x40x1,5', w:40, h:40, t:1.5, inch:false, costPerM:2.45},
    {id:'galvanizado-quadrado-45x45x1_5', material:'galvanizado', shape:'quadrado', name:'45x45x1,5', w:45, h:45, t:1.5, inch:false, costPerM:2.75},
    {id:'galvanizado-quadrado-50x50x1_5', material:'galvanizado', shape:'quadrado', name:'50x50x1,5', w:50, h:50, t:1.5, inch:false, costPerM:2.9},
    {id:'galvanizado-quadrado-60x60x1_5', material:'galvanizado', shape:'quadrado', name:'60x60x1,5', w:60, h:60, t:1.5, inch:false, costPerM:4.85},
    {id:'galvanizado-quadrado-80x80x1_5', material:'galvanizado', shape:'quadrado', name:'80x80x1,5', w:80, h:80, t:1.5, inch:false, costPerM:8},
    {id:'galvanizado-quadrado-100x100x1_5', material:'galvanizado', shape:'quadrado', name:'100x100x1,5', w:100, h:100, t:1.5, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-30x30x2', material:'galvanizado', shape:'quadrado', name:'30x30x2', w:30, h:30, t:2, inch:false, costPerM:2.9},
    {id:'galvanizado-quadrado-30x30x3', material:'galvanizado', shape:'quadrado', name:'30x30x3', w:30, h:30, t:3, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-35x35x2', material:'galvanizado', shape:'quadrado', name:'35x35x2', w:35, h:35, t:2, inch:false, costPerM:3.8},
    {id:'galvanizado-quadrado-40x40x2', material:'galvanizado', shape:'quadrado', name:'40x40x2', w:40, h:40, t:2, inch:false, costPerM:3.95},
    {id:'galvanizado-quadrado-40x40x3', material:'galvanizado', shape:'quadrado', name:'40x40x3', w:40, h:40, t:3, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-40x40x4', material:'galvanizado', shape:'quadrado', name:'40x40x4', w:40, h:40, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-45x45x3', material:'galvanizado', shape:'quadrado', name:'45x45x3', w:45, h:45, t:3, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-50x50x2', material:'galvanizado', shape:'quadrado', name:'50x50x2', w:50, h:50, t:2, inch:false, costPerM:4.35},
    {id:'galvanizado-quadrado-50x50x3', material:'galvanizado', shape:'quadrado', name:'50x50x3', w:50, h:50, t:3, inch:false, costPerM:7.7},
    {id:'galvanizado-quadrado-50x50x4', material:'galvanizado', shape:'quadrado', name:'50x50x4', w:50, h:50, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-50x50x5', material:'galvanizado', shape:'quadrado', name:'50x50x5', w:50, h:50, t:5, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-60x60x2', material:'galvanizado', shape:'quadrado', name:'60x60x2', w:60, h:60, t:2, inch:false, costPerM:5.95},
    {id:'galvanizado-quadrado-60x60x3', material:'galvanizado', shape:'quadrado', name:'60x60x3', w:60, h:60, t:3, inch:false, costPerM:8.55},
    {id:'galvanizado-quadrado-60x60x4', material:'galvanizado', shape:'quadrado', name:'60x60x4', w:60, h:60, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-70x70x3', material:'galvanizado', shape:'quadrado', name:'70x70x3', w:70, h:70, t:3, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-70x70x4', material:'galvanizado', shape:'quadrado', name:'70x70x4', w:70, h:70, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-80x80x2', material:'galvanizado', shape:'quadrado', name:'80x80x2', w:80, h:80, t:2, inch:false, costPerM:8.52},
    {id:'galvanizado-quadrado-80x80x3', material:'galvanizado', shape:'quadrado', name:'80x80x3', w:80, h:80, t:3, inch:false, costPerM:13.25},
    {id:'galvanizado-quadrado-80x80x4', material:'galvanizado', shape:'quadrado', name:'80x80x4', w:80, h:80, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-100x100x2', material:'galvanizado', shape:'quadrado', name:'100x100x2', w:100, h:100, t:2, inch:false, costPerM:7.55},
    {id:'galvanizado-quadrado-100x100x3', material:'galvanizado', shape:'quadrado', name:'100x100x3', w:100, h:100, t:3, inch:false, costPerM:12.8},
    {id:'galvanizado-quadrado-100x100x4', material:'galvanizado', shape:'quadrado', name:'100x100x4', w:100, h:100, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-120x120x2', material:'galvanizado', shape:'quadrado', name:'120x120x2', w:120, h:120, t:2, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-120x120x3', material:'galvanizado', shape:'quadrado', name:'120x120x3', w:120, h:120, t:3, inch:false, costPerM:13},
    {id:'galvanizado-quadrado-120x120x4', material:'galvanizado', shape:'quadrado', name:'120x120x4', w:120, h:120, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-140x140x3', material:'galvanizado', shape:'quadrado', name:'140x140x3', w:140, h:140, t:3, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-140x140x4', material:'galvanizado', shape:'quadrado', name:'140x140x4', w:140, h:140, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-150x150x3', material:'galvanizado', shape:'quadrado', name:'150x150x3', w:150, h:150, t:3, inch:false, costPerM:27},
    {id:'galvanizado-quadrado-150x150x4', material:'galvanizado', shape:'quadrado', name:'150x150x4', w:150, h:150, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-160x160x4', material:'galvanizado', shape:'quadrado', name:'160x160x4', w:160, h:160, t:4, inch:false, costPerM:0},
    {id:'galvanizado-quadrado-200x200x4', material:'galvanizado', shape:'quadrado', name:'200x200x4', w:200, h:200, t:4, inch:false, costPerM:0},
    {id:'galvanizado-retangular-30x10x1_5', material:'galvanizado', shape:'retangular', name:'30x10x1,5', w:30, h:10, t:1.5, inch:false, costPerM:1.65},
    {id:'galvanizado-retangular-30x15x1_5', material:'galvanizado', shape:'retangular', name:'30x15x1,5', w:30, h:15, t:1.5, inch:false, costPerM:1.85},
    {id:'galvanizado-retangular-30x20x1_5', material:'galvanizado', shape:'retangular', name:'30x20x1,5', w:30, h:20, t:1.5, inch:false, costPerM:0},
    {id:'galvanizado-retangular-35x15x1_5', material:'galvanizado', shape:'retangular', name:'35x15x1,5', w:35, h:15, t:1.5, inch:false, costPerM:2.98},
    {id:'galvanizado-retangular-35x20x1_5', material:'galvanizado', shape:'retangular', name:'35x20x1,5', w:35, h:20, t:1.5, inch:false, costPerM:3.85},
    {id:'galvanizado-retangular-40x10x1_5', material:'galvanizado', shape:'retangular', name:'40x10x1,5', w:40, h:10, t:1.5, inch:false, costPerM:1.6},
    {id:'galvanizado-retangular-40x25x1_5', material:'galvanizado', shape:'retangular', name:'40x25x1,5', w:40, h:25, t:1.5, inch:false, costPerM:0},
    {id:'galvanizado-retangular-40x20x1_5', material:'galvanizado', shape:'retangular', name:'40x20x1,5', w:40, h:20, t:1.5, inch:false, costPerM:1.69},
    {id:'galvanizado-retangular-40x30x1_5', material:'galvanizado', shape:'retangular', name:'40x30x1,5', w:40, h:30, t:1.5, inch:false, costPerM:0},
    {id:'galvanizado-retangular-50x10x1_5', material:'galvanizado', shape:'retangular', name:'50x10x1,5', w:50, h:10, t:1.5, inch:false, costPerM:2.32},
    {id:'galvanizado-retangular-50x20x1_5', material:'galvanizado', shape:'retangular', name:'50x20x1,5', w:50, h:20, t:1.5, inch:false, costPerM:2.9},
    {id:'galvanizado-retangular-50x25x1_5', material:'galvanizado', shape:'retangular', name:'50x25x1,5', w:50, h:25, t:1.5, inch:false, costPerM:0},
    {id:'galvanizado-retangular-50x30x1_5', material:'galvanizado', shape:'retangular', name:'50x30x1,5', w:50, h:30, t:1.5, inch:false, costPerM:2.25},
    {id:'galvanizado-retangular-60x10x1_5', material:'galvanizado', shape:'retangular', name:'60x10x1,5', w:60, h:10, t:1.5, inch:false, costPerM:3.78},
    {id:'galvanizado-retangular-60x20x1_5', material:'galvanizado', shape:'retangular', name:'60x20x1,5', w:60, h:20, t:1.5, inch:false, costPerM:2.35},
    {id:'galvanizado-retangular-60x30x1_5', material:'galvanizado', shape:'retangular', name:'60x30x1,5', w:60, h:30, t:1.5, inch:false, costPerM:3},
    {id:'galvanizado-retangular-80x20x1_5', material:'galvanizado', shape:'retangular', name:'80x20x1,5', w:80, h:20, t:1.5, inch:false, costPerM:3.25},
    {id:'galvanizado-retangular-60x40x1_5', material:'galvanizado', shape:'retangular', name:'60x40x1,5', w:60, h:40, t:1.5, inch:false, costPerM:2.95},
    {id:'galvanizado-retangular-80x40x1_5', material:'galvanizado', shape:'retangular', name:'80x40x1,5', w:80, h:40, t:1.5, inch:false, costPerM:3.95},
    {id:'galvanizado-retangular-80x60x1_5', material:'galvanizado', shape:'retangular', name:'80x60x1,5', w:80, h:60, t:1.5, inch:false, costPerM:0},
    {id:'galvanizado-retangular-100x20x1_5', material:'galvanizado', shape:'retangular', name:'100x20x1,5', w:100, h:20, t:1.5, inch:false, costPerM:3.45},
    {id:'galvanizado-retangular-100x40x1_5', material:'galvanizado', shape:'retangular', name:'100x40x1,5', w:100, h:40, t:1.5, inch:false, costPerM:0},
    {id:'galvanizado-retangular-30x20x2', material:'galvanizado', shape:'retangular', name:'30x20x2', w:30, h:20, t:2, inch:false, costPerM:0},
    {id:'galvanizado-retangular-40x20x2', material:'galvanizado', shape:'retangular', name:'40x20x2', w:40, h:20, t:2, inch:false, costPerM:2.8},
    {id:'galvanizado-retangular-40x25x2', material:'galvanizado', shape:'retangular', name:'40x25x2', w:40, h:25, t:2, inch:false, costPerM:0},
    {id:'galvanizado-retangular-40x30x2', material:'galvanizado', shape:'retangular', name:'40x30x2', w:40, h:30, t:2, inch:false, costPerM:3.55},
    {id:'galvanizado-retangular-50x30x2', material:'galvanizado', shape:'retangular', name:'50x30x2', w:50, h:30, t:2, inch:false, costPerM:3.25},
    {id:'galvanizado-retangular-50x30x3', material:'galvanizado', shape:'retangular', name:'50x30x3', w:50, h:30, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-60x20x2', material:'galvanizado', shape:'retangular', name:'60x20x2', w:60, h:20, t:2, inch:false, costPerM:3.9},
    {id:'galvanizado-retangular-60x30x2', material:'galvanizado', shape:'retangular', name:'60x30x2', w:60, h:30, t:2, inch:false, costPerM:4.45},
    {id:'galvanizado-retangular-60x30x3', material:'galvanizado', shape:'retangular', name:'60x30x3', w:60, h:30, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-60x40x2', material:'galvanizado', shape:'retangular', name:'60x40x2', w:60, h:40, t:2, inch:false, costPerM:4.8},
    {id:'galvanizado-retangular-60x40x3', material:'galvanizado', shape:'retangular', name:'60x40x3', w:60, h:40, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-80x20x2', material:'galvanizado', shape:'retangular', name:'80x20x2', w:80, h:20, t:2, inch:false, costPerM:5.55},
    {id:'galvanizado-retangular-80x40x2', material:'galvanizado', shape:'retangular', name:'80x40x2', w:80, h:40, t:2, inch:false, costPerM:4.35},
    {id:'galvanizado-retangular-80x40x3', material:'galvanizado', shape:'retangular', name:'80x40x3', w:80, h:40, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-80x60x2', material:'galvanizado', shape:'retangular', name:'80x60x2', w:80, h:60, t:2, inch:false, costPerM:7.15},
    {id:'galvanizado-retangular-80x60x3', material:'galvanizado', shape:'retangular', name:'80x60x3', w:80, h:60, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-100x40x2', material:'galvanizado', shape:'retangular', name:'100x40x2', w:100, h:40, t:2, inch:false, costPerM:6.95},
    {id:'galvanizado-retangular-100x50x2', material:'galvanizado', shape:'retangular', name:'100x50x2', w:100, h:50, t:2, inch:false, costPerM:7.2},
    {id:'galvanizado-retangular-100x50x3', material:'galvanizado', shape:'retangular', name:'100x50x3', w:100, h:50, t:3, inch:false, costPerM:7.5},
    {id:'galvanizado-retangular-100x60x2', material:'galvanizado', shape:'retangular', name:'100x60x2', w:100, h:60, t:2, inch:false, costPerM:13.95},
    {id:'galvanizado-retangular-100x60x3', material:'galvanizado', shape:'retangular', name:'100x60x3', w:100, h:60, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-100x60x4', material:'galvanizado', shape:'retangular', name:'100x60x4', w:100, h:60, t:4, inch:false, costPerM:0},
    {id:'galvanizado-retangular-100x80x3', material:'galvanizado', shape:'retangular', name:'100x80x3', w:100, h:80, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-100x80x4', material:'galvanizado', shape:'retangular', name:'100x80x4', w:100, h:80, t:4, inch:false, costPerM:0},
    {id:'galvanizado-retangular-120x60x2', material:'galvanizado', shape:'retangular', name:'120x60x2', w:120, h:60, t:2, inch:false, costPerM:7.95},
    {id:'galvanizado-retangular-120x60x3', material:'galvanizado', shape:'retangular', name:'120x60x3', w:120, h:60, t:3, inch:false, costPerM:9},
    {id:'galvanizado-retangular-120x60x4', material:'galvanizado', shape:'retangular', name:'120x60x4', w:120, h:60, t:4, inch:false, costPerM:0},
    {id:'galvanizado-retangular-120x80x3', material:'galvanizado', shape:'retangular', name:'120x80x3', w:120, h:80, t:3, inch:false, costPerM:9},
    {id:'galvanizado-retangular-140x80x3', material:'galvanizado', shape:'retangular', name:'140x80x3', w:140, h:80, t:3, inch:false, costPerM:12.5},
    {id:'galvanizado-retangular-140x60x3', material:'galvanizado', shape:'retangular', name:'140x60x3', w:140, h:60, t:3, inch:false, costPerM:0},
    {id:'galvanizado-retangular-160x80x3', material:'galvanizado', shape:'retangular', name:'160x80x3', w:160, h:80, t:3, inch:false, costPerM:14.25},
    {id:'galvanizado-retangular-160x80x4', material:'galvanizado', shape:'retangular', name:'160x80x4', w:160, h:80, t:4, inch:false, costPerM:28.86},
    {id:'galvanizado-retangular-180x80x3', material:'galvanizado', shape:'retangular', name:'180x80x3', w:180, h:80, t:3, inch:false, costPerM:20.5},
    {id:'galvanizado-retangular-200x100x3', material:'galvanizado', shape:'retangular', name:'200x100x3', w:200, h:100, t:3, inch:false, costPerM:24.15},
    {id:'galvanizado-retangular-200x100x6', material:'galvanizado', shape:'retangular', name:'200x100x6', w:200, h:100, t:6, inch:false, costPerM:0},
    {id:'galvanizado-retangular-200x100x4', material:'galvanizado', shape:'retangular', name:'200x100x4', w:200, h:100, t:4, inch:false, costPerM:0},
    {id:'inox-redondo-20x1_5', material:'inox', shape:'redondo', name:'Ø20x1,5', w:20, h:20, t:1.5, inch:false, costPerM:0},
    {id:'inox-redondo-25x1_5', material:'inox', shape:'redondo', name:'Ø25x1,5', w:25, h:25, t:1.5, inch:false, costPerM:0},
    {id:'inox-redondo-30x1_5', material:'inox', shape:'redondo', name:'Ø30x1,5', w:30, h:30, t:1.5, inch:false, costPerM:0},
    {id:'inox-redondo-40x1_5', material:'inox', shape:'redondo', name:'Ø40x1,5', w:40, h:40, t:1.5, inch:false, costPerM:6.5},
    {id:'inox-redondo-50x1_5', material:'inox', shape:'redondo', name:'Ø50x1,5', w:50, h:50, t:1.5, inch:false, costPerM:0},
    {id:'inox-redondo-60_3x1_5', material:'inox', shape:'redondo', name:'Ø60,3x1,5', w:60.3, h:60.3, t:1.5, inch:false, costPerM:9.5},
    {id:'inox-redondo-80x1_5', material:'inox', shape:'redondo', name:'Ø80x1,5', w:80, h:80, t:1.5, inch:false, costPerM:14.5},
    {id:'inox-quadrado-40x40', material:'inox', shape:'quadrado', name:'40x40', w:40, h:40, t:null, inch:false, costPerM:6.45},
    {id:'inox-quadrado-20x20x1_5', material:'inox', shape:'quadrado', name:'20x20x1,5', w:20, h:20, t:1.5, inch:false, costPerM:0},
    {id:'inox-quadrado-25x25x1_5', material:'inox', shape:'quadrado', name:'25x25x1,5', w:25, h:25, t:1.5, inch:false, costPerM:0},
    {id:'inox-quadrado-30x30x1_5', material:'inox', shape:'quadrado', name:'30x30x1,5', w:30, h:30, t:1.5, inch:false, costPerM:6.5},
    {id:'inox-quadrado-40x40x1_5', material:'inox', shape:'quadrado', name:'40x40x1,5', w:40, h:40, t:1.5, inch:false, costPerM:7.5},
    {id:'inox-quadrado-50x50x1_5', material:'inox', shape:'quadrado', name:'50x50x1,5', w:50, h:50, t:1.5, inch:false, costPerM:0},
    {id:'inox-quadrado-60x60x1_5', material:'inox', shape:'quadrado', name:'60x60x1,5', w:60, h:60, t:1.5, inch:false, costPerM:0},
    {id:'inox-quadrado-80x80x1_4', material:'inox', shape:'quadrado', name:'80x80x1,4', w:80, h:80, t:1.4, inch:false, costPerM:0},
    {id:'inox-quadrado-100x100x1_5', material:'inox', shape:'quadrado', name:'100x100x1,5', w:100, h:100, t:1.5, inch:false, costPerM:0},
    {id:'inox-retangular-60x40', material:'inox', shape:'retangular', name:'60x40', w:60, h:40, t:null, inch:false, costPerM:9.05},
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
    const raw = await storageGet('laser_tube_profiles_v2');
    if(raw){ try{ return JSON.parse(raw); }catch(e){} }
    return JSON.parse(JSON.stringify(LC.DEFAULT_TUBE_PROFILES));
  };
  LC.saveTubeProfiles = async function(list){
    await storageSet('laser_tube_profiles_v2', JSON.stringify(list));
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
  // O Supabase devolve no máximo 1000 linhas por pedido — vai buscando páginas seguidas até
  // vir uma incompleta, senão as encomendas mais antigas desapareciam das listas sem aviso.
  const REMOTE_PAGE_SIZE = 1000;
  async function remoteFetchAll(remoteCfg, query){
    const all = [];
    for(let offset = 0; ; offset += REMOTE_PAGE_SIZE){
      const res = await fetch(remoteBase(remoteCfg) + '/rest/v1/orders?' + query + '&limit=' + REMOTE_PAGE_SIZE + '&offset=' + offset, { headers: await remoteHeaders(remoteCfg) });
      if(!res.ok) throw await remoteRequestError(res);
      const rows = await res.json();
      all.push(...rows);
      if(rows.length < REMOTE_PAGE_SIZE) return all;
    }
  }
  LC.remoteLoadOrders = async function(remoteCfg, opts){
    const fields = (opts && opts.light) ? ORDERS_LIST_FIELDS : '*';
    const rows = await remoteFetchAll(remoteCfg, 'select=' + fields + '&order=created_at.desc,id.desc');
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
        scan(await remoteFetchAll(remoteCfg, 'select=order_number&order_number=like.' + year + '_*&order=id.asc'));
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
      if(o.pieceType === 'tube') return; // tubo: já não há velocidades de corte para calibrar
      if(cs.estimadoCuttingTimeMin==null || !isFinite(cs.estimadoCuttingTimeMin)) return;
      if(!isFinite(cs.cuttingTimeMin)) return;
      if(cs.cuttingTimeMin <= 0) return; // tempo real 0 min = não houve corte medido (ex.: encomenda sem corte) — não serve para calibrar velocidades
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
  /* FINAL COST — fecho da encomenda com o tempo de corte real.         */
  /* Só o custo de corte muda: material, desenho, setup e ajuste ficam   */
  /* exatamente como no orçamento aceite (mesmo que os preços tenham     */
  /* mudado entretanto). O corte usa o custo/hora gravado na encomenda.  */
  /* ---------------------------------------------------------------- */
  LC.recomputeFinalCost = async function(rec, realCuttingTimeMin){
    const cs = rec.costSnapshot || {};
    const qty = rec.quantity || 1;

    // Encomendas de tubo (novo método): o corte não se cobra, o tempo real é só registo — o preço
    // fica exatamente como estava; só passa a "final" com o tempo registado.
    if(cs.noCuttingCharge){
      return Object.assign({}, cs, { cuttingTimeMin: realCuttingTimeMin, isFinal: true });
    }

    let hourlyRate = rec.machineSnapshot && rec.machineSnapshot.hourlyRate;
    if(!isFinite(hourlyRate)){
      try{ hourlyRate = (await LC.loadMachine()).hourlyRate; }catch(e){}
    }
    hourlyRate = hourlyRate || 0;
    // O tempo real introduzido é sempre o TOTAL da encomenda (todas as peças, já inclui
    // perfurações) — não se soma nem se multiplica mais nada a este tempo.
    const corteCost = (realCuttingTimeMin/60) * hourlyRate;
    const delta = corteCost - (isFinite(cs.corteCost) ? cs.corteCost : 0);

    // Tudo o resto acompanha só a diferença do corte (delta) — o material nunca é recalculado,
    // por isso também não importa se o ficheiro era de 1 peça ou de todas as peças aninhadas.
    const totalCost = isFinite(cs.totalCost)
      ? cs.totalCost + delta
      : corteCost + (cs.materialCost||0)*qty + (cs.preCorteCost||0) + (cs.adjustmentValue||0);
    const out = {
      cuttingTimeMin: realCuttingTimeMin,
      corteCost, totalCost, avgPerPiece: totalCost / qty,
      isFinal: true,
    };
    if(isFinite(cs.subtotal)) out.subtotal = cs.subtotal + delta;
    if(isFinite(cs.realCost)){
      out.realCost = cs.realCost + delta;
      out.marginValue = totalCost - out.realCost;
      out.marginPct = out.realCost > 0 ? (out.marginValue/out.realCost)*100 : null;
    }
    return Object.assign({}, cs, out);
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
    const ms = rec.materialSnapshot;
    if(rec.pieceType === 'tube'){
      const t = rec.tubeInputs || {};
      lines.push('Perfil: ' + (ms ? ms.name : '—'));
      lines.push('Quantidade: ' + (rec.quantity || 1));
      if(t.lengthMm) lines.push('Comprimento de corte: ' + fmtNum(t.lengthMm,0) + ' mm');
      if(t.bars) lines.push('Barras: ' + t.bars + ' × ' + fmtNum(t.barLengthMm||0,0) + ' mm');
      if(rec.comments) lines.push('Comentários: ' + rec.comments);
      lines.push('');
      if(rec.costSnapshot){
        lines.push('Valores no momento de gravação:');
        if(rec.costSnapshot.adjustmentValue) lines.push('  Ajuste comercial: ' + fmtEUR(rec.costSnapshot.adjustmentValue) + (rec.costSnapshot.adjustmentReason ? ' (' + rec.costSnapshot.adjustmentReason + ')' : ''));
        lines.push('  TOTAL da encomenda (sem IVA): ' + fmtEUR(rec.costSnapshot.totalCost));
        lines.push('  TOTAL ÷ nº peças (sem IVA): ' + fmtEUR(rec.costSnapshot.avgPerPiece));
      }
      return lines.join('\n');
    }
    lines.push('Material: ' + (ms ? (ms.name + (ms.thickness != null ? ' — ' + ms.thickness + ' mm' : '')) : '—'));
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
  // A barra de ações fixa (index.html/tubo.html) quebra para várias linhas em ecrãs estreitos,
  // ficando bem mais alta do que o padding-bottom fixo do body — sem isto, o rodapé da página
  // fica escondido atrás da barra. Mede a altura real e ajusta sempre que ela muda.
  LC.syncActionBarPadding = function(){
    const bar = document.querySelector('.action-bar');
    if(!bar) return;
    const apply = () => { document.body.style.paddingBottom = (bar.offsetHeight + 16) + 'px'; };
    apply();
    window.addEventListener('resize', apply);
    if(typeof ResizeObserver !== 'undefined') new ResizeObserver(apply).observe(bar);
  };

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
        const k = (o.pieceType === 'tube' || ms.thickness == null) ? ms.name : (ms.name + ' ' + ms.thickness + 'mm');
        byMaterial[k] = (byMaterial[k]||0) + 1;
      }
      const c = (o.client||'').trim();
      if(c){
        const k = LC.searchKey(c);
        if(!byClient[k]) byClient[k] = { name:c, count:0, value:0 };
        byClient[k].count++;
        byClient[k].value += cs ? (cs.totalCost||0) : 0;
      }
      if(cs && isFinite(cs.cuttingTimeMin)) cuttingMin += cs.cuttingTimeMin;
    });

    const topMaterial = Object.entries(byMaterial).sort((a,b)=>b[1]-a[1])[0] || null;
    const topClient = Object.values(byClient).sort((a,b)=>b.count-a.count)[0] || null;

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
      topClient: topClient ? { name: topClient.name, count: topClient.count, value: topClient.value } : null,
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
        action:'Ver lista', href:'orcamentos.html',
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
        action:'Registar', href:'producao.html',
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
  /* MATERIAIS MAIS USADOS num período — para o gráfico circular do     */
  /* Dashboard. Conta encomendas por material (chapa e tubo juntos),    */
  /* agrupado só pelo nome — espessuras/perfis diferentes do mesmo      */
  /* material contam para a mesma fatia.                                */
  /* ---------------------------------------------------------------- */
  LC.summarizeMaterialUsage = function(orders, sinceDate){
    const since = sinceDate ? new Date(sinceDate).getTime() : 0;
    const counts = {};
    (orders||[]).forEach(o=>{
      if(o.orderState === 'cancelled') return;
      if(!o.createdAt || new Date(o.createdAt).getTime() < since) return;
      const ms = o.materialSnapshot;
      if(!ms || !ms.name) return;
      const key = ms.name;
      counts[key] = (counts[key]||0) + 1;
    });
    return Object.entries(counts)
      .map(([name,count])=>({name, count}))
      .sort((a,b)=>b.count-a.count);
  };

  /* ---------------------------------------------------------------- */
  /* RESUMO DO DIA — encomendas criadas/concluídas hoje e o que está    */
  /* em produção neste momento. "Concluída hoje" usa costSnapshot.      */
  /* completedAt, gravado só na primeira vez que a encomenda passa a    */
  /* "Concluído" (dentro do cost_snapshot já existente — sem precisar   */
  /* de alterar a tabela do Supabase).                                  */
  /* ---------------------------------------------------------------- */
  /* FATURADO — só contam encomendas concluídas, na data de conclusão   */
  /* (completedAt). Encomendas antigas sem essa data usam a de criação. */
  LC.isBilled = o => o.orderState === 'done';
  LC.billedAt = function(o){
    if(!LC.isBilled(o)) return null;
    return (o.costSnapshot && o.costSnapshot.completedAt) || o.createdAt || null;
  };

  LC.summarizeToday = function(orders){
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const isToday = iso => !!iso && new Date(iso).getTime() >= dayStart;
    let created = 0, completed = 0, inProduction = 0;
    (orders||[]).forEach(o=>{
      if(isToday(o.createdAt)) created++;
      if(o.costSnapshot && isToday(o.costSnapshot.completedAt)) completed++;
      if((o.orderState||'production') === 'production') inProduction++;
    });
    return { created, completed, inProduction };
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

  // Telemóvel: o menu de páginas passa a uma faixa com scroll horizontal — centra a página
  // atual, senão ficava escondida no fim (ex.: Histórico, Definições).
  (function scrollActiveNavIntoView(){
    const nav = document.querySelector('nav.pagenav');
    const a = nav && nav.querySelector('a.active');
    if(!a || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = a.offsetLeft - nav.offsetLeft - (nav.clientWidth - a.offsetWidth)/2;
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

  (function(){
  /* Helpers de formatação usados pelo desenho IGES (partilhado entre tubo.html e producao-item.html). */
  const fmtC = n => String(n).replace('.', ',');
  const fmtThousands = n => Math.round(n).toLocaleString('pt-PT');
  const escapeHtml = LC.escapeHtml;
  /* ---------------------------------------------------------------- */
  /* IGES — desenho em tira (tubo inteiro + ampliação) e resumo        */
  /* ---------------------------------------------------------------- */
  function igesMainView(iges){ return (iges.groups && iges.groups[0] && iges.groups[0].view) || 'A'; }
  function igesPolys(iges, view){ return view === 'B' ? iges.B : iges.A; }
  function igesExt(iges, view){ return view === 'B' ? iges.sectionH : iges.sectionW; }

  // from/to em mm ao longo do tubo; W = largura máxima em px; maxTubeH = altura máxima do tubo em px
  function igesStripSVG(iges, view, from, to, W, maxTubeH, opts){
    opts = opts || {};
    const pad = 10, ext = igesExt(iges, view) || 1;
    const sc = Math.min((W - 2*pad) / (to - from), maxTubeH / ext);
    const width = (to - from) * sc + 2*pad;
    const tubeH = ext * sc;
    const g = iges.groups && iges.groups[0];
    const mainView = igesMainView(iges);
    const showGroupDims = !!(g && view === mainView);
    const top = 16, cy = top + tubeH/2, yb = top + tubeH;
    const x = a => pad + (a - from) * sc;
    const y = u => cy - u * sc;
    const f = n => n.toFixed(1);
    const dim = 'stroke="currentColor" stroke-opacity=".55" stroke-width="0.8"';
    const txt = 'font-size="10" font-family="Inter,sans-serif" fill="currentColor" fill-opacity=".75" text-anchor="middle"';
    let body = '';
    igesPolys(iges, view).forEach(flat=>{
      let d = '';
      for(let i=0;i<flat.length;i+=2) d += (i ? 'L' : 'M') + f(x(flat[i])) + ' ' + f(y(flat[i+1]));
      body += '<path d="'+d+'" fill="none" stroke="currentColor" stroke-width="'+(opts.zoom ? 1.4 : 1)+'" stroke-linejoin="round"/>';
    });
    const hDim = (a0, a1, yy, label) =>
      '<line x1="'+f(x(a0))+'" y1="'+f(yy)+'" x2="'+f(x(a1))+'" y2="'+f(yy)+'" '+dim+'/>' +
      '<line x1="'+f(x(a0))+'" y1="'+f(yy-4)+'" x2="'+f(x(a0))+'" y2="'+f(yy+4)+'" '+dim+'/>' +
      '<line x1="'+f(x(a1))+'" y1="'+f(yy-4)+'" x2="'+f(x(a1))+'" y2="'+f(yy+4)+'" '+dim+'/>' +
      '<text x="'+f((x(a0)+x(a1))/2)+'" y="'+f(yy+13)+'" '+txt+'>'+label+'</text>';
    let rows = 0;
    if(opts.zoom){
      if(showGroupDims){
        body += hDim(g.first, g.first + g.la, yb + 14, fmtC(g.la) + ' mm'); rows = 1;
        if(g.regular && g.first + g.pitch <= to){ body += hDim(g.first, g.first + g.pitch, yb + 40, fmtC(g.pitch) + ' mm (passo)'); rows = 2; }
        // largura do rasgo (cota vertical, à esquerda do 1.º rasgo)
        const gx = x(g.first) - 14;
        if(gx > pad){
          body += '<line x1="'+f(gx)+'" y1="'+f(y(g.mid + g.cross/2))+'" x2="'+f(gx)+'" y2="'+f(y(g.mid - g.cross/2))+'" '+dim+'/>' +
            '<line x1="'+f(gx-4)+'" y1="'+f(y(g.mid + g.cross/2))+'" x2="'+f(gx+4)+'" y2="'+f(y(g.mid + g.cross/2))+'" '+dim+'/>' +
            '<line x1="'+f(gx-4)+'" y1="'+f(y(g.mid - g.cross/2))+'" x2="'+f(gx+4)+'" y2="'+f(y(g.mid - g.cross/2))+'" '+dim+'/>' +
            '<text x="'+f(gx-6)+'" y="'+f(y(g.mid))+'" transform="rotate(-90 '+f(gx-6)+' '+f(y(g.mid))+')" '+txt+'>'+fmtC(g.cross)+' mm</text>';
        }
        body += '<text x="'+f(x(g.first))+'" y="'+f(top-4)+'" '+txt+'>'+fmtThousands(g.first)+'</text>';
      }
    } else {
      if(showGroupDims){ body += hDim(0, g.first, yb + 14, fmtThousands(g.first) + ' mm'); rows = 1; }
      body += hDim(0, iges.lengthMm, yb + 14 + rows*24 + (rows ? 8 : 0), fmtThousands(iges.lengthMm) + ' mm'); rows += 1;
      if(opts.zoomFrom != null){
        body += '<rect x="'+f(x(opts.zoomFrom))+'" y="'+f(top-6)+'" width="'+f((opts.zoomTo-opts.zoomFrom)*sc)+'" height="'+f(tubeH+12)+'" fill="none" stroke="#2563eb" stroke-width="0.9" stroke-dasharray="3 2"/>';
      }
    }
    const H = yb + 14 + rows*28 + 14;
    return '<svg width="'+f(width)+'" height="'+f(H)+'" viewBox="0 0 '+f(width)+' '+f(H)+'" style="display:block; max-width:100%;">' + body + '</svg>';
  }

  function igesZoomRange(iges){
    const g = iges.groups && iges.groups[0];
    if(!g) return null;
    const ext = igesExt(iges, igesMainView(iges)) || 1;
    const W = 690, pad = 10;
    const sc = Math.min((W - 2*pad) / 200, 150 / ext);
    const span = Math.min(iges.lengthMm, (W - 2*pad) / sc);
    let from = Math.max(0, g.first - 50);
    if(from + span > iges.lengthMm) from = Math.max(0, iges.lengthMm - span);
    return { from, to: from + span };
  }

  function igesSummaryLines(iges){
    return (iges.groups || []).slice(0,4).map(g=>{
      let t = g.count + (g.count===1 ? ' rasgo' : ' rasgos') + ' de ' + fmtC(g.la) + ' × ' + fmtC(g.cross) + ' mm';
      if(g.regular) t += ' · passo de ' + fmtC(g.pitch) + ' mm · do 1.º (aos ' + fmtThousands(g.first) + ' mm) ao último (aos ' + fmtThousands(g.last) + ' mm)';
      else if(g.count > 1) t += ' · a partir dos ' + fmtThousands(g.first) + ' mm';
      else t += ' · aos ' + fmtThousands(g.first) + ' mm';
      return t;
    });
  }

  function igesBlockHTML(iges, forPrint){
    const mainView = igesMainView(iges), otherView = mainView === 'A' ? 'B' : 'A';
    const z = igesZoomRange(iges);
    const W = forPrint ? 690 : 560;
    let h = '<div style="color:#111;">';
    h += '<div class="p-costs-title" style="margin-bottom:6px;">Desenho do ficheiro IGES' + (iges.name ? ' <span style="font-weight:400; font-size:11px; color:#555;">(' + escapeHtml(iges.name) + ')</span>' : '') + '</div>';
    h += igesStripSVG(iges, mainView, 0, iges.lengthMm, W, 120, z ? { zoomFrom:z.from, zoomTo:z.to } : {});
    if(z){
      h += '<div style="font-size:10.5px; color:#555; margin:6px 0 2px;">Ampliação, de ' + fmtThousands(z.from) + ' a ' + fmtThousands(z.to) + ' mm</div>';
      h += igesStripSVG(iges, mainView, z.from, z.to, W, 150, { zoom:true });
    }
    h += '<div style="font-size:10.5px; color:#555; margin:6px 0 2px;">Vista rodada 90°</div>';
    h += igesStripSVG(iges, otherView, 0, iges.lengthMm, W, 120, {});
    const lines = igesSummaryLines(iges);
    if(lines.length){
      h += '<div style="margin-top:8px; font-size:13px; line-height:1.55;"><strong>Resumo dos cortes</strong>' + lines.map(l=>'<div>'+escapeHtml(l)+'</div>').join('') +
        '<div style="font-size:10.5px; color:#555; margin-top:3px;">Lido do ficheiro IGES — posições medidas desde a ponta esquerda do desenho. Confirmar no computador.</div></div>';
    } else {
      h += '<div style="margin-top:8px; font-size:11px; color:#555;">Lido do ficheiro IGES. Confirmar no computador.</div>';
    }
    return h + '</div>';
  }
  Object.assign(LC, { igesMainView, igesStripSVG, igesZoomRange, igesSummaryLines, igesBlockHTML });

  })();

  /* ---------------------------------------------------------------- */
  /* IGES — lê as arestas de um tubo/perfil para o desenho do operador  */
  /* (curvas 3D das fronteiras das superfícies; não lê sólidos nem      */
  /* superfícies "cheias" — só o contorno, que é o que se desenha).     */
  /* ---------------------------------------------------------------- */
  LC.parseIGES = function(text){
    const lines = text.split(/\r?\n/);
    const S = { D:[], P:[], G:[] };
    lines.forEach(l=>{ if(l.length<73) return; const c=l[72]; if(S[c]) S[c].push(l); });
    if(S.D.length<2) throw new Error('Ficheiro IGES inválido (sem secção de entidades).');
    const G = S.G.map(l=>l.slice(0,72)).join('');
    const pd = (G[0]==='1' && G[1]==='H') ? G[2] : ',';

    const ents = {};
    for(let i=0;i+1<S.D.length;i+=2){
      const l1=S.D[i], l2=S.D[i+1];
      ents[i+1] = { type:parseInt(l1.slice(0,8),10), pStart:parseInt(l1.slice(8,16),10),
        matrix:parseInt(l1.slice(48,56),10)||0, pCount:parseInt(l2.slice(24,32),10) };
    }
    Object.values(ents).forEach(e=>{
      let s=''; for(let k=0;k<e.pCount;k++){ const l=S.P[e.pStart-1+k]; if(l) s+=l.slice(0,64); }
      s=s.trim(); const end=s.lastIndexOf(';'); if(end>=0) s=s.slice(0,end);
      e.p = s.split(pd).map(t=>t.trim().replace(/D/g,'E'));
    });

    const num = t => parseFloat(t);
    const matOf = seq => { const m=ents[seq]; return (seq && m && m.type===124) ? m.p.slice(1,13).map(num) : null; };
    const applyM = (m,p) => m ? [ m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[3], m[4]*p[0]+m[5]*p[1]+m[6]*p[2]+m[7], m[8]*p[0]+m[9]*p[1]+m[10]*p[2]+m[11] ] : p;

    function bspline(e){
      const p=e.p, K=parseInt(p[1],10), M=parseInt(p[2],10), nk=K+M+2; let idx=7;
      const T=[]; for(let i=0;i<nk;i++) T.push(num(p[idx++]));
      const W=[]; for(let i=0;i<=K;i++) W.push(num(p[idx++]));
      const P=[]; for(let i=0;i<=K;i++){ P.push([num(p[idx++]),num(p[idx++]),num(p[idx++])]); }
      const v0=num(p[idx++]), v1=num(p[idx++]);
      const N=Math.max(12,(K+1)*6), pts=[];
      for(let n=0;n<=N;n++){
        const u=v0+(v1-v0)*n/N;
        let s=M; for(let i=M;i<=K;i++){ if(u>=T[i]) s=i; } s=Math.min(s,K);
        const Nb=new Array(M+1).fill(0); Nb[0]=1; const left=[], right=[];
        for(let j=1;j<=M;j++){
          left[j]=u-T[s+1-j]; right[j]=T[s+j]-u; let saved=0;
          for(let r=0;r<j;r++){ const d=right[r+1]+left[j-r]; const tmp=d===0?0:Nb[r]/d; Nb[r]=saved+right[r+1]*tmp; saved=left[j-r]*tmp; }
          Nb[j]=saved;
        }
        let x=0,y=0,z=0,w=0;
        for(let j=0;j<=M;j++){ const i=s-M+j; const b=Nb[j]*W[i]; x+=b*P[i][0]; y+=b*P[i][1]; z+=b*P[i][2]; w+=b; }
        pts.push([x/w,y/w,z/w]);
      }
      return pts;
    }
    function curvePoints(seq, depth){
      const e=ents[seq]; if(!e || (depth||0)>6) return [];
      const m=matOf(e.matrix), p=e.p; let pts=[];
      if(e.type===110){ pts=[[num(p[1]),num(p[2]),num(p[3])],[num(p[4]),num(p[5]),num(p[6])]]; }
      else if(e.type===100){
        const zt=num(p[1]), cx=num(p[2]), cy=num(p[3]), sx=num(p[4]), sy=num(p[5]), ex=num(p[6]), ey=num(p[7]);
        const r=Math.hypot(sx-cx,sy-cy), a0=Math.atan2(sy-cy,sx-cx); let a1=Math.atan2(ey-cy,ex-cx);
        if(a1<=a0+1e-9) a1+=2*Math.PI;
        const n=Math.max(8,Math.ceil((a1-a0)/(Math.PI/36)));
        for(let i=0;i<=n;i++){ const a=a0+(a1-a0)*i/n; pts.push([cx+r*Math.cos(a),cy+r*Math.sin(a),zt]); }
      }
      else if(e.type===126){ pts=bspline(e); }
      else if(e.type===102){
        const n=parseInt(p[1],10); let all=[];
        for(let i=0;i<n;i++){ const sub=curvePoints(parseInt(p[2+i],10),(depth||0)+1); if(sub.length) all=all.concat(sub); }
        return all.map(q=>applyM(m,q));
      } else return [];
      return pts.map(q=>applyM(m,q));
    }

    // curvas de fronteira (142 -> curva 3D) e contornos interiores de cada superfície recortada (144)
    const curves=[], seenCurve=new Set(), loops=[];
    Object.values(ents).forEach(e=>{
      if(e.type===142){
        const c=parseInt(e.p[4],10);
        if(c && !seenCurve.has(c)){ seenCurve.add(c); const pts=curvePoints(c); if(pts.length>1) curves.push(pts); }
      } else if(e.type===144){
        const n2=parseInt(e.p[3],10)||0;
        for(let i=0;i<n2;i++){
          const b=ents[parseInt(e.p[5+i],10)]; if(!b || b.type!==142) continue;
          const pts=curvePoints(parseInt(b.p[4],10)); if(pts.length>=3) loops.push(pts);
        }
      }
    });
    if(!curves.length) throw new Error('Não foram encontradas arestas neste IGES (precisa de superfícies recortadas ou curvas).');

    const mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9];
    curves.forEach(c=>c.forEach(p=>{ for(let i=0;i<3;i++){ if(p[i]<mn[i]) mn[i]=p[i]; if(p[i]>mx[i]) mx[i]=p[i]; } }));
    const ext=[mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]];
    const ax = ext[0]>=ext[1] && ext[0]>=ext[2] ? 0 : (ext[1]>=ext[2] ? 1 : 2);
    const ui = ax===0 ? 1 : 0, vi = ax===2 ? 1 : 2;
    const uc=(mn[ui]+mx[ui])/2, vc=(mn[vi]+mx[vi])/2;
    const L=ext[ax], secW=ext[ui], secH=ext[vi];
    const r1 = n => Math.round(n*10)/10;
    const toA = p => [p[ax]-mn[ax], p[ui]-uc];
    const toB = p => [p[ax]-mn[ax], p[vi]-vc];

    function simplify(pts){
      const out=[pts[0]];
      for(let i=1;i<pts.length-1;i++){
        const p0=out[out.length-1], p1=pts[i], p2=pts[i+1];
        const cross=(p1[0]-p0[0])*(p2[1]-p0[1])-(p1[1]-p0[1])*(p2[0]-p0[0]);
        const len=Math.hypot(p2[0]-p0[0],p2[1]-p0[1])||1;
        if(Math.abs(cross)/len>0.04) out.push(p1);
      }
      out.push(pts[pts.length-1]); return out;
    }
    function project(fn){
      const out=[], seen=new Set();
      curves.forEach(c=>{
        const pts=simplify(c.map(fn));
        let len=0; for(let i=1;i<pts.length;i++) len+=Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
        if(len<0.3) return;
        const flat=[]; pts.forEach(q=>{ flat.push(r1(q[0]), r1(q[1])); });
        const key=flat.join(','), keyRev=(function(){ const f=[]; for(let i=flat.length-2;i>=0;i-=2) f.push(flat[i],flat[i+1]); return f.join(','); })();
        if(seen.has(key) || seen.has(keyRev)) return;
        seen.add(key); out.push(flat);
      });
      return out;
    }

    // rasgos: contornos interiores fechados, agrupados por tamanho
    const slotMap={};
    loops.forEach(pts=>{
      const lmn=[1e9,1e9,1e9], lmx=[-1e9,-1e9,-1e9];
      pts.forEach(p=>{ for(let i=0;i<3;i++){ if(p[i]<lmn[i]) lmn[i]=p[i]; if(p[i]>lmx[i]) lmx[i]=p[i]; } });
      const la=lmx[ax]-lmn[ax], lu=lmx[ui]-lmn[ui], lv=lmx[vi]-lmn[vi];
      const cross=Math.max(lu,lv);
      if(la<0.5 || cross<0.5 || la>L*0.9) return;   // ignora contornos enormes (ex.: contorno do próprio tubo)
      const normalIsU = lu < lv;
      const side = (normalIsU ? 'u' : 'v') + ((normalIsU ? (lmn[ui]+lmx[ui])/2-uc : (lmn[vi]+lmx[vi])/2-vc) >= 0 ? '+' : '-');
      const key=[r1(la), r1(cross), r1(lmn[ax]-mn[ax]), side].join('|');
      const mid = normalIsU ? (lmn[vi]+lmx[vi])/2-vc : (lmn[ui]+lmx[ui])/2-uc;   // centro do rasgo na direção transversal
      if(!slotMap[key]) slotMap[key]={ la:r1(la), cross:r1(cross), start:r1(lmn[ax]-mn[ax]), side, mid:r1(mid), view: normalIsU ? 'B' : 'A' };
    });
    const bySize={};
    Object.values(slotMap).forEach(s=>{ const k=s.la+'x'+s.cross; (bySize[k]=bySize[k]||[]).push(s); });
    const groups = Object.values(bySize).map(list=>{
      list.sort((a,b)=>a.start-b.start);
      const pitches=[]; for(let i=1;i<list.length;i++) pitches.push(r1(list[i].start-list[i-1].start));
      const regular = list.length>2 && pitches.every(p=>Math.abs(p-pitches[0])<=0.2);
      return { count:list.length, la:list[0].la, cross:list[0].cross, first:list[0].start, last:list[list.length-1].start,
        pitch: regular ? pitches[0] : null, regular, sides:Array.from(new Set(list.map(s=>s.side))),
        mid:list[0].mid, view:list[0].view };
    }).sort((a,b)=>b.count-a.count);

    return { lengthMm:r1(L), sectionW:r1(secW), sectionH:r1(secH), A:project(toA), B:project(toB), groups };
  };

  window.LC = LC;
})();
