/* KINETA · landing cinematográfica (spec).
   Portada: el clip de Kling avanza con el scroll (video con un cuadro clave por cuadro para que la búsqueda sea fluida).
   Resto: fondo en canvas con cámara en vivo y disolvencias, fundido entre secciones. Nunca se ve nada cargando:
   la intro espera a que el video y la primera imagen estén decodificados, se precargan las siguientes y,
   si una no está lista, el fondo se queda en la actual. */
(function () {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = document.getElementById('fondo'), ctx = cv.getContext('2d'), vid = document.getElementById('vid');
  const hero = document.querySelector('[data-video]'), intro = document.getElementById('intro');
  const planos = [...document.querySelectorAll('.plano')];
  let smooth = 0, running = false, vt = 0;

  /* ---------- imágenes: decodificadas antes de usarse ---------- */
  const cache = new Map();
  function img(src) {
    if (cache.has(src)) return cache.get(src);
    const im = new Image(), e = {im, ok: false, blur: null};
    im.src = src;
    (im.decode ? im.decode() : new Promise(r => im.onload = r)).then(() => {
      const sm = document.createElement('canvas'); sm.width = 40; sm.height = Math.round(40 * im.naturalHeight / im.naturalWidth);
      sm.getContext('2d').drawImage(im, 0, 0, sm.width, sm.height); e.blur = sm; e.ok = true; kick();
    }).catch(() => {});
    cache.set(src, e); return e;
  }
  const lista = planos.map(p => p.dataset.bg);
  lista.slice(0, 3).forEach(img);

  /* tarjetas: aparecen solo cuando la imagen está completa */
  document.querySelectorAll('.card img').forEach(im => {
    im.style.opacity = 0; im.style.transition = 'opacity .9s ease';
    (im.decode ? im.decode() : Promise.resolve()).then(() => { im.style.opacity = 1; }).catch(() => { im.style.opacity = 1; });
  });

  /* ---------- intro: se va cuando lo crítico está listo ---------- */
  const t0 = performance.now();
  const videoListo = new Promise(r => { if (vid.readyState >= 3) r(); else { vid.addEventListener('canplaythrough', r, {once: true}); vid.addEventListener('loadeddata', () => setTimeout(r, 400), {once: true}); } });
  const primera = (() => { const e = img(lista[0]); return e.im.decode ? e.im.decode().catch(() => {}) : Promise.resolve(); })();
  function quitar() { intro.classList.add('fuera'); setTimeout(() => intro.remove(), 1300); kick(); }
  Promise.all([videoListo, primera]).then(() => setTimeout(quitar, Math.max(0, 1200 - (performance.now() - t0))));
  setTimeout(() => { if (!intro.classList.contains('fuera')) quitar(); }, 2200);
  try { vid.pause(); } catch (_) {}
  // en un servidor que no deja saltar dentro del archivo, el video se carga entero en memoria para que avance con el scroll
  // en la web se descarga una sola vez y entero (así avanza fluido con el scroll); mientras tanto se ve la portada, nunca negro
  if (location.protocol.startsWith('http')) fetch(window.KSRC).then(r => r.blob()).then(b => {
    vid.src = URL.createObjectURL(b); vid.addEventListener('loadeddata', kick, {once: true});
  }).catch(() => { vid.src = window.KSRC; });

  /* ---------- dibujo ---------- */
  function size() { const r = Math.min(devicePixelRatio || 1, 1.5); cv.width = Math.round(innerWidth * r); cv.height = Math.round(innerHeight * r); kick(); }
  const ease = x => (x = Math.min(1, Math.max(0, x)), x * x * (3 - 2 * x));
  function paint(e, u, alpha, k, sec, c = ctx) {
    if (!e || !e.ok || alpha <= 0.002) return;
    const im = e.im, W = cv.width, H = cv.height, iw = im.naturalWidth, ih = im.naturalHeight, m = reduce ? 0.5 : u;
    const d = sec ? sec.dataset : {}, fx = +(d.fx || 0.5), fy = +(d.fy || 0.5);
    c.globalAlpha = alpha; c.imageSmoothingQuality = 'high';
    if (W / H > iw / ih * 1.15) {                                  // pantalla ancha: foto completa a toda la altura
      const b = e.blur, sb = Math.max(W / b.width, H / b.height) * 1.12;
      c.filter = 'brightness(0.42) saturate(1.1)';
      c.drawImage(b, (W - b.width * sb) / 2, (H - b.height * sb) / 2, b.width * sb, b.height * sb);
      c.filter = 'none';
      const s = H / ih * (1 + 0.035 * m), w = iw * s, h = ih * s;
      const x = d.pos === 'center' ? (W - w) / 2 : W - w - W * 0.05, y = (H - h) * fy;
      c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 80 * (W / 1600);
      c.drawImage(im, x, y, w, h);
      c.shadowBlur = 0;
    } else {                                                       // celular: llena la pantalla sin perder el producto
      const s = Math.max(W / iw, H / ih) * (1.02 + 0.06 * m), w = iw * s, h = ih * s;
      const x = Math.min(0, Math.max(W - w, W / 2 - fx * w)), y = Math.min(0, Math.max(H - h, H / 2 - fy * h));
      c.drawImage(im, x, y, w, h);
    }
    c.globalAlpha = 1;
  }

  /* ---------- transición en polvo (WebGL2): la imagen que sale se deshace en polvo fino que sube
     y se apaga, y la que entra se arma con polvo que llega desde abajo; todo atado al scroll.
     Sirve igual del video a la primera foto. Sin WebGL2 queda el fundido normal. ---------- */
  const BANDA = 0.42;
  const pv = document.getElementById('polvo');
  const gl = pv.getContext('webgl2', {alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false});
  const bufA = document.createElement('canvas'), bufB = document.createElement('canvas');
  let G = null;
  if (gl) {
    const comun = `#version 300 es
    precision highp float;
    uniform vec2 uRes; uniform float uP, uMix, uBand;
    float h(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
    float q(vec2 cell, float side){
      float ry = cell.y * uP / uRes.y, t = 0.5 * ry + 0.5 * h(cell + side * vec2(57.0, 113.0));
      return clamp((uMix - t * (1.0 - uBand)) / uBand, 0.0, 1.0);
    }
    `;
    const vsQuad = comun + `void main(){ vec2 v = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(v, 0.0, 1.0); }`;
    const fsQuad = comun + `uniform sampler2D tA, tB; out vec4 o;
    void main(){
      vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y), cell = floor(px / uP), uv = px / uRes;
      vec4 c = vec4(0.055, 0.059, 0.063, 1.0);
      if (q(cell, 1.0) >= 1.0) c = texture(tB, uv);
      if (q(cell, 0.0) <= 0.0) c = texture(tA, uv);
      o = c;
    }`;
    const vsPts = comun + `uniform sampler2D uTex; uniform float uSide, uSc; out vec3 vC; out float vA;
    void main(){
      int cols = int(ceil(uRes.x / uP));
      vec2 cell = vec2(float(gl_VertexID % cols), float(gl_VertexID / cols));
      float qq = q(cell, uSide);
      if (qq <= 0.0 || qq >= 1.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; vA = 0.0; vC = vec3(0.0); return; }
      vec2 home = (cell + 0.5) * uP;
      vC = texture(uTex, home / uRes).rgb;
      float e = uSide < 0.5 ? qq : 1.0 - qq, dir = uSide < 0.5 ? 1.0 : -1.0;
      float g = h(cell * 1.7 + 3.1) * 6.2832, v = 0.35 + h(cell * 2.3 + 7.7) * 1.1, e2 = e * e;
      vec2 off = vec2((cos(g) * 110.0 + 70.0 * v) * e2 * dir, -(240.0 + 300.0 * v) * e2 * dir);
      off += vec2(sin(e * 9.0 + g * 3.0), cos(e * 7.0 + g * 2.0)) * 34.0 * e;
      vec2 pos = home + off * uSc;
      gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
      gl_PointSize = max(0.5, uP * (1.5 - 1.35 * e));
      vA = pow(1.0 - e, 1.6);
    }`;
    const fsPts = `#version 300 es
    precision highp float; in vec3 vC; in float vA; out vec4 o;
    void main(){ float d = length(gl_PointCoord - 0.5); o = vec4(vC, vA * smoothstep(0.5, 0.15, d)); }`;
    const prog = (v, f) => {
      const p = gl.createProgram();
      [[gl.VERTEX_SHADER, v], [gl.FRAGMENT_SHADER, f]].forEach(([t, src]) => { const sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.warn('[KINETA]', gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); });
      gl.linkProgram(p); return p;
    };
    const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER].forEach(k => gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR)); [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(k => gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE)); return t; };
    G = {quad: prog(vsQuad, fsQuad), pts: prog(vsPts, fsPts), tA: tex(), tB: tex(), vao: gl.createVertexArray()};
  }
  function fotoEn(c, e, u, k, sec) { c.globalAlpha = 1; c.fillStyle = '#0e0f10'; c.fillRect(0, 0, c.canvas.width, c.canvas.height); paint(e, u, 1, k, sec, c); }
  function videoEn(c) {                                        // el cuadro actual del video, con el mismo encuadre que en pantalla
    const W = c.canvas.width, H = c.canvas.height, iw = vid.videoWidth, ih = vid.videoHeight;
    c.globalAlpha = 1; c.fillStyle = '#0e0f10'; c.fillRect(0, 0, W, H);
    if (!iw) return;
    const ancho = innerWidth >= innerHeight, s = Math.min(W / iw, H / ih);   // siempre completo: la marca de Kling se ve
    c.drawImage(vid, (W - iw * s) * (ancho ? 0.76 : 0.5), (H - ih * s) / 2, iw * s, ih * s);
  }
  function polvo(pintaA, pintaB, mix) {                        // false si no se puede: entonces se usa el fundido
    if (!G || reduce) return false;
    const W = cv.width, H = cv.height;
    [bufA, bufB].forEach(c => { if (c.width !== W || c.height !== H) { c.width = W; c.height = H; } });
    if (pv.width !== W || pv.height !== H) { pv.width = W; pv.height = H; }
    pintaA(bufA.getContext('2d')); pintaB(bufB.getContext('2d'));
    const P = Math.max(2, Math.round(2 * W / innerWidth));     // un grano cada 2 px de pantalla
    gl.viewport(0, 0, W, H); gl.bindVertexArray(G.vao);
    try { [[G.tA, bufA, 0], [G.tB, bufB, 1]].forEach(([t, c, n]) => { gl.activeTexture(gl.TEXTURE0 + n); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c); }); }
    catch (err) { console.warn('[KINETA] polvo apagado:', err.message); G = null; return false; }   // abierto como archivo: el navegador lo bloquea
    const set = (p, nombre, ...v) => gl['uniform' + v.length + 'f'](gl.getUniformLocation(p, nombre), ...v);
    gl.disable(gl.BLEND); gl.useProgram(G.quad);
    set(G.quad, 'uRes', W, H); set(G.quad, 'uP', P); set(G.quad, 'uMix', mix); set(G.quad, 'uBand', BANDA);
    gl.uniform1i(gl.getUniformLocation(G.quad, 'tA'), 0); gl.uniform1i(gl.getUniformLocation(G.quad, 'tB'), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.useProgram(G.pts);
    set(G.pts, 'uRes', W, H); set(G.pts, 'uP', P); set(G.pts, 'uMix', mix); set(G.pts, 'uBand', BANDA); set(G.pts, 'uSc', W / 1600);
    const n = Math.ceil(W / P) * Math.ceil(H / P);
    [[1, 1], [0, 0]].forEach(([side, unit]) => { set(G.pts, 'uSide', side); gl.uniform1i(gl.getUniformLocation(G.pts, 'uTex'), unit); gl.drawArrays(gl.POINTS, 0, n); });
    pv.style.visibility = 'visible';
    return true;
  }

  function frame() {
    smooth += reduce ? (scrollY - smooth) : (scrollY - smooth) * 0.14;
    if (Math.abs(scrollY - smooth) < 0.25) smooth = scrollY;
    const vh = innerHeight;
    // portada: el video avanza con el scroll
    const hTop = hero.offsetTop, hLen = hero.offsetHeight - vh;
    const hp = Math.min(1, Math.max(0, (smooth - hTop) / hLen));
    if (vid.duration) {
      const goal = hp * (vid.duration - 0.05);
      vt += (goal - vt) * 0.35;
      if (Math.abs(vid.currentTime - vt) > 0.02) { try { vid.currentTime = vt; } catch (_) {} }
    }
    hero.querySelectorAll('.st').forEach(s => s.classList.toggle('on', hp >= +s.dataset.de && hp < +s.dataset.a));
    // el video se funde cuando la primera sección entra
    const p0 = planos[0], fade = p0 ? ease((smooth - (p0.offsetTop - vh)) / vh) : 0;
    // el polvo empieza en los últimos cuadros del video (mientras aún se mueve) y termina con la foto ya armada
    const dIni = hTop + hLen * 0.78, dFin = p0 ? p0.offsetTop - vh * 0.35 : dIni + 1, dis = Math.min(1, Math.max(0, (smooth - dIni) / (dFin - dIni)));
    let enPolvo = false;
    if (dis > 0.002 && dis < 0.998 && img(lista[0]).ok)
      enPolvo = polvo(c => videoEn(c), c => fotoEn(c, img(lista[0]), 0, 0, p0), dis);
    vid.style.opacity = enPolvo || (G && !reduce && dis >= 0.998) ? 0 : 1 - fade;
    // fondos de las secciones
    let i = -1;
    for (let k = 0; k < planos.length; k++) if (planos[k].offsetTop <= smooth + 1) i = k;
    ctx.fillStyle = '#0e0f10'; ctx.fillRect(0, 0, cv.width, cv.height);
    const ia = Math.max(0, i), a = planos[ia], b = planos[ia + 1];
    const ea = img(lista[ia]), eb = b ? img(lista[ia + 1]) : null;
    const u = a ? ease((smooth - a.offsetTop) / Math.max(vh, a.offsetHeight)) : 0;
    let mix = b ? ease((smooth - (b.offsetTop - vh)) / vh) : 0;
    if (eb && !eb.ok) mix = 0;                                     // si la siguiente no está lista, se queda la actual
    if (!enPolvo && eb && mix > 0.002 && mix < 0.998)
      enPolvo = polvo(c => fotoEn(c, ea, i < 0 ? 0 : u, ia, a), c => fotoEn(c, eb, 0, ia + 1, b), mix);
    if (!enPolvo) { pv.style.visibility = 'hidden'; paint(ea, i < 0 ? 0 : u, 1, ia, a); if (eb) paint(eb, 0, G && !reduce ? (mix >= 0.998 ? 1 : 0) : mix, ia + 1, b); }
    for (let k = 1; k <= 3; k++) if (lista[ia + k]) img(lista[ia + k]);   // precarga anticipada
    reveal();
    if (Math.abs(scrollY - smooth) > 0.25) requestAnimationFrame(frame); else running = false;
  }
  function kick() { if (!running) { running = true; requestAnimationFrame(frame); } }

  /* ---------- textos y cifras ---------- */
  function reveal() {
    const vh = innerHeight;
    document.querySelectorAll('.rev').forEach(el => {
      const r = el.getBoundingClientRect(), dentro = r.top < vh * 0.9 && r.bottom > vh * 0.05;
      if (dentro !== el.classList.contains('on')) el.classList.toggle('on', dentro);
    });
    document.querySelectorAll('.cifra b').forEach(b => {             // la cifra sube mientras la sección entra
      const r = b.getBoundingClientRect(), p = Math.min(1, Math.max(0, (vh * 0.95 - r.top) / (vh * 0.45)));
      b.textContent = Math.round(+b.dataset.n * ease(reduce ? 1 : p));
    });
  }

  /* ---------- bolsa de demostración ---------- */
  const nb = document.getElementById('nb'), bolsa = document.querySelector('.bolsa');
  document.querySelectorAll('.add').forEach(btn => btn.addEventListener('click', () => {
    nb.textContent = +nb.textContent + 1; btn.textContent = 'Added ✓'; btn.classList.add('ok');
    bolsa.classList.add('pop'); setTimeout(() => bolsa.classList.remove('pop'), 400);
    setTimeout(() => { btn.textContent = 'Add to bag'; btn.classList.remove('ok'); }, 1600);
  }));

  addEventListener('scroll', kick, {passive: true});
  addEventListener('resize', size);
  size();
})();
