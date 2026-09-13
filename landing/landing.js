// landing: nav hairline, scroll reveal, live demo replay (external for csp script-src 'self')
(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // nav hairline once scrolled past 8px
    const nav = document.getElementById('nav');
    new IntersectionObserver(([e]) => nav.classList.toggle('scrolled', !e.isIntersecting)).observe(document.getElementById('nav-sentinel'));

    if (reduce) return; // static final frames, no reveal hiding

    // reveal on scroll
    document.documentElement.classList.add('js-motion');
    const rio = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); }
    }), { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });
    document.querySelectorAll('[data-reveal]').forEach((el) => rio.observe(el));

    // ── live demo replay ──
    const demo = document.getElementById('demo');
    const $ = (s) => demo.querySelector(s);
    const prompt = $('#d-prompt'), fullPrompt = prompt.textContent;
    const items = demo.querySelectorAll('.d-item');
    const stages = demo.querySelectorAll('.stage');
    const hfNote = $('.hf-note'), hfNoteFinal = hfNote.innerHTML;
    const tools = [...demo.querySelectorAll('.tool')].map((el) => ({
      el, st: el.querySelector('.st'), ms: el.querySelector('.ms'), final: +el.querySelector('.ms').dataset.final, t0: 0, live: false,
    }));
    const fmt = (ms) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's');
    const show = (k) => $('[data-k="' + k + '"]').classList.add('on');
    const stage = (name) => stages.forEach((s, i) => {
      const idx = [...stages].findIndex((x) => x.dataset.stage === name);
      s.dataset.s = i < idx ? 'done' : i === idx ? 'active' : '';
    });
    const setTool = (t, st) => { t.el.dataset.st = st; t.st.dataset.st = st; t.st.textContent = st === 'err' ? '✕' : '✓'; };

    let timers = [], raf = 0, running = false, visible = false;
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    const tick = () => {
      const now = performance.now();
      tools.forEach((t) => { if (t.live) t.ms.textContent = fmt(now - t.t0); });
      raf = requestAnimationFrame(tick);
    };
    const start = (t) => { t.t0 = performance.now(); t.live = true; setTool(t, 'running'); };
    const finish = (t, st) => { t.live = false; if (st === 'ok') t.ms.textContent = fmt(t.final); setTool(t, st); };

    function reset() {
      timers.forEach(clearTimeout); timers = []; cancelAnimationFrame(raf);
      demo.classList.add('play');
      items.forEach((i) => i.classList.remove('on'));
      stages.forEach((s) => (s.dataset.s = ''));
      tools.forEach((t) => { t.live = false; setTool(t, 'pending'); t.ms.textContent = '—'; });
      hfNote.style.visibility = 'hidden';
      $('#d-verify-st').dataset.st = 'running';
      prompt.textContent = ''; prompt.classList.add('caret');
    }

    function run() {
      reset(); running = true; raf = requestAnimationFrame(tick);
      const n = fullPrompt.length, typeMs = 1500;
      for (let i = 1; i <= n; i++) at((typeMs * i) / n, () => (prompt.textContent = fullPrompt.slice(0, i)));
      at(typeMs + 150, () => prompt.classList.remove('caret'));
      at(1900, () => { show('think'); stage('plan'); });
      at(2600, () => show('plan'));
      at(3500, () => { stage('act'); show('tools'); start(tools[0]); });
      at(3620, () => start(tools[1]));
      at(3740, () => start(tools[2]));
      at(3912, () => finish(tools[0], 'ok'));
      at(4900, () => { finish(tools[2], 'err'); tools[2].ms.textContent = 'timeout'; hfNote.innerHTML = '<span class="mono">error_kind: timeout</span> · retrying 1/2'; hfNote.style.visibility = 'visible'; });
      at(4904, () => finish(tools[1], 'ok'));
      at(5500, () => { start(tools[2]); tools[2].t0 -= 1160; });
      at(7400, () => { finish(tools[2], 'ok'); hfNote.innerHTML = hfNoteFinal; });
      at(7800, () => { stage('verify'); show('verify'); });
      at(8500, () => ($('#d-verify-st').dataset.st = 'ok'));
      at(9000, () => stage('attest'));
      at(9400, () => { show('answer'); stages.forEach((s) => (s.dataset.s = 'done')); });
      at(14500, () => { cancelAnimationFrame(raf); $('.d-body').style.opacity = '0'; });
      at(14850, () => { $('.d-body').style.opacity = ''; running = false; if (visible && !document.hidden) run(); });
    }
    function stop() {
      timers.forEach(clearTimeout); timers = []; cancelAnimationFrame(raf); running = false;
      // settle on the final frame while paused
      demo.classList.remove('play'); $('.d-body').style.opacity = '';
      stages.forEach((s) => (s.dataset.s = 'done'));
      tools.forEach((t) => finish(t, 'ok'));
      hfNote.innerHTML = hfNoteFinal; hfNote.style.visibility = 'visible';
      $('#d-verify-st').dataset.st = 'ok';
      prompt.textContent = fullPrompt; prompt.classList.remove('caret');
    }
    const sync = () => { if (visible && !document.hidden) { if (!running) run(); } else if (running) stop(); };
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }, { threshold: 0.35 }).observe(demo);
    document.addEventListener('visibilitychange', sync);
  })();
