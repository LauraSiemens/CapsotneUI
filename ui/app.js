/**
 * ESP32 CSV: USB (Web Serial) or WebSocket — PM2.5, Temp, Humidity, Gas, Pressure
 * (Firmware may send 8 columns incl. BatteryPct; UI ignores extra fields.)
 * Web Serial: Chrome / Edge. WebSocket: any modern browser to your ESP / bridge.
 */
(function () {
  "use strict";

  const BAUD = 115200;
  /** Firmware sends ~1 Hz; mark stale if no parsed row for this long */
  const DATA_STALE_MS = 6500;
  /** Connected but no valid CSV row yet */
  const DATA_WAIT_MS = 5000;
  const WS_BACKOFF_START_MS = 1000;
  const WS_BACKOFF_MAX_MS = 30000;
  const HISTORY_MAX = 400;
  const CHART_WINDOW = 80;
  const DISPLAY_DP = 2;
  /** PM2.5 needle scale (µg/m³) — matches AQI-style bands up to hazardous */
  const PM25_GAUGE_MAX = 450;
  /** Thermometer tube scale (°C) — fill maps linearly from min to max */
  const TEMP_THERMO_MIN = -10;
  const TEMP_THERMO_MAX = 40;

  /** csvIndex = column in firmware CSV (0-based): PM1,PM2.5,PM10,Temp,Hum,Gas,Press[,Batt] */
  const METRICS = [
    { id: "pm25", label: "PM2.5", unit: "µg/m³", gaugeMax: 150, csvIndex: 1 },
    { id: "temp", label: "Temp", unit: "°C", gaugeMax: 45, csvIndex: 3 },
    { id: "humidity", label: "Humidity", unit: "%", gaugeMax: 100, csvIndex: 4 },
    { id: "gas", label: "Gas (hum-adj)", unit: "%", gaugeMax: 100, csvIndex: 5 },
    { id: "pressure", label: "Pressure", unit: "hPa", gaugeMax: 1100, csvIndex: 6 },
  ];

  const CSV_HUMIDITY = METRICS.findIndex((m) => m.id === "humidity");
  const CSV_PRESSURE = METRICS.findIndex((m) => m.id === "pressure");
  /** Map hPa to bubble fill height (0–100%) */
  const PRESS_BUBBLE_MIN_HPA = 980;
  const PRESS_BUBBLE_MAX_HPA = 1050;

  let port = null;
  let reader = null;
  let ws = null;
  let readLoopAbort = false;
  let lineBuffer = "";
  let t0 = null;
  /** Monotonic: last time a CSV data row was parsed and applied */
  let lastTelemetryAt = null;
  let sessionStartedAt = null;
  let staleMonitorId = null;
  let wsReconnectTimer = null;
  let wsReconnectAttempt = 0;
  /** Incremented so old WebSocket onclose handlers do not run reconnect logic */
  let wsGen = 0;
  /** User clicked Disconnect — do not auto-reconnect WebSocket */
  let intentionalDisconnect = false;
  const history = METRICS.map(() => []);

  const els = {
    connect: document.getElementById("btn-connect"),
    disconnect: document.getElementById("btn-disconnect"),
    connUsb: document.getElementById("conn-usb"),
    connWifi: document.getElementById("conn-wifi"),
    wsUrl: document.getElementById("ws-url"),
    status: document.getElementById("status"),
    gridTop: document.getElementById("grid-top"),
    gridBottom: document.getElementById("grid-bottom"),
    humidityPanel: document.getElementById("humidity-panel"),
    humidPanelValue: document.getElementById("humid-panel-value"),
    humidPanelStatus: document.getElementById("humid-panel-status"),
    modal: document.getElementById("modal"),
    modalTitle: document.getElementById("modal-title"),
    modalCurrent: document.getElementById("modal-current"),
    modalClose: document.getElementById("modal-close"),
    chartCanvas: document.getElementById("chart-canvas"),
  };

  let chart = null;
  let selectedMetricIndex = 0;

  function isWifiMode() {
    return els.connWifi && els.connWifi.checked;
  }

  function setConnectionStatus(text, mode) {
    els.status.textContent = text;
    els.status.classList.remove("live", "warn");
    if (mode === "live") els.status.classList.add("live");
    else if (mode === "warn") els.status.classList.add("warn");
  }

  function lockConnModeUi(locked) {
    if (els.connUsb) els.connUsb.disabled = locked;
    if (els.connWifi) els.connWifi.disabled = locked;
    if (els.wsUrl) els.wsUrl.disabled = locked || !isWifiMode();
  }

  function syncConnModeUi() {
    const wifi = isWifiMode();
    document.body.classList.toggle("conn-wifi-selected", wifi);
    if (els.wsUrl) els.wsUrl.disabled = !wifi;
  }

  function beginDataSession() {
    sessionStartedAt = performance.now();
    lastTelemetryAt = null;
    startStaleMonitor();
  }

  function endDataSession() {
    stopStaleMonitor();
    sessionStartedAt = null;
    lastTelemetryAt = null;
  }

  function stopStaleMonitor() {
    if (staleMonitorId !== null) {
      clearInterval(staleMonitorId);
      staleMonitorId = null;
    }
  }

  function startStaleMonitor() {
    stopStaleMonitor();
    staleMonitorId = setInterval(staleTick, 1000);
  }

  function hasActiveUsbStream() {
    return !!(port && port.readable && !readLoopAbort);
  }

  function hasOpenWebSocket() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  function staleTick() {
    if (intentionalDisconnect) return;
    if (!hasActiveUsbStream() && !hasOpenWebSocket()) return;
    const now = performance.now();
    if (sessionStartedAt === null) return;

    if (lastTelemetryAt === null) {
      if (now - sessionStartedAt >= DATA_WAIT_MS) {
        setConnectionStatus(
          "No data yet — wrong port/URL, baud, or all sensor values nan",
          "warn"
        );
      }
      return;
    }

    if (now - lastTelemetryAt >= DATA_STALE_MS) {
      setConnectionStatus(
        "No data (stale) — reset ESP32, fix Wi‑Fi, or Disconnect then Connect",
        "warn"
      );
      return;
    }

    setConnectionStatus(isWifiMode() ? "Live (WebSocket)" : "Live (USB)", "live");
  }

  function clearWsReconnectTimer() {
    if (wsReconnectTimer !== null) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  }

  function normalizeWsUrl(raw) {
    let url = (raw || "").trim() || "ws://192.168.4.1:81";
    if (!/^wss?:\/\//i.test(url)) {
      url = "ws://" + url.replace(/^\/\//, "");
    }
    return url;
  }

  /** User PM2.5 bands (µg/m³) */
  function getPm25Status(pm) {
    if (!Number.isFinite(pm)) return { color: "var(--muted)", symbol: "—" };
    if (pm >= 250.4) return { color: "#f87171", symbol: "Hazardous" };
    if (pm >= 150.4) return { color: "#f87171", symbol: "Very Unhealthy" };
    if (pm >= 55.5) return { color: "#fb923c", symbol: "Unhealthy" };
    if (pm >= 35.4) return { color: "#bbf7d0", symbol: "Unhealthy if running" };
    if (pm > 12) return { color: "#86efac", symbol: "Moderate" };
    return { color: "#4ade80", symbol: "Good" };
  }

  /** Relative humidity: ideal 40–60%; low &lt;40%; high &gt;60% */
  function getHumidityStatus(h) {
    if (!Number.isFinite(h)) return { color: "var(--muted)", symbol: "—" };
    if (h > 60) return { color: "#f87171", symbol: "High" };
    if (h >= 40) return { color: "#4ade80", symbol: "Ideal" };
    return { color: "#60a5fa", symbol: "Low" };
  }

  function needleAngle(value, gaugeMax) {
    if (!Number.isFinite(value)) return -90;
    const clamped = Math.min(gaugeMax, Math.max(0, value));
    const t = clamped / gaugeMax;
    return -90 + t * 90;
  }

  function tempToTubeFillPercent(c) {
    if (!Number.isFinite(c)) return 0;
    const t =
      (c - TEMP_THERMO_MIN) / (TEMP_THERMO_MAX - TEMP_THERMO_MIN);
    return Math.min(100, Math.max(0, t * 100));
  }

  /** Thermometer liquid: blue family only (value text also uses accent blue). */
  function tempLiquidGradientCss(c) {
    if (!Number.isFinite(c))
      return "linear-gradient(180deg, var(--surface2) 0%, var(--border) 100%)";
    if (c < 12)
      return "linear-gradient(180deg, #8fd4ff 0%, #2e7fc4 100%)";
    if (c < 22)
      return "linear-gradient(180deg, #9ddbff 0%, var(--accent) 100%)";
    if (c < 32)
      return "linear-gradient(180deg, #b8e4ff 0%, #4aa8e8 100%)";
    return "linear-gradient(180deg, #d2eeff 0%, #3d9cf0 100%)";
  }

  const TEMP_VALUE_COLOR = "var(--accent)";

  function cardLegendHtml(m) {
    if (m.id === "temp") {
      return `<div class="card-legend card-legend--temp" aria-hidden="true">
        <span class="card-legend-item"><i class="lg-dot" style="background:#2e7fc4"></i> −10°</span>
        <span class="card-legend-item"><i class="lg-dot" style="background:#4aa8e8"></i> 10°</span>
        <span class="card-legend-item"><i class="lg-dot" style="background:#5eb8ff"></i> 20°</span>
        <span class="card-legend-item"><i class="lg-dot" style="background:#8fd4ff"></i> 40°</span>
      </div>`;
    }
    if (m.id === "pm25") {
      return `<div class="card-legend" aria-hidden="true">
        <span class="card-legend-item"><i class="lg-dot lg-good"></i> Good</span>
        <span class="card-legend-item"><i class="lg-dot lg-warn"></i> Moderate</span>
        <span class="card-legend-item"><i class="lg-dot lg-orange"></i> Unhealthy</span>
        <span class="card-legend-item"><i class="lg-dot lg-bad"></i> Hazardous</span>
      </div>`;
    }
    if (m.id === "humidity") {
      return `<div class="card-legend card-legend--humid" aria-hidden="true">
        <span class="card-legend-item"><i class="lg-dot" style="background:#f59e0b"></i> Low &lt;40%</span>
        <span class="card-legend-item"><i class="lg-dot lg-good"></i> Ideal 40–60%</span>
        <span class="card-legend-item"><i class="lg-dot" style="background:#f87171"></i> High &gt;60%</span>
      </div>`;
    }
    return `<div class="card-legend" aria-hidden="true">
      <span class="card-legend-item"><i class="lg-dot lg-good"></i> Low</span>
      <span class="card-legend-item"><i class="lg-dot lg-warn"></i> OK</span>
      <span class="card-legend-item"><i class="lg-dot lg-orange"></i> Elevated</span>
      <span class="card-legend-item"><i class="lg-dot lg-bad"></i> High</span>
    </div>`;
  }

  /** Short radial ticks along the semicircle (needle gauges). */
  function arcGaugeTickMarkup() {
    const ri = 73;
    const ro = 81;
    const lines = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const ang = Math.PI * (1 - t);
      const ci = Math.cos(ang);
      const si = Math.sin(ang);
      const x1 = 100 + ri * ci;
      const y1 = 100 - ri * si;
      const x2 = 100 + ro * ci;
      const y2 = 100 - ro * si;
      lines.push(
        `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`
      );
    }
    return lines.join("");
  }

  /**
   * One smooth semicircle: dark underlay + single gradient stroke (no stacked segment caps).
   * Pivot for needle is always (100,100) in viewBox — see rotate(angle 100 100) in updateCard.
   */
  function arcGaugeSvgInner(gradientId) {
    return `
    <defs>
      <linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="20" y1="100" x2="180" y2="100">
        <stop offset="0%" stop-color="var(--good)"/>
        <stop offset="33%" stop-color="var(--warn)"/>
        <stop offset="66%" stop-color="#f5a623"/>
        <stop offset="100%" stop-color="var(--bad)"/>
      </linearGradient>
    </defs>
    <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#121820" stroke-width="12" stroke-linecap="round" opacity="0.96"/>
    <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#${gradientId})" stroke-width="10" stroke-linecap="round"/>
    <g class="gauge-tick-marks" stroke="#6a7a8c" stroke-width="1.1" stroke-linecap="round" opacity="0.92">${arcGaugeTickMarkup()}</g>
    <g class="needle" transform="rotate(-90 100 100)">
      <polygon points="100,24 96,100 104,100" fill="#e8ecf1" stroke="#0d1117" stroke-width="1.1" stroke-linejoin="round"/>
      <circle cx="100" cy="100" r="5.5" fill="#f2f6fa" stroke="#0d1117" stroke-width="1.25"/>
    </g>`;
  }

  function formatVal(m, v) {
    if (!Number.isFinite(v)) return "—";
    return v.toFixed(DISPLAY_DP);
  }

  function buildCards() {
    if (els.gridTop) els.gridTop.innerHTML = "";
    if (els.gridBottom) {
      els.gridBottom.querySelectorAll("article.card[data-csv-index]").forEach((el) => {
        if (el.id !== "humidity-panel" && el.id !== "pressure-panel") el.remove();
      });
    }
    METRICS.forEach((m, i) => {
      if (m.id === "humidity" || m.id === "pressure") return;
      const card = document.createElement("article");
      card.className = "card";
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.dataset.csvIndex = String(i);
      const statusRow =
        m.id === "pm25"
          ? `<p class="air-status" id="status-${m.id}" aria-live="polite"></p>`
          : "";
      const gaugeBlock =
        m.id === "temp"
          ? `
        <div class="gauge-wrap gauge-wrap--temp gauge-wrap--uniform" aria-hidden="true">
          <div class="temp-thermo">
            <div class="temp-thermo-graphic">
              <div class="temp-tube-track">
                <div class="temp-tube-fill"></div>
              </div>
              <div class="temp-bulb"></div>
            </div>
            <div class="temp-thermo-scale">
              <span>40°</span>
              <span>30°</span>
              <span>20°</span>
              <span>10°</span>
              <span>0°</span>
              <span>-10°</span>
            </div>
          </div>
        </div>
        `
          : `
        <div class="gauge-wrap gauge-wrap--arc gauge-wrap--uniform" aria-hidden="true">
          <svg width="200" height="120" viewBox="0 0 200 120" class="gauge-svg" preserveAspectRatio="xMidYMid meet">
            ${arcGaugeSvgInner("ggrad-" + m.id)}
          </svg>
        </div>
        `;
      card.innerHTML = `
        ${gaugeBlock}
        ${cardLegendHtml(m)}
        <div class="value-block">
          <span class="num" id="val-${m.id}">—</span><span class="unit">${m.unit}</span>
        </div>
        ${statusRow}
        <div class="label">${m.label}</div>
        <div class="card-footer"><span>Graph</span> Click for history</div>
      `;
      card.addEventListener("click", () => openModal(i));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openModal(i);
        }
      });
      if (m.id === "pm25" || m.id === "temp") {
        card.classList.add("card--top");
        if (els.gridTop) els.gridTop.appendChild(card);
      } else {
        card.classList.add("card--bottom");
        if (els.gridBottom) els.gridBottom.appendChild(card);
      }
    });
    if (els.gridBottom && !document.getElementById("pressure-panel")) {
      els.gridBottom.appendChild(buildPressurePanelArticle());
    }
  }

  function buildPressurePanelArticle() {
    const art = document.createElement("article");
    art.id = "pressure-panel";
    art.className = "pressure-panel card card--bottom";
    art.setAttribute("role", "button");
    art.setAttribute("tabindex", "0");
    art.dataset.csvIndex = String(CSV_PRESSURE);
    art.title = "Click for pressure history graph";
    art.innerHTML = `
          <h3 class="pressure-panel-title">Pressure</h3>
          <div class="pressure-panel-body pressure-panel-body--water">
            <div class="press-water-widget">
              <svg
                class="press-water-svg"
                viewBox="0 0 200 200"
                width="200"
                height="200"
                aria-hidden="true"
              >
                <defs>
                  <clipPath id="pressCircleClip">
                    <circle cx="100" cy="100" r="88" />
                  </clipPath>
                </defs>
                <circle
                  cx="100"
                  cy="100"
                  r="90"
                  fill="none"
                  stroke="var(--border)"
                  stroke-width="2"
                />
                <g clip-path="url(#pressCircleClip)">
                  <rect width="200" height="200" fill="#0f1318" />
                  <rect
                    id="press-liquid-fill"
                    x="0"
                    y="200"
                    width="200"
                    height="0"
                    fill="#2a3340"
                  />
                  <g id="press-wave-layer" class="press-wave-layer" transform="translate(0,200)">
                    <g class="press-wave-scroll">
                      <path
                        id="press-wave-path-a"
                        d="M-400,0 Q-350,-10 -300,0 T-200,0 T-100,0 T0,0 T100,0 T200,0 T300,0 T400,0 T500,0 V30 H-400 Z"
                        fill="#2a3340"
                      />
                    </g>
                    <g class="press-wave-scroll press-wave-scroll--b">
                      <path
                        id="press-wave-path-b"
                        d="M-400,4 Q-350,-4 -300,4 T-200,4 T-100,4 T0,4 T100,4 T200,4 T300,4 T400,4 T500,4 V34 H-400 Z"
                        fill="#2a3340"
                        opacity="0.45"
                      />
                    </g>
                  </g>
                </g>
              </svg>
              <div class="press-water-overlay">
                <span id="press-panel-value" class="press-water-num">—</span
                ><span class="press-water-unit">hPa</span>
              </div>
            </div>
          </div>
          <p id="press-panel-status" class="air-status" aria-live="polite"></p>
          <div class="card-footer">
            <span>Graph</span> Click for history
          </div>`;
    return art;
  }

  /** Liquid + wave colors for circular humidity tank (Low / Ideal / High). */
  function humidLiquidFillColor(value) {
    if (!Number.isFinite(value)) return "#2a3340";
    const st = getHumidityStatus(value);
    if (st.symbol === "High") return "#f87171";
    if (st.symbol === "Ideal") return "#3dd68c";
    return "#f59e0b";
  }

  function updateHumidityPanel(value) {
    const m = METRICS[CSV_HUMIDITY];
    if (els.humidPanelValue)
      els.humidPanelValue.textContent = formatVal(m, value);

    const liquid = document.getElementById("humid-liquid-fill");
    const waveLayer = document.getElementById("humid-wave-layer");
    const waveA = document.getElementById("humid-wave-path-a");
    const waveB = document.getElementById("humid-wave-path-b");

    if (liquid && Number.isFinite(value)) {
      const pct = Math.min(100, Math.max(0, value));
      const h = (pct / 100) * 200;
      const yTop = 200 - h;
      const fill = humidLiquidFillColor(value);
      liquid.setAttribute("y", String(yTop));
      liquid.setAttribute("height", String(h));
      liquid.setAttribute("fill", fill);
      if (waveA) waveA.setAttribute("fill", fill);
      if (waveB) waveB.setAttribute("fill", fill);
      if (waveLayer) {
        waveLayer.setAttribute("transform", `translate(0, ${yTop})`);
        waveLayer.style.opacity = h > 0.5 ? "1" : "0";
      }
    } else {
      if (liquid) {
        liquid.setAttribute("y", "200");
        liquid.setAttribute("height", "0");
        liquid.setAttribute("fill", "#2a3340");
      }
      if (waveA) waveA.setAttribute("fill", "#2a3340");
      if (waveB) waveB.setAttribute("fill", "#2a3340");
      if (waveLayer) {
        waveLayer.setAttribute("transform", "translate(0,200)");
        waveLayer.style.opacity = "0";
      }
    }

    if (els.humidPanelValue && Number.isFinite(value)) {
      const st = getHumidityStatus(value);
      els.humidPanelValue.style.color = "#f8fafc";
      if (els.humidPanelStatus) {
        els.humidPanelStatus.textContent = st.symbol;
        els.humidPanelStatus.style.color = st.color;
      }
    } else {
      if (els.humidPanelValue)
        els.humidPanelValue.style.color = "var(--muted)";
      if (els.humidPanelStatus) {
        els.humidPanelStatus.textContent = "—";
        els.humidPanelStatus.style.color = "var(--muted)";
      }
    }
  }

  /** Sea-level–style bands for legend + bubble tint */
  function getPressureStatus(hPa) {
    if (!Number.isFinite(hPa)) return { color: "var(--muted)", symbol: "—" };
    if (hPa < 1000) return { color: "#60a5fa", symbol: "Low" };
    if (hPa <= 1025) return { color: "#4ade80", symbol: "Normal" };
    return { color: "#fb923c", symbol: "High" };
  }

  function pressureLiquidFillColor(hPa) {
    if (!Number.isFinite(hPa)) return "#2a3340";
    const st = getPressureStatus(hPa);
    if (st.symbol === "High") return "#c4883a";
    if (st.symbol === "Normal") return "#3d9cf0";
    return "#4a7ab8";
  }

  /** 0–100% fill from hPa for the circular tank */
  function pressureToFillPercent(hPa) {
    if (!Number.isFinite(hPa)) return 0;
    const t =
      (hPa - PRESS_BUBBLE_MIN_HPA) / (PRESS_BUBBLE_MAX_HPA - PRESS_BUBBLE_MIN_HPA);
    return Math.min(100, Math.max(0, t * 100));
  }

  function updatePressurePanel(value) {
    const m = METRICS[CSV_PRESSURE];
    const valEl = document.getElementById("press-panel-value");
    const statusEl = document.getElementById("press-panel-status");
    if (valEl) valEl.textContent = formatVal(m, value);

    const liquid = document.getElementById("press-liquid-fill");
    const waveLayer = document.getElementById("press-wave-layer");
    const waveA = document.getElementById("press-wave-path-a");
    const waveB = document.getElementById("press-wave-path-b");

    if (liquid && Number.isFinite(value)) {
      const pct = pressureToFillPercent(value);
      const h = (pct / 100) * 200;
      const yTop = 200 - h;
      const fill = pressureLiquidFillColor(value);
      liquid.setAttribute("y", String(yTop));
      liquid.setAttribute("height", String(h));
      liquid.setAttribute("fill", fill);
      if (waveA) waveA.setAttribute("fill", fill);
      if (waveB) waveB.setAttribute("fill", fill);
      if (waveLayer) {
        waveLayer.setAttribute("transform", `translate(0, ${yTop})`);
        waveLayer.style.opacity = h > 0.5 ? "1" : "0";
      }
    } else {
      if (liquid) {
        liquid.setAttribute("y", "200");
        liquid.setAttribute("height", "0");
        liquid.setAttribute("fill", "#2a3340");
      }
      if (waveA) waveA.setAttribute("fill", "#2a3340");
      if (waveB) waveB.setAttribute("fill", "#2a3340");
      if (waveLayer) {
        waveLayer.setAttribute("transform", "translate(0,200)");
        waveLayer.style.opacity = "0";
      }
    }

    if (valEl && Number.isFinite(value)) {
      const st = getPressureStatus(value);
      valEl.style.color = "#f8fafc";
      if (statusEl) {
        statusEl.textContent = st.symbol;
        statusEl.style.color = st.color;
      }
    } else {
      if (valEl) valEl.style.color = "var(--muted)";
      if (statusEl) {
        statusEl.textContent = "—";
        statusEl.style.color = "var(--muted)";
      }
    }
  }

  function setAirStatus(id, text, color) {
    const el = document.getElementById("status-" + id);
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
  }

  function updateCard(i, value) {
    if (i === CSV_HUMIDITY) {
      updateHumidityPanel(value);
      return;
    }
    if (i === CSV_PRESSURE) {
      updatePressurePanel(value);
      return;
    }
    const m = METRICS[i];
    const numEl = document.getElementById("val-" + m.id);
    const card = document.querySelector(`[data-csv-index="${i}"]`);
    if (!numEl || !card) return;
    numEl.textContent = formatVal(m, value);

    if (m.id === "temp") {
      const tubeFill = card.querySelector(".temp-tube-fill");
      const bulb = card.querySelector(".temp-bulb");
      const g = tempLiquidGradientCss(
        Number.isFinite(value) ? value : NaN
      );
      if (tubeFill) {
        if (Number.isFinite(value)) {
          tubeFill.style.height = tempToTubeFillPercent(value) + "%";
          tubeFill.style.background = g;
        } else {
          tubeFill.style.height = "0%";
          tubeFill.style.background =
            "linear-gradient(180deg, var(--surface2) 0%, var(--border) 100%)";
        }
      }
      if (bulb) {
        bulb.style.background = g;
      }
    } else {
      const needle = card.querySelector(".needle");
      if (needle) {
        let vForNeedle = value;
        let maxNeedle = m.gaugeMax;
        if (m.id === "pm25" && Number.isFinite(value)) {
          maxNeedle = PM25_GAUGE_MAX;
          vForNeedle = Math.min(Math.max(0, value), PM25_GAUGE_MAX);
        }
        const ang = needleAngle(
          Number.isFinite(vForNeedle) ? vForNeedle : NaN,
          maxNeedle
        );
        needle.setAttribute("transform", `rotate(${ang} 100 100)`);
      }
    }

    let color = "var(--muted)";
    if (Number.isFinite(value)) {
      if (m.id === "pm25") {
        const st = getPm25Status(value);
        color = st.color;
        setAirStatus("pm25", st.symbol, st.color);
      } else if (m.id === "temp") color = TEMP_VALUE_COLOR;
      else color = "var(--accent)";
    } else {
      if (m.id === "pm25") setAirStatus("pm25", "—", "var(--muted)");
    }
    numEl.style.color = color;
  }

  function pushHistory(i, tSec, value) {
    if (!Number.isFinite(value)) return;
    const arr = history[i];
    arr.push({ x: tSec, y: value });
    while (arr.length > HISTORY_MAX) arr.shift();
  }

  /** Allow `nan`; update fields that are finite */
  function parseLine(line) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 7) return null;
    // Ignore CSV header: column 2 is the label "PM2.5" (parseFloat would read "2").
    if (/pm/i.test(parts[1])) return null;
    const padded = parts.slice();
    while (padded.length < 8) padded.push("nan");
    const lower = padded.map((p) => p.toLowerCase());
    const nums = padded.slice(0, 8).map((p, j) => {
      if (lower[j] === "nan" || lower[j] === "inf" || lower[j] === "-inf")
        return NaN;
      const x = parseFloat(p);
      return Number.isNaN(x) ? NaN : x;
    });
    if (!nums.some((n) => Number.isFinite(n))) return null;
    return nums;
  }

  function ingestTelemetryLine(trimmed) {
    const nums = parseLine(trimmed);
    if (!nums) return;
    lastTelemetryAt = performance.now();
    if (t0 === null) t0 = performance.now() / 1000;
    const tSec = performance.now() / 1000 - t0;
    METRICS.forEach((m, metricIndex) => {
      const v = nums[m.csvIndex];
      updateCard(metricIndex, v);
      pushHistory(metricIndex, tSec, v);
    });
  }

  async function readLoop() {
    const dec = new TextDecoderStream();
    port.readable.pipeTo(dec.writable).catch(() => {});
    reader = dec.readable.getReader();
    lineBuffer = "";
    try {
      while (!readLoopAbort && port && port.readable) {
        const { value, done } = await reader.read();
        if (done) break;
        lineBuffer += value;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          ingestTelemetryLine(trimmed);
        }
      }
    } catch (e) {
      console.warn(e);
    } finally {
      reader = null;
      if (!readLoopAbort && port) {
        setConnectionStatus("USB disconnected — Connect again", "warn");
        endDataSession();
        try {
          await port.close();
        } catch (_) {}
        port = null;
        lockConnModeUi(false);
        els.connect.disabled = false;
        els.disconnect.disabled = true;
      }
    }
  }

  function scheduleWsReconnect() {
    clearWsReconnectTimer();
    if (intentionalDisconnect) return;
    const delay = Math.min(
      WS_BACKOFF_MAX_MS,
      WS_BACKOFF_START_MS * Math.pow(2, wsReconnectAttempt)
    );
    wsReconnectAttempt += 1;
    const sec = Math.max(1, Math.round(delay / 1000));
    setConnectionStatus(`Reconnecting in ${sec}s…`, "warn");
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      if (intentionalDisconnect) return;
      openWebSocketConnection();
    }, delay);
  }

  function openWebSocketConnection() {
    if (intentionalDisconnect) return;
    const myGen = ++wsGen;
    const url = normalizeWsUrl(els.wsUrl && els.wsUrl.value);
    setConnectionStatus("Connecting…", "warn");
    let sock;
    try {
      sock = new WebSocket(url);
      ws = sock;
    } catch (e) {
      console.warn(e);
      scheduleWsReconnect();
      return;
    }

    sock.onopen = () => {
      if (intentionalDisconnect || myGen !== wsGen) {
        try {
          sock.close();
        } catch (_) {}
        return;
      }
      wsReconnectAttempt = 0;
      clearWsReconnectTimer();
      beginDataSession();
      setConnectionStatus("Live (WebSocket)", "live");
      els.connect.disabled = true;
      els.disconnect.disabled = false;
      lockConnModeUi(true);
    };

    sock.onmessage = (ev) => {
      if (intentionalDisconnect || myGen !== wsGen) return;
      const raw = typeof ev.data === "string" ? ev.data : "";
      for (const piece of raw.split(/\r?\n/)) {
        const trimmed = piece.trim();
        if (trimmed) ingestTelemetryLine(trimmed);
      }
    };

    sock.onerror = () => {
      console.warn("WebSocket error");
    };

    sock.onclose = () => {
      if (myGen !== wsGen) return;
      ws = null;
      endDataSession();
      if (intentionalDisconnect) {
        setConnectionStatus("Disconnected", "");
        els.connect.disabled = false;
        els.disconnect.disabled = true;
        lockConnModeUi(false);
        return;
      }
      els.disconnect.disabled = false;
      scheduleWsReconnect();
    };
  }

  function connectWebSocketClient() {
    intentionalDisconnect = false;
    wsReconnectAttempt = 0;
    clearWsReconnectTimer();
    els.disconnect.disabled = false;
    if (ws) {
      wsGen += 1;
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
    openWebSocketConnection();
  }

  async function connect() {
    if (isWifiMode()) {
      connectWebSocketClient();
      return;
    }
    if (!("serial" in navigator)) {
      alert(
        "Web Serial needs Chrome or Edge. Serve this page over http://localhost (not file://)."
      );
      return;
    }
    intentionalDisconnect = false;
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD });
      readLoopAbort = false;
      t0 = null;
      beginDataSession();
      setConnectionStatus("Live (USB)", "live");
      els.connect.disabled = true;
      els.disconnect.disabled = false;
      lockConnModeUi(true);
      readLoop();
    } catch (e) {
      if (e.name !== "NotFoundError") console.warn(e);
    }
  }

  async function disconnect() {
    intentionalDisconnect = true;
    clearWsReconnectTimer();
    readLoopAbort = true;
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
    try {
      if (reader) await reader.cancel();
    } catch (_) {}
    reader = null;
    try {
      if (port) await port.close();
    } catch (_) {}
    port = null;
    endDataSession();
    setConnectionStatus("Disconnected", "");
    els.connect.disabled = false;
    els.disconnect.disabled = true;
    lockConnModeUi(false);
  }

  function chartTickFmt(v) {
    return Number(v).toFixed(DISPLAY_DP);
  }

  /**
   * Tight Y-axis from plotted points so small moves (e.g. °C) are visible.
   * Temperature uses a minimum span so 25.4 → 24.9 fills the chart.
   */
  function computeYAxisBounds(data, metricId) {
    const ys = data.filter((v) => Number.isFinite(v));
    if (ys.length === 0) return null;

    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    let span = maxY - minY;

    if (metricId === "temp") {
      const minSpan = 0.75;
      if (span < minSpan) {
        const mid = (minY + maxY) / 2;
        minY = mid - minSpan / 2;
        maxY = mid + minSpan / 2;
        span = minSpan;
      }
      const pad = Math.max(span * 0.06, 0.05);
      return { min: minY - pad, max: maxY + pad };
    }

    if (span === 0) {
      const mag = Math.max(Math.abs(minY), 1e-9);
      const pad = Math.max(mag * 0.02, 1e-6);
      return { min: minY - pad, max: maxY + pad };
    }

    const pad = span * 0.1;
    return { min: minY - pad, max: maxY + pad };
  }

  function buildChartOptions(yBounds) {
    const yScale = {
      grid: { color: "rgba(42, 51, 64, 0.8)" },
      ticks: {
        color: "#8b98a8",
        callback: (v) => chartTickFmt(v),
      },
    };
    if (yBounds) {
      yScale.min = yBounds.min;
      yScale.max = yBounds.max;
    } else {
      yScale.grace = "5%";
    }

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          grid: { color: "rgba(42, 51, 64, 0.8)" },
          ticks: { color: "#8b98a8", maxTicksLimit: 8 },
        },
        y: yScale,
      },
      plugins: {
        legend: { labels: { color: "#e8ecf1" } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const y = ctx.parsed.y;
              if (y == null || Number.isNaN(y)) return "";
              const m = METRICS[selectedMetricIndex];
              return (
                (ctx.dataset.label || m.label) +
                ": " +
                formatVal(m, y)
              );
            },
          },
        },
      },
    };
  }

  function openModal(i) {
    selectedMetricIndex = i;
    const m = METRICS[i];
    els.modalTitle.textContent = m.label + " — live";
    const pts = history[i].filter((p) => Number.isFinite(p.y));
    const cur = pts.length ? pts[pts.length - 1].y : NaN;
    let sub = Number.isFinite(cur) ? formatVal(m, cur) + " " + m.unit : "—";
    if (Number.isFinite(cur) && m.id === "pm25") {
      sub += " · " + getPm25Status(cur).symbol;
    }
    if (Number.isFinite(cur) && m.id === "humidity") {
      sub += " · " + getHumidityStatus(cur).symbol;
    }
    if (Number.isFinite(cur) && m.id === "pressure") {
      sub += " · " + getPressureStatus(cur).symbol;
    }
    els.modalCurrent.textContent = sub;
    els.modal.classList.add("open");
    els.modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => renderChart());
  }

  function closeModal() {
    els.modal.classList.remove("open");
    els.modal.setAttribute("aria-hidden", "true");
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function renderChart() {
    if (typeof Chart === "undefined") return;
    const m = METRICS[selectedMetricIndex];
    const pts = history[selectedMetricIndex].filter((p) => Number.isFinite(p.y));
    const slice = pts.slice(-CHART_WINDOW);
    const labels = slice.map((p) => p.x.toFixed(1) + "s");
    const data = slice.map((p) => p.y);
    const yBounds = computeYAxisBounds(data, m.id);

    if (chart) chart.destroy();

    const ctx = els.chartCanvas.getContext("2d");
    chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: m.label + " (" + m.unit + ")",
            data,
            borderColor: "rgba(61, 156, 240, 1)",
            backgroundColor: "rgba(61, 156, 240, 0.12)",
            fill: true,
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: buildChartOptions(yBounds),
    });
  }

  let chartRefreshPending = false;
  function scheduleChartRefresh() {
    if (!els.modal.classList.contains("open")) return;
    if (chartRefreshPending) return;
    chartRefreshPending = true;
    requestAnimationFrame(() => {
      chartRefreshPending = false;
      const m = METRICS[selectedMetricIndex];
      const pts = history[selectedMetricIndex].filter((p) => Number.isFinite(p.y));
      const slice = pts.slice(-CHART_WINDOW);
      const last = slice.length ? slice[slice.length - 1].y : NaN;
      let sub = Number.isFinite(last) ? formatVal(m, last) + " " + m.unit : "—";
      if (Number.isFinite(last) && m.id === "pm25")
        sub += " · " + getPm25Status(last).symbol;
      if (Number.isFinite(last) && m.id === "humidity")
        sub += " · " + getHumidityStatus(last).symbol;
      if (Number.isFinite(last) && m.id === "pressure")
        sub += " · " + getPressureStatus(last).symbol;
      els.modalCurrent.textContent = sub;
      renderChart();
    });
  }

  if (els.connUsb)
    els.connUsb.addEventListener("change", () => syncConnModeUi());
  if (els.connWifi)
    els.connWifi.addEventListener("change", () => syncConnModeUi());

  els.connect.addEventListener("click", connect);
  els.disconnect.addEventListener("click", disconnect);
  els.modalClose.addEventListener("click", closeModal);
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.modal.classList.contains("open")) closeModal();
  });

  syncConnModeUi();

  buildCards();

  if (els.humidityPanel) {
    els.humidityPanel.addEventListener("click", () =>
      openModal(CSV_HUMIDITY)
    );
    els.humidityPanel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openModal(CSV_HUMIDITY);
      }
    });
  }

  const pressurePanel = document.getElementById("pressure-panel");
  if (pressurePanel) {
    pressurePanel.addEventListener("click", () => openModal(CSV_PRESSURE));
    pressurePanel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openModal(CSV_PRESSURE);
      }
    });
  }

  setInterval(() => {
    if (els.modal.classList.contains("open")) scheduleChartRefresh();
  }, 500);

  window.addEventListener("beforeunload", disconnect);
})();
