/* OSE backend selector: home server first, Render as fallback. */
(function () {
  if (window.oseFetch) return; // already loaded
  const BACKENDS = {
    home:   "https://api-findbestfit.ose.vn",
    render: "https://ose-findbestfit-backend.onrender.com",
    local:  "http://127.0.0.1:8007",
  };
  window.OSE_BACKENDS = BACKENDS;
  const CACHE_KEY = "ose_api_auto";
  const CACHE_MS = 5 * 60 * 1000;
  let auto = false;
  const set = (base) => (window.OSE_API_BASE = String(base).replace(/\/+$/, ""));

  function remember(name) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ name, t: Date.now() })); } catch (e) {}
  }
  function recalled() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (c && BACKENDS[c.name] && Date.now() - c.t < CACHE_MS) return c.name;
    } catch (e) {}
    return null;
  }
  async function alive(base, ms) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
    try { return (await fetch(base + "/api/health", { signal: c.signal, cache: "no-store" })).ok; }
    catch (e) { return false; } finally { clearTimeout(t); }
  }

  function resolve() {
    const params = new URLSearchParams(location.search);
    if (["localhost", "127.0.0.1"].includes(location.hostname)) {
      // Local test: ?api=https://... (any URL) or ?api=home|render, default = local Docker/uvicorn
      const q = params.get("api");
      if (q && /^https?:\/\//i.test(q)) return Promise.resolve(set(q));
      if (q && BACKENDS[q]) return Promise.resolve(set(BACKENDS[q]));
      return Promise.resolve(set(BACKENDS.local));
    }
    // ?api=home | render | local (pin)   ?api=auto (unpin)
    let forced = params.get("api");
    try {
      if (forced === "auto") { localStorage.removeItem("ose_api"); forced = null; }
      else if (forced && BACKENDS[forced]) localStorage.setItem("ose_api", forced);
      else if (forced) forced = null;
      else forced = localStorage.getItem("ose_api");
    } catch (e) {}
    if (forced && BACKENDS[forced]) return Promise.resolve(set(BACKENDS[forced]));

    auto = true;
    const cached = recalled();
    if (cached) return Promise.resolve(set(BACKENDS[cached]));
    set(BACKENDS.home);
    return (async () => {
      if (await alive(BACKENDS.home, 4000)) { remember("home"); return BACKENDS.home; }
      console.warn("[OSE] Home server not responding, switching to Render");
      remember("render");
      return set(BACKENDS.render);
    })();
  }

  window.OSE_API_READY = resolve();

  // Use instead of fetch(): oseFetch("/api/xxx", options). Home down mid-session -> resend to Render.
  window.oseFetch = async function (path, options) {
    const base = await window.OSE_API_READY;
    const canFailover = auto && base === BACKENDS.home;
    try {
      const res = await fetch(base + path, options);
      if (!canFailover || ![502, 503, 504].includes(res.status)) return res;
    } catch (e) {
      if (!canFailover) throw e;
    }
    console.warn("[OSE] Home server lost, switching to Render");
    remember("render");
    window.OSE_API_READY = Promise.resolve(set(BACKENDS.render));
    return fetch(BACKENDS.render + path, options);
  };

  // Backward compatibility with older app.js builds.
  window.FINDBESTFIT_API_BASE = BACKENDS.home;
  window.OSE_API_READY.then((base) => { window.FINDBESTFIT_API_BASE = base; });
})();
