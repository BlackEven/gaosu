/*
  综合态势演示：不依赖任何第三方库
  - 伪三维实景底图：网格+地形起伏+高速公路带
  - 机场/无人机/航线/航迹/禁飞区图层
  - 实时/回放时间轴
  - 多屏直播：模拟画面
  - 虚拟座舱：HUD + 前视伪渲染
*/

(() => {
  /** @typedef {{x:number,y:number,z:number}} Vec3 */

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const deg2rad = (d) => (d * Math.PI) / 180;
  const rad2deg = (r) => (r * 180) / Math.PI;
  const nowMs = () => Date.now();

  function shortTime(tsMs) {
    const d = new Date(tsMs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function formatNum(n, digits = 1) {
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits);
  }

  function vec(x, y, z = 0) {
    return { x, y, z };
  }

  function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  }

  function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  }

  function mul(a, s) {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
  }

  function len(a) {
    return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  }

  function norm(a) {
    const l = len(a) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  }

  function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  function rotateY(v, yawRad) {
    const c = Math.cos(yawRad);
    const s = Math.sin(yawRad);
    return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
  }

  function rotateX(v, pitchRad) {
    const c = Math.cos(pitchRad);
    const s = Math.sin(pitchRad);
    return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
  }

  function project(world, camera, viewport) {
    // camera: {center:Vec3, yawRad, pitchRad, dist}
    // We build a simple orbit camera around center.
    const { width, height } = viewport;

    // Convert world to camera space.
    const rel = sub(world, camera.center);

    // Move the camera back by dist along -Z after rotations.
    // Here we rotate world around center in inverse camera rotation.
    let p = rel;
    p = rotateY(p, -camera.yawRad);
    p = rotateX(p, -camera.pitchRad);

    // Place camera at (0,0,dist) looking towards origin; so shift z.
    p = { x: p.x, y: p.y, z: p.z + camera.dist };

    const fov = camera.fov;
    const f = 0.5 * height / Math.tan(fov / 2);

    // Behind camera
    if (p.z <= 1) return null;

    const sx = (p.x * f) / p.z + width / 2;
    const sy = (-p.y * f) / p.z + height / 2;

    // Depth for painter sort
    return { x: sx, y: sy, z: p.z };
  }

  function polylineLength(points) {
    let L = 0;
    for (let i = 1; i < points.length; i++) {
      L += len(sub(points[i], points[i - 1]));
    }
    return L;
  }

  function pointOnPolyline(points, t01) {
    const total = polylineLength(points);
    const target = clamp(t01, 0, 1) * total;
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const seg = len(sub(b, a));
      if (acc + seg >= target) {
        const u = (target - acc) / (seg || 1);
        const p = { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) };
        const dir = norm(sub(b, a));
        const headingRad = Math.atan2(dir.x, dir.z); // note x-z plane
        return { p, headingRad, segIndex: i - 1, u };
      }
      acc += seg;
    }
    const last = points[points.length - 1];
    const prev = points[points.length - 2] || last;
    const dir = norm(sub(last, prev));
    const headingRad = Math.atan2(dir.x, dir.z);
    return { p: last, headingRad, segIndex: points.length - 2, u: 1 };
  }

  function makeHighway() {
    // A smooth-ish highway centerline in world coordinates.
    // Units are meters in a local plane.
    const pts = [];
    const baseZ = 0;
    let x = -1200;
    let z = -900;
    for (let i = 0; i < 20; i++) {
      const t = i / 19;
      const curve = Math.sin(t * Math.PI * 2.2) * 380 + Math.sin(t * Math.PI * 6.2) * 80;
      const hill = Math.sin(t * Math.PI * 2.4) * 26 + Math.cos(t * Math.PI * 3.0) * 18;
      pts.push(vec(x + t * 2400, baseZ + hill, z + t * 2000 + curve));
    }
    return pts;
  }

  function makeNoFlyPolygon() {
    // Simple rectangle-ish polygon near the center.
    return [vec(-120, 0, 160), vec(220, 0, 120), vec(320, 0, 420), vec(-60, 0, 500)];
  }

  function pointInPolyXZ(p, poly) {
    // Ray casting on x-z plane.
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x,
        zi = poly[i].z;
      const xj = poly[j].x,
        zj = poly[j].z;
      const intersect = zi > p.z !== zj > p.z && p.x < ((xj - xi) * (p.z - zi)) / (zj - zi + 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function distToPolylineXZ(p, points) {
    // distance from point to polyline on x-z plane
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const ap = { x: p.x - a.x, z: p.z - a.z };
      const ab = { x: b.x - a.x, z: b.z - a.z };
      const ab2 = ab.x * ab.x + ab.z * ab.z;
      const t = clamp((ap.x * ab.x + ap.z * ab.z) / (ab2 || 1), 0, 1);
      const cx = a.x + ab.x * t;
      const cz = a.z + ab.z * t;
      const dx = p.x - cx;
      const dz = p.z - cz;
      best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
    }
    return best;
  }

  function distPointToSegmentXZ(p, a, b) {
    const apx = p.x - a.x;
    const apz = p.z - a.z;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const ab2 = abx * abx + abz * abz;
    const t = clamp((apx * abx + apz * abz) / (ab2 || 1), 0, 1);
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    const dx = p.x - cx;
    const dz = p.z - cz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  function distToPolygonEdgesXZ(p, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      best = Math.min(best, distPointToSegmentXZ(p, a, b));
    }
    return best;
  }

  function makeScene() {
    const highway = makeHighway();

    const airports = [
      {
        airportId: "a-01",
        name: "K12 无人机机场",
        pos: add(highway[2], vec(-220, 0, -80)),
        status: "online",
        padsTotal: 4,
        padsAvailable: 2,
        radiusM: 800,
      },
      {
        airportId: "a-02",
        name: "K18 无人机机场",
        pos: add(highway[15], vec(240, 0, 120)),
        status: "maintenance",
        padsTotal: 3,
        padsAvailable: 0,
        radiusM: 650,
      },
    ];

    const routes = [
      {
        routeId: "r-03",
        name: "K12-K18 巡线",
        corridorWidthM: 160,
        points: highway.map((p) => add(p, vec(0, 120, 0))),
        type: "standard",
      },
      {
        routeId: "r-04",
        name: "K12 边坡巡检（支线）",
        corridorWidthM: 120,
        points: [
          add(highway[4], vec(-120, 120, -60)),
          add(highway[5], vec(-260, 120, 120)),
          add(highway[7], vec(-380, 120, 320)),
          add(highway[8], vec(-260, 120, 520)),
        ],
        type: "recommended",
      },
    ];

    const drones = [
      {
        droneId: "d-01",
        name: "无人机-01",
        homeAirportId: "a-01",
        status: "executing",
        routeId: "r-03",
        battery: 0.62,
        linkQuality: 0.91,
        speedMS: 12.1,
        dir: 1,
        t01: 0.18,
        lastUpdateMs: nowMs(),
        track: [],
      },
      {
        droneId: "d-02",
        name: "无人机-02",
        homeAirportId: "a-01",
        status: "idle",
        routeId: "r-04",
        battery: 0.88,
        linkQuality: 0.97,
        speedMS: 0,
        dir: 0,
        t01: 0.02,
        lastUpdateMs: nowMs(),
        track: [],
      },
    ];

    const noFly = makeNoFlyPolygon();

    return {
      highway,
      airports,
      routes,
      drones,
      noFly,
      alerts: [],
      tasks: [],
      assets: [],
    };
  }

  function severityOf(type) {
    if (type === "CRITICAL_BATTERY" || type === "LINK_LOST" || type === "GEOFENCE_BREACH") return "critical";
    if (type === "LOW_BATTERY" || type === "LINK_DEGRADED" || type === "DEVIATION" || type === "WIND_EXCEED")
      return "warn";
    return "info";
  }

  function genAlert(scene, drone, type, message, location) {
    const a = {
      alertId: `al-${Math.floor(Math.random() * 1e8)}`,
      timeMs: nowMs(),
      alertType: type,
      severity: severityOf(type),
      message,
      bind: { droneId: drone?.droneId ?? null, airportId: drone?.homeAirportId ?? null, routeId: drone?.routeId ?? null },
      location,
      ack: false,
      recommendActions: [
        { code: "LOCATE", label: "定位" },
        { code: "OPEN_COCKPIT", label: "进入座舱" },
        { code: "RETURN_HOME", label: "建议返航" },
      ],
    };
    scene.alerts.unshift(a);
    scene.alerts = scene.alerts.slice(0, 120);
    return a;
  }

  function createTasks(scene) {
    scene.tasks = [
      {
        id: "t-1008",
        title: "K12-K18 巡线任务",
        timeMs: nowMs() - 6 * 60 * 1000,
        status: "executing",
        droneId: "d-01",
        routeId: "r-03",
      },
      {
        id: "t-1011",
        title: "K12 边坡巡检（待命）",
        timeMs: nowMs() - 18 * 60 * 1000,
        status: "planned",
        droneId: "d-02",
        routeId: "r-04",
      },
    ];
  }

  function createAssets(scene) {
    const online = scene.airports.filter((a) => a.status === "online").length;
    const maint = scene.airports.filter((a) => a.status !== "online").length;
    scene.assets = [
      { id: "as-1", title: `机场健康：在线 ${online} / 异常 ${maint}`, timeMs: nowMs(), kind: "airport" },
      { id: "as-2", title: "通信链路：总体良好（演示）", timeMs: nowMs(), kind: "net" },
      { id: "as-3", title: "模型服务：正常（演示）", timeMs: nowMs(), kind: "model" },
    ];
  }

  function getActiveAlerts() {
    return state.timeMode === "replay" ? state.replayAlerts : scene.alerts;
  }

  function isAlertAcked(alert) {
    if (state.timeMode === "replay") return state.replayAckIds.has(alert.alertId);
    return Boolean(alert.ack);
  }

  function toggleAck(alert) {
    if (state.timeMode === "replay") {
      if (state.replayAckIds.has(alert.alertId)) state.replayAckIds.delete(alert.alertId);
      else state.replayAckIds.add(alert.alertId);
      return;
    }
    alert.ack = !alert.ack;
  }

  function computeKpis(scene) {
    const airportsOnline = scene.airports.filter((a) => a.status === "online").length;
    const dronesExecuting = scene.drones.filter((d) => d.status === "executing").length;
    const dronesAvailable = scene.drones.filter((d) => d.status !== "lost").length;
    const activeAlerts = getActiveAlerts();
    const openAlerts = activeAlerts.filter((a) => !isAlertAcked(a)).length;

    const critical = activeAlerts.filter((a) => !isAlertAcked(a) && a.severity === "critical").length;
    const warn = activeAlerts.filter((a) => !isAlertAcked(a) && a.severity === "warn").length;
    const info = activeAlerts.filter((a) => !isAlertAcked(a) && a.severity === "info").length;

    return { airportsOnline, dronesExecuting, dronesAvailable, openAlerts, critical, warn, info };
  }

  function $(id) {
    return document.getElementById(id);
  }

  const ui = {
    sectionSelect: $("sectionSelect"),
    routeSelect: $("routeSelect"),
    searchInput: $("searchInput"),
    modeRealtimeBtn: $("modeRealtimeBtn"),
    modeReplayBtn: $("modeReplayBtn"),
    viewModeSelect: $("viewModeSelect"),
    routeStyleSelect: $("routeStyleSelect"),
    focusPolicySelect: $("focusPolicySelect"),

    layerAirports: $("layerAirports"),
    layerDrones: $("layerDrones"),
    layerRoutes: $("layerRoutes"),
    layerTracks: $("layerTracks"),
    layerNoFly: $("layerNoFly"),

    btnLocateDrone: $("btnLocateDrone"),
    btnLocateAirport: $("btnLocateAirport"),
    btnToggleLive: $("btnToggleLive"),
    btnEnterCockpit: $("btnEnterCockpit"),

    mapCanvas: $("mapCanvas"),

    kpiAirportsOnline: $("kpiAirportsOnline"),
    kpiDronesAvailable: $("kpiDronesAvailable"),
    kpiDronesExecuting: $("kpiDronesExecuting"),
    kpiAlertsOpen: $("kpiAlertsOpen"),

    alertCriticalCount: $("alertCriticalCount"),
    alertWarnCount: $("alertWarnCount"),
    alertInfoCount: $("alertInfoCount"),

    tabAlerts: $("tabAlerts"),
    tabTasks: $("tabTasks"),
    tabAssets: $("tabAssets"),
    feedList: $("feedList"),
    detailPanel: $("detailPanel"),

    playBtn: $("playBtn"),
    pauseBtn: $("pauseBtn"),
    speedSelect: $("speedSelect"),
    timeSlider: $("timeSlider"),
    timeText: $("timeText"),
    modeHint: $("modeHint"),

    btnSnapshot: $("btnSnapshot"),
    btnResetView: $("btnResetView"),

    liveOverlay: $("liveOverlay"),
    liveGrid: $("liveGrid"),
    liveLayout2: $("liveLayout2"),
    liveLayout4: $("liveLayout4"),
    liveLayout6: $("liveLayout6"),
    closeLive: $("closeLive"),

    cockpitOverlay: $("cockpitOverlay"),
    cockpitCanvas: $("cockpitCanvas"),
    cockpitSwitchView: $("cockpitSwitchView"),
    closeCockpit: $("closeCockpit"),

    hudTitle: $("hudTitle"),
    hudSub: $("hudSub"),
    hudBattery: $("hudBattery"),
    hudLink: $("hudLink"),
    hudWarning: $("hudWarning"),
    hudSpeed: $("hudSpeed"),
    hudAlt: $("hudAlt"),
    hudHeading: $("hudHeading"),
    hudWp: $("hudWp"),
    hudEta: $("hudEta"),

    weatherText: $("weatherText"),
  };

  const state = {
    activeFeed: "alerts",
    timeMode: "realtime", // realtime | replay
    speed: 1,
    playing: true,
    replaySeconds: 600,
    replayCursorSec: 600,
    scenarioStartMs: nowMs() - 600 * 1000,
    replayAckIds: new Set(),
    replayAlerts: [],

    selected: { type: null, id: null },

    viewMode: "free",
    routeStyle: "corridor",
    focusPolicy: "on",

    layers: {
      airports: true,
      drones: true,
      routes: true,
      tracks: true,
      noFly: false,
    },

    follow: { kind: null, id: null },

    map: {
      camera: {
        center: vec(0, 50, 0),
        yawRad: deg2rad(28),
        pitchRad: deg2rad(52),
        dist: 2200,
        fov: deg2rad(55),
      },
      dragging: false,
      dragBtn: 0,
      lastX: 0,
      lastY: 0,
    },

    cockpit: {
      enabled: false,
      view: "fpv", // fpv | chase
    },

    live: {
      open: false,
      layout: 4,
      tiles: [],
      primaryIndex: 0,
    },
  };

  const scene = makeScene();
  createTasks(scene);
  createAssets(scene);

  function initSelectors() {
    ui.sectionSelect.innerHTML = "";
    const sections = [
      { id: "sec-01", name: "标段A（K12-K18）" },
      { id: "sec-02", name: "标段B（K18-K22）" },
    ];
    for (const s of sections) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      ui.sectionSelect.appendChild(opt);
    }

    ui.routeSelect.innerHTML = "";
    for (const r of scene.routes) {
      const opt = document.createElement("option");
      opt.value = r.routeId;
      opt.textContent = r.name;
      ui.routeSelect.appendChild(opt);
    }
    ui.routeSelect.value = "r-03";
  }

  function setMode(mode) {
    state.timeMode = mode;
    ui.modeRealtimeBtn.classList.toggle("seg__btn--active", mode === "realtime");
    ui.modeReplayBtn.classList.toggle("seg__btn--active", mode === "replay");

    if (mode === "realtime") {
      state.playing = true;
      ui.playBtn.disabled = false;
      ui.pauseBtn.disabled = true;
      ui.modeHint.textContent = "实时：锁定当前";
    } else {
      state.playing = false;
      ui.playBtn.disabled = false;
      ui.pauseBtn.disabled = true;
      ui.modeHint.textContent = "回放：拖动时间轴或播放";
      state.replayCursorSec = Number(ui.timeSlider.value);
    }
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    ui.viewModeSelect.value = mode;
    if (mode === "topdown") {
      state.map.camera.pitchRad = deg2rad(78);
      state.map.camera.dist = 2600;
    }
    if (mode === "followDrone") {
      const d = scene.drones.find((x) => x.droneId === "d-01") ?? scene.drones[0];
      state.follow = { kind: "drone", id: d.droneId };
    }
    if (mode === "followRoute") {
      state.follow = { kind: "route", id: ui.routeSelect.value };
    }
    if (mode === "free") {
      state.follow = { kind: null, id: null };
    }
    if (mode === "cockpit") {
      openCockpit();
    }
  }

  function setActiveFeed(feed) {
    state.activeFeed = feed;
    ui.tabAlerts.classList.toggle("tab--active", feed === "alerts");
    ui.tabTasks.classList.toggle("tab--active", feed === "tasks");
    ui.tabAssets.classList.toggle("tab--active", feed === "assets");
    renderFeed();
  }

  function renderFeed() {
    ui.feedList.innerHTML = "";
    const items =
      state.activeFeed === "alerts" ? getActiveAlerts() : state.activeFeed === "tasks" ? scene.tasks : scene.assets;

    for (const it of items.slice(0, 24)) {
      const el = document.createElement("div");
      const acked = state.activeFeed === "alerts" ? isAlertAcked(it) : false;
      el.className = "feed-item" + (acked ? " feed-item--acked" : "");
      const timeMs = it.timeMs ?? nowMs();
      const title =
        state.activeFeed === "alerts"
          ? `${it.alertType}`
          : state.activeFeed === "tasks"
            ? `${it.title}`
            : `${it.title}`;

      const badge =
        state.activeFeed === "alerts"
          ? `<span class="badge badge--${it.severity}">${it.severity === "critical" ? "红" : it.severity === "warn" ? "橙" : "黄"}</span>`
          : `<span class="badge">${state.activeFeed === "tasks" ? it.status : it.kind}</span>`;

      const msg =
        state.activeFeed === "alerts"
          ? it.message
          : state.activeFeed === "tasks"
            ? `无人机：${it.droneId} / 航线：${it.routeId}`
            : "";

      const actions =
        state.activeFeed === "alerts"
          ? `
        <div class="feed-actions">
          <button class="btn-mini btn-mini--primary" data-act="locate">定位</button>
          <button class="btn-mini" data-act="cockpit">座舱</button>
          <button class="btn-mini" data-act="return">建议返航</button>
          <button class="btn-mini btn-mini--danger" data-act="ack">${acked ? "取消ACK" : "ACK"}</button>
        </div>
      `
          : "";

      el.innerHTML = `
        <div class="feed-item__top">
          <div class="feed-item__title">${title}</div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${badge}
            <div class="feed-item__time">${shortTime(timeMs ?? nowMs())}</div>
          </div>
        </div>
        <div class="feed-item__msg">${msg}</div>
        ${actions}
      `;

      el.addEventListener("click", () => {
        if (state.activeFeed === "alerts") {
          const droneId = it.bind?.droneId;
          if (droneId) {
            selectObject("drone", droneId);
            focusOnDrone(droneId);
          }
        } else if (state.activeFeed === "tasks") {
          selectObject("drone", it.droneId);
          focusOnDrone(it.droneId);
        }
      });

      if (state.activeFeed === "alerts") {
        el.querySelectorAll("button[data-act]").forEach((b) => {
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            const act = b.getAttribute("data-act");
            const droneId = it.bind?.droneId;
            if (act === "locate" && droneId) {
              selectObject("drone", droneId);
              focusOnDrone(droneId);
            }
            if (act === "cockpit") openCockpit();
            if (act === "ack") {
              toggleAck(it);
              updateHeaderKpis();
              renderFeed();
            }
            if (act === "return") {
              // 演示：只在实时模式下改变无人机状态
              if (state.timeMode !== "realtime" || !droneId) return;
              const d = scene.drones.find((x) => x.droneId === droneId);
              if (!d) return;
              d.status = "returning";
              d.dir = -1;
              d.speedMS = Math.max(d.speedMS, 10);
            }
          });
        });
      }

      ui.feedList.appendChild(el);
    }
  }

  function selectObject(type, id) {
    state.selected = { type, id };
    renderDetail();
  }

  function renderDetail() {
    const { type, id } = state.selected;
    if (!type || !id) {
      ui.detailPanel.innerHTML = `<div class="detail__empty">点击地图上的机场/无人机/航线查看详情</div>`;
      return;
    }

    if (type === "airport") {
      const a = scene.airports.find((x) => x.airportId === id);
      if (!a) return;
      ui.detailPanel.innerHTML = `
        <h4>${a.name}</h4>
        <div class="kv">
          <div class="k">状态</div><div class="v">${a.status}</div>
          <div class="k">停机位</div><div class="v">${a.padsAvailable}/${a.padsTotal}</div>
          <div class="k">覆盖半径</div><div class="v">${a.radiusM}m</div>
        </div>
        <div class="actions">
          <button class="btn btn--primary" data-act="locateAirport">定位</button>
          <button class="btn" data-act="openLive">打开直播</button>
        </div>
      `;
      ui.detailPanel.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          const act = b.getAttribute("data-act");
          if (act === "locateAirport") focusOnAirport(a.airportId);
          if (act === "openLive") openLive();
        });
      });
      return;
    }

    if (type === "drone") {
      const d = scene.drones.find((x) => x.droneId === id);
      if (!d) return;
      ui.detailPanel.innerHTML = `
        <h4>${d.name}</h4>
        <div class="kv">
          <div class="k">状态</div><div class="v">${d.status}</div>
          <div class="k">电量</div><div class="v">${Math.round(d.battery * 100)}%</div>
          <div class="k">链路</div><div class="v">${Math.round(d.linkQuality * 100)}%</div>
          <div class="k">航线</div><div class="v">${d.routeId}</div>
          <div class="k">速度</div><div class="v">${formatNum(d.speedMS, 1)} m/s</div>
        </div>
        <div class="actions">
          <button class="btn btn--primary" data-act="locateDrone">定位</button>
          <button class="btn" data-act="followDrone">跟随</button>
          <button class="btn" data-act="openLive">打开直播</button>
          <button class="btn" data-act="openCockpit">进入座舱</button>
        </div>
      `;
      ui.detailPanel.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          const act = b.getAttribute("data-act");
          if (act === "locateDrone") focusOnDrone(d.droneId);
          if (act === "followDrone") {
            state.follow = { kind: "drone", id: d.droneId };
            state.viewMode = "followDrone";
            ui.viewModeSelect.value = "followDrone";
          }
          if (act === "openLive") openLive();
          if (act === "openCockpit") openCockpit();
        });
      });
      return;
    }

    if (type === "route") {
      const r = scene.routes.find((x) => x.routeId === id);
      if (!r) return;
      ui.detailPanel.innerHTML = `
        <h4>${r.name}</h4>
        <div class="kv">
          <div class="k">类型</div><div class="v">${r.type}</div>
          <div class="k">走廊宽</div><div class="v">${r.corridorWidthM}m</div>
          <div class="k">航点数</div><div class="v">${r.points.length}</div>
        </div>
        <div class="actions">
          <button class="btn btn--primary" data-act="followRoute">跟随航线</button>
          <button class="btn" data-act="locateRoute">定位</button>
        </div>
      `;
      ui.detailPanel.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          const act = b.getAttribute("data-act");
          if (act === "followRoute") {
            state.follow = { kind: "route", id: r.routeId };
            state.viewMode = "followRoute";
            ui.viewModeSelect.value = "followRoute";
          }
          if (act === "locateRoute") focusOnRoute(r.routeId);
        });
      });
    }
  }

  function focusOnAirport(airportId) {
    const a = scene.airports.find((x) => x.airportId === airportId);
    if (!a) return;
    state.map.camera.center = add(a.pos, vec(0, 60, 0));
  }

  function focusOnDrone(droneId) {
    const d = scene.drones.find((x) => x.droneId === droneId);
    if (!d) return;
    const r = scene.routes.find((x) => x.routeId === d.routeId);
    const t = pointOnPolyline(r.points, d.t01);
    state.map.camera.center = add(t.p, vec(0, 50, 0));
  }

  function focusOnRoute(routeId) {
    const r = scene.routes.find((x) => x.routeId === routeId);
    if (!r) return;
    // center at mid point
    const mid = r.points[Math.floor(r.points.length / 2)];
    state.map.camera.center = add(mid, vec(0, 50, 0));
  }

  function resetView() {
    state.map.camera.center = vec(0, 50, 0);
    state.map.camera.yawRad = deg2rad(28);
    state.map.camera.pitchRad = deg2rad(52);
    state.map.camera.dist = 2200;
    state.follow = { kind: null, id: null };
    state.viewMode = "free";
    ui.viewModeSelect.value = "free";
  }

  function snapshot() {
    const a = document.createElement("a");
    a.download = `overview_${Date.now()}.png`;
    a.href = ui.mapCanvas.toDataURL("image/png");
    a.click();
  }

  function openLive() {
    state.live.open = true;
    ui.liveOverlay.classList.remove("overlay--hidden");
    renderLive();
  }

  function closeLive() {
    state.live.open = false;
    ui.liveOverlay.classList.add("overlay--hidden");
  }

  function openCockpit() {
    state.cockpit.enabled = true;
    ui.cockpitOverlay.classList.remove("overlay--hidden");
    state.viewMode = "followDrone";
    ui.viewModeSelect.value = "followDrone";
    state.follow = { kind: "drone", id: "d-01" };
  }

  function closeCockpit() {
    state.cockpit.enabled = false;
    ui.cockpitOverlay.classList.add("overlay--hidden");
  }

  function buildLiveTiles() {
    const base = [
      { id: "s1", name: "云台-01（无人机-01）", bind: { droneId: "d-01" } },
      { id: "s2", name: "FPV-01（无人机-01）", bind: { droneId: "d-01" } },
      { id: "s3", name: "起降监控（K12机场）", bind: { airportId: "a-01" } },
      { id: "s4", name: "沿线布控球（K16）", bind: { routeId: "r-03" } },
      { id: "s5", name: "云台-02（无人机-02）", bind: { droneId: "d-02" } },
      { id: "s6", name: "备用机位（演示）", bind: {} },
    ];
    state.live.tiles = base;
  }

  function renderLive() {
    const n = state.live.layout;
    ui.liveGrid.innerHTML = "";
    ui.liveGrid.classList.toggle("live-grid--2", n === 2);
    ui.liveGrid.classList.toggle("live-grid--4", n === 4);
    ui.liveGrid.classList.toggle("live-grid--6", n === 6);

    for (let i = 0; i < n; i++) {
      const tile = state.live.tiles[i % state.live.tiles.length];
      const el = document.createElement("div");
      el.className = "live-tile" + (i === state.live.primaryIndex ? " live-tile--primary" : "");
      el.innerHTML = `
        <canvas class="live-canvas" data-idx="${i}"></canvas>
        <div class="live-label">${tile.name}</div>
        <div class="live-meta">
          <span class="badge">${tile.bind.droneId ? tile.bind.droneId : tile.bind.airportId ? tile.bind.airportId : tile.bind.routeId ? tile.bind.routeId : "模拟"}</span>
        </div>
      `;
      el.addEventListener("click", () => {
        state.live.primaryIndex = i;
        // map linkage
        if (tile.bind.droneId) {
          selectObject("drone", tile.bind.droneId);
          focusOnDrone(tile.bind.droneId);
        } else if (tile.bind.airportId) {
          selectObject("airport", tile.bind.airportId);
          focusOnAirport(tile.bind.airportId);
        } else if (tile.bind.routeId) {
          selectObject("route", tile.bind.routeId);
          focusOnRoute(tile.bind.routeId);
        }
        renderLive();
      });
      ui.liveGrid.appendChild(el);
    }

    // init canvases
    ui.liveGrid.querySelectorAll("canvas").forEach((c) => {
      const canvas = /** @type {HTMLCanvasElement} */ (c);
      const ctx = canvas.getContext("2d");
      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
        canvas.height = Math.max(1, Math.floor(rect.height * devicePixelRatio));
      };
      resize();
      ctx.imageSmoothingEnabled = false;
    });
  }

  function tickLive() {
    if (!state.live.open) return;
    const canvases = ui.liveGrid.querySelectorAll("canvas");
    canvases.forEach((c, idx) => {
      const canvas = /** @type {HTMLCanvasElement} */ (c);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = canvas.width,
        h = canvas.height;
      const t = nowMs() / 1000;
      // Simple animated noise + gradient to simulate video
      const img = ctx.createImageData(w, h);
      const data = img.data;
      const base = idx === state.live.primaryIndex ? 1.0 : 0.6;
      for (let i = 0; i < data.length; i += 4) {
        const x = ((i / 4) % w) / w;
        const y = Math.floor(i / 4 / w) / h;
        const n = (Math.sin(x * 18 + t * 2.1) + Math.cos(y * 14 - t * 1.7) + Math.sin((x + y) * 11 + t)) / 3;
        const r = 20 + 30 * (n + 1) * base;
        const g = 40 + 70 * (0.6 + 0.4 * Math.sin(t + x * 2.2)) * base;
        const b = 60 + 120 * (0.6 + 0.4 * Math.cos(t * 0.7 + y * 2.4)) * base;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, w, 40 * devicePixelRatio);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = `${12 * devicePixelRatio}px ui-monospace`;
      ctx.fillText(`LIVE ${shortTime(Date.now())}`, 12 * devicePixelRatio, 26 * devicePixelRatio);
    });
  }

  function attachMapEvents() {
    const canvas = ui.mapCanvas;

    const onResize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
      canvas.height = Math.max(1, Math.floor(rect.height * devicePixelRatio));
    };

    window.addEventListener("resize", onResize);
    onResize();

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("mousedown", (e) => {
      state.map.dragging = true;
      state.map.dragBtn = e.button;
      state.map.lastX = e.clientX;
      state.map.lastY = e.clientY;
    });

    window.addEventListener("mouseup", () => {
      state.map.dragging = false;
    });

    window.addEventListener("mousemove", (e) => {
      if (!state.map.dragging) return;
      const dx = e.clientX - state.map.lastX;
      const dy = e.clientY - state.map.lastY;
      state.map.lastX = e.clientX;
      state.map.lastY = e.clientY;

      // If following, allow user to temporarily break follow
      if (state.follow.kind) {
        state.follow = { kind: null, id: null };
        state.viewMode = "free";
        ui.viewModeSelect.value = "free";
      }

      const cam = state.map.camera;

      if (state.map.dragBtn === 2) {
        cam.yawRad += dx * 0.006;
        cam.pitchRad = clamp(cam.pitchRad + dy * 0.006, deg2rad(20), deg2rad(85));
      } else {
        // Pan in camera-aligned ground plane
        const panScale = cam.dist / 900;
        const yaw = cam.yawRad;
        const right = vec(Math.cos(yaw), 0, Math.sin(yaw));
        const forward = vec(-Math.sin(yaw), 0, Math.cos(yaw));
        cam.center = add(cam.center, add(mul(right, -dx * panScale), mul(forward, dy * panScale)));
      }
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const cam = state.map.camera;
      const delta = Math.sign(e.deltaY);
      cam.dist = clamp(cam.dist * (delta > 0 ? 1.08 : 0.92), 650, 5200);
    });

    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * devicePixelRatio;
      const y = (e.clientY - rect.top) * devicePixelRatio;
      const hit = pickObjectAt(x, y);
      if (hit) {
        selectObject(hit.type, hit.id);
        if (hit.type === "drone") focusOnDrone(hit.id);
        if (hit.type === "airport") focusOnAirport(hit.id);
        if (hit.type === "route") focusOnRoute(hit.id);
      }
    });
  }

  function pickObjectAt(px, py) {
    // Simple screen-space pick using last rendered projected positions.
    // We'll keep a pick buffer each frame.
    const best = { dist2: Infinity, hit: null };
    for (const o of pickBuffer) {
      const dx = o.x - px;
      const dy = o.y - py;
      const d2 = dx * dx + dy * dy;
      const r2 = (o.r || 16) * (o.r || 16);
      if (d2 <= r2 && d2 < best.dist2) {
        best.dist2 = d2;
        best.hit = { type: o.type, id: o.id };
      }
    }
    return best.hit;
  }

  /** @type {{type:string,id:string,x:number,y:number,r:number}[]} */
  let pickBuffer = [];

  function updateSimulation(dtSec, simTimeMs) {
    // Drone 01 executes route with constant speed; Drone 02 stays near airport.
    for (const d of scene.drones) {
      const r = scene.routes.find((x) => x.routeId === d.routeId);
      if (!r) continue;

      if (d.status === "executing" || d.status === "returning") {
        const v = (d.speedMS || 10) / (polylineLength(r.points) || 1);
        const dir = d.status === "returning" ? -1 : d.dir || 1;
        d.t01 = d.t01 + v * dtSec * dir;
        if (d.t01 < 0) d.t01 = 0;
        if (d.t01 > 1) d.t01 = d.t01 % 1;

        // slowly drain battery
        d.battery = clamp(d.battery - dtSec * (d.status === "returning" ? 0.00014 : 0.00018), 0, 1);
        // link fluctuation
        d.linkQuality = clamp(d.linkQuality + (Math.random() - 0.5) * 0.01, 0.05, 1);

        // record track (keep last 5 minutes)
        d.track.push({ timeMs: simTimeMs, t01: d.t01 });
        const keepMs = 5 * 60 * 1000;
        d.track = d.track.filter((p) => simTimeMs - p.timeMs <= keepMs);

        // safety checks to generate demo alerts
        if (d.battery < 0.25 && !scene.alerts.some((a) => !a.ack && a.alertType === "LOW_BATTERY" && a.bind.droneId === d.droneId)) {
          const t = pointOnPolyline(r.points, d.t01);
          genAlert(scene, d, "LOW_BATTERY", "电量低于25%，建议评估返航。", { type: "point", coords: [t.p.x, t.p.y, t.p.z] });
        }
        if (d.battery < 0.15 && !scene.alerts.some((a) => !a.ack && a.alertType === "CRITICAL_BATTERY" && a.bind.droneId === d.droneId)) {
          const t = pointOnPolyline(r.points, d.t01);
          genAlert(scene, d, "CRITICAL_BATTERY", "电量低于15%，建议立即返航。", { type: "point", coords: [t.p.x, t.p.y, t.p.z] });
        }

        // geofence demo
        const t = pointOnPolyline(r.points, d.t01);
        const inside = pointInPolyXZ(t.p, scene.noFly);
        if (inside && !scene.alerts.some((a) => !a.ack && a.alertType === "GEOFENCE_BREACH" && a.bind.droneId === d.droneId)) {
          genAlert(scene, d, "GEOFENCE_BREACH", "检测到越界进入禁飞区，请立即处置。", { type: "point", coords: [t.p.x, t.p.y, t.p.z] });
        } else if (!inside) {
          // near
          const nearDist = distToPolygonEdgesXZ(t.p, scene.noFly);
          if (nearDist < 90 && !scene.alerts.some((a) => !a.ack && a.alertType === "GEOFENCE_NEAR" && a.bind.droneId === d.droneId)) {
            genAlert(scene, d, "GEOFENCE_NEAR", "接近禁飞区边界（<90m），建议调整航向。", { type: "point", coords: [t.p.x, t.p.y, t.p.z] });
          }
        }

        // link degraded
        if (d.linkQuality < 0.35 && !scene.alerts.some((a) => !a.ack && a.alertType === "LINK_DEGRADED" && a.bind.droneId === d.droneId)) {
          const tt = pointOnPolyline(r.points, d.t01);
          genAlert(scene, d, "LINK_DEGRADED", "链路质量偏低，建议检查通信与高度。", { type: "point", coords: [tt.p.x, tt.p.y, tt.p.z] });
        }
      } else {
        // idle
        d.linkQuality = clamp(d.linkQuality + (Math.random() - 0.5) * 0.005, 0.5, 1);
        d.battery = clamp(d.battery + dtSec * 0.00008, 0, 1);
      }

      // simple landing when returned to start
      if (d.status === "returning" && d.t01 <= 0.001) {
        d.status = "idle";
        d.dir = 0;
        d.speedMS = 0;
      }
    }

    // Keep tasks/assets up-to-date
    if (Math.random() < 0.01) createAssets(scene);

    // Auto focus on critical alerts
    if (state.focusPolicy === "on") {
      const critical = scene.alerts.find((a) => !a.ack && a.severity === "critical");
      if (critical && Math.random() < 0.03) {
        const droneId = critical.bind?.droneId;
        if (droneId) {
          selectObject("drone", droneId);
          state.follow = { kind: "drone", id: droneId };
          state.viewMode = "followDrone";
          ui.viewModeSelect.value = "followDrone";
        }
      }
    }

    renderFeed();
  }

  function updateReplay(simTimeMs) {
    // 在回放模式下：按时间轴“推导”无人机位置/电量/链路/航迹，并生成可复现的告警集合
    const elapsedSec = (simTimeMs - state.scenarioStartMs) / 1000;
    const d1 = scene.drones.find((x) => x.droneId === "d-01");
    const d2 = scene.drones.find((x) => x.droneId === "d-02");
    const activeRouteId = ui.routeSelect.value || "r-03";
    const r1 = scene.routes.find((x) => x.routeId === activeRouteId);
    if (!d1 || !d2 || !r1) return;

    // 固定为执行态，便于复盘；真实系统可按任务phase回放
    d1.status = "executing";
    d1.routeId = activeRouteId;
    d1.dir = 1;
    d1.speedMS = 12.1;

    const L = polylineLength(r1.points) || 1;
    const baseT = 0.18;
    d1.t01 = (baseT + (elapsedSec * d1.speedMS) / L) % 1;
    d1.battery = clamp(0.62 - elapsedSec * 0.00018, 0, 1);
    d1.linkQuality = clamp(0.86 + Math.sin(elapsedSec * 0.22) * 0.10, 0.05, 1);

    // d2 idle near airport
    d2.status = "idle";
    d2.speedMS = 0;
    d2.linkQuality = clamp(0.92 + Math.cos(elapsedSec * 0.18) * 0.04, 0.5, 1);
    d2.battery = clamp(0.88 + Math.sin(elapsedSec * 0.1) * 0.02, 0, 1);

    // rebuild track for last 5 minutes (step 5s)
    const keepSec = 5 * 60;
    const pts = [];
    for (let s = Math.max(0, elapsedSec - keepSec); s <= elapsedSec; s += 5) {
      const t01 = (baseT + (s * d1.speedMS) / L) % 1;
      pts.push({ timeMs: state.scenarioStartMs + s * 1000, t01 });
    }
    d1.track = pts;

    // alerts derived from current replay moment (persist once thresholds met)
    const t = pointOnPolyline(r1.points, d1.t01);
    const inside = pointInPolyXZ(t.p, scene.noFly);
    const dist = distToPolygonEdgesXZ(t.p, scene.noFly);

    const alerts = [];
    alerts.push({
      alertId: "replay-DEVIATION",
      timeMs: state.scenarioStartMs + 120 * 1000,
      alertType: "DEVIATION",
      severity: "warn",
      message: "航迹轻微偏离走廊（回放演示）。",
      bind: { droneId: "d-01", airportId: "a-01", routeId: activeRouteId },
      location: { type: "point", coords: [t.p.x, t.p.y, t.p.z] },
    });

    if (dist < 90 && !inside) {
      alerts.push({
        alertId: "replay-GEOFENCE_NEAR",
        timeMs: state.scenarioStartMs + 240 * 1000,
        alertType: "GEOFENCE_NEAR",
        severity: "warn",
        message: "接近禁飞区边界（<90m）（回放演示）。",
        bind: { droneId: "d-01", airportId: "a-01", routeId: activeRouteId },
        location: { type: "point", coords: [t.p.x, t.p.y, t.p.z] },
      });
    }

    if (inside) {
      alerts.push({
        alertId: "replay-GEOFENCE_BREACH",
        timeMs: state.scenarioStartMs + 300 * 1000,
        alertType: "GEOFENCE_BREACH",
        severity: "critical",
        message: "检测到越界进入禁飞区（回放演示）。",
        bind: { droneId: "d-01", airportId: "a-01", routeId: activeRouteId },
        location: { type: "point", coords: [t.p.x, t.p.y, t.p.z] },
      });
    }

    if (d1.battery < 0.25) {
      alerts.push({
        alertId: "replay-LOW_BATTERY",
        timeMs: state.scenarioStartMs + 360 * 1000,
        alertType: "LOW_BATTERY",
        severity: "warn",
        message: "电量低于25%，建议评估返航（回放演示）。",
        bind: { droneId: "d-01", airportId: "a-01", routeId: activeRouteId },
        location: { type: "point", coords: [t.p.x, t.p.y, t.p.z] },
      });
    }

    if (d1.battery < 0.15) {
      alerts.push({
        alertId: "replay-CRITICAL_BATTERY",
        timeMs: state.scenarioStartMs + 480 * 1000,
        alertType: "CRITICAL_BATTERY",
        severity: "critical",
        message: "电量低于15%，建议立即返航（回放演示）。",
        bind: { droneId: "d-01", airportId: "a-01", routeId: activeRouteId },
        location: { type: "point", coords: [t.p.x, t.p.y, t.p.z] },
      });
    }

    if (d1.linkQuality < 0.35) {
      alerts.push({
        alertId: "replay-LINK_DEGRADED",
        timeMs: state.scenarioStartMs + 420 * 1000,
        alertType: "LINK_DEGRADED",
        severity: "warn",
        message: "链路质量偏低（回放演示）。",
        bind: { droneId: "d-01", airportId: "a-01", routeId: activeRouteId },
        location: { type: "point", coords: [t.p.x, t.p.y, t.p.z] },
      });
    }

    state.replayAlerts = alerts.sort((a, b) => b.timeMs - a.timeMs);
  }

  function applyFollow() {
    const cam = state.map.camera;
    if (!state.follow.kind) return;

    if (state.follow.kind === "drone") {
      const d = scene.drones.find((x) => x.droneId === state.follow.id);
      if (!d) return;
      const r = scene.routes.find((x) => x.routeId === d.routeId);
      if (!r) return;
      const t = pointOnPolyline(r.points, d.t01);
      cam.center = add(t.p, vec(0, 60, 0));
      // slightly align yaw to heading for nicer follow
      const targetYaw = t.headingRad;
      // unwrap yaw
      const dy = ((targetYaw - cam.yawRad + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      cam.yawRad += dy * 0.03;
      cam.pitchRad = lerp(cam.pitchRad, deg2rad(55), 0.02);
      cam.dist = lerp(cam.dist, 1900, 0.02);
    }

    if (state.follow.kind === "route") {
      const r = scene.routes.find((x) => x.routeId === state.follow.id);
      if (!r) return;
      const mid = r.points[Math.floor(r.points.length / 2)];
      cam.center = add(mid, vec(0, 60, 0));
      cam.pitchRad = lerp(cam.pitchRad, deg2rad(70), 0.02);
      cam.dist = lerp(cam.dist, 2600, 0.02);
    }
  }

  function drawGround(ctx, cam, viewport) {
    // Gradient sky
    const g = ctx.createLinearGradient(0, 0, 0, viewport.height);
    g.addColorStop(0, "rgba(90,160,255,0.14)");
    g.addColorStop(0.35, "rgba(43,209,255,0.06)");
    g.addColorStop(1, "rgba(5,10,18,1)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    // Draw grid on y=0 plane
    ctx.save();
    ctx.globalAlpha = 0.55;

    const step = 200;
    const range = 2600;
    for (let x = -range; x <= range; x += step) {
      const a = project(vec(x, 0, -range), cam, viewport);
      const b = project(vec(x, 0, range), cam, viewport);
      if (!a || !b) continue;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let z = -range; z <= range; z += step) {
      const a = project(vec(-range, 0, z), cam, viewport);
      const b = project(vec(range, 0, z), cam, viewport);
      if (!a || !b) continue;
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    // Simple terrain bumps (just a few translucent blobs)
    ctx.save();
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < 10; i++) {
      const p = vec(-1400 + i * 320, 40 + (i % 3) * 18, -900 + Math.sin(i) * 600);
      const s = project(p, cam, viewport);
      if (!s) continue;
      const r = 240 * devicePixelRatio;
      const rg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      rg.addColorStop(0, "rgba(43,209,255,0.35)");
      rg.addColorStop(1, "rgba(43,209,255,0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHighway(ctx, cam, viewport) {
    const hw = scene.highway;

    // road surface as wide polyline ribbon on y=0
    const roadLeft = [];
    const roadRight = [];
    for (let i = 0; i < hw.length; i++) {
      const p = hw[i];
      const p2 = hw[Math.min(hw.length - 1, i + 1)];
      const dir = norm(sub(p2, p));
      const left = norm(vec(-dir.z, 0, dir.x));
      const w = 80;
      roadLeft.push(add(p, mul(left, w)));
      roadRight.push(add(p, mul(left, -w)));
    }

    const poly = roadLeft.concat(roadRight.reverse());
    const proj = poly.map((p) => project(p, cam, viewport)).filter(Boolean);
    if (proj.length < 6) return;

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(140,160,180,0.14)";
    ctx.beginPath();
    ctx.moveTo(proj[0].x, proj[0].y);
    for (let i = 1; i < proj.length; i++) ctx.lineTo(proj[i].x, proj[i].y);
    ctx.closePath();
    ctx.fill();

    // center line
    const mid = hw.map((p) => project(p, cam, viewport)).filter(Boolean);
    if (mid.length > 2) {
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.moveTo(mid[0].x, mid[0].y);
      for (let i = 1; i < mid.length; i++) ctx.lineTo(mid[i].x, mid[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawNoFly(ctx, cam, viewport) {
    if (!state.layers.noFly) return;
    const poly = scene.noFly;
    const pr = poly.map((p) => project(p, cam, viewport)).filter(Boolean);
    if (pr.length < 3) return;
    ctx.save();
    ctx.fillStyle = "rgba(255,59,59,0.10)";
    ctx.strokeStyle = "rgba(255,59,59,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pr[0].x, pr[0].y);
    for (let i = 1; i < pr.length; i++) ctx.lineTo(pr[i].x, pr[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawRoutes(ctx, cam, viewport) {
    if (!state.layers.routes) return;

    const activeRouteId = ui.routeSelect.value;
    for (const r of scene.routes) {
      const isActive = r.routeId === activeRouteId;
      const color = isActive ? "rgba(43,209,255,0.85)" : "rgba(120,170,255,0.45)";
      const pr = r.points.map((p) => project(p, cam, viewport)).filter(Boolean);
      if (pr.length < 2) continue;

      const showCorridor = state.routeStyle === "corridor" || state.routeStyle === "both";
      const showLine = state.routeStyle === "line" || state.routeStyle === "both";

      if (showCorridor) {
        // approximate corridor as thick stroke
        ctx.save();
        ctx.strokeStyle = isActive ? "rgba(43,209,255,0.18)" : "rgba(120,170,255,0.10)";
        ctx.lineWidth = (isActive ? 14 : 10) * devicePixelRatio;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(pr[0].x, pr[0].y);
        for (let i = 1; i < pr.length; i++) ctx.lineTo(pr[i].x, pr[i].y);
        ctx.stroke();
        ctx.restore();
      }

      if (showLine) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3 * devicePixelRatio;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(pr[0].x, pr[0].y);
        for (let i = 1; i < pr.length; i++) ctx.lineTo(pr[i].x, pr[i].y);
        ctx.stroke();
        ctx.restore();
      }

      // waypoints (only for active)
      if (isActive) {
        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.font = `${12 * devicePixelRatio}px ui-monospace`;
        for (let i = 0; i < r.points.length; i++) {
          if (i % 3 !== 0 && i !== r.points.length - 1) continue;
          const s = project(r.points[i], cam, viewport);
          if (!s) continue;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 4 * devicePixelRatio, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillText(String(i), s.x + 8 * devicePixelRatio, s.y - 6 * devicePixelRatio);
        }
        ctx.restore();
      }

      // route pick handle at mid
      if (isActive) {
        const mid = r.points[Math.floor(r.points.length / 2)];
        const s = project(mid, cam, viewport);
        if (s) pickBuffer.push({ type: "route", id: r.routeId, x: s.x, y: s.y, r: 20 * devicePixelRatio });
      }
    }
  }

  function drawAirports(ctx, cam, viewport) {
    if (!state.layers.airports) return;

    for (const a of scene.airports) {
      const p = add(a.pos, vec(0, 40, 0));
      const s = project(p, cam, viewport);
      if (!s) continue;

      // coverage ring on ground
      ctx.save();
      ctx.globalAlpha = 0.9;
      const ringPts = [];
      const N = 36;
      for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2;
        const wp = add(a.pos, vec(Math.cos(ang) * a.radiusM, 0, Math.sin(ang) * a.radiusM));
        const sp = project(wp, cam, viewport);
        if (sp) ringPts.push(sp);
      }
      if (ringPts.length > 8) {
        ctx.strokeStyle = a.status === "online" ? "rgba(41,227,155,0.28)" : "rgba(255,255,255,0.12)";
        ctx.lineWidth = 2 * devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(ringPts[0].x, ringPts[0].y);
        for (let i = 1; i < ringPts.length; i++) ctx.lineTo(ringPts[i].x, ringPts[i].y);
        ctx.closePath();
        ctx.stroke();
      }

      // airport marker
      ctx.fillStyle = a.status === "online" ? "rgba(41,227,155,0.95)" : "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();

      // label
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.font = `${12 * devicePixelRatio}px ui-sans-serif`;
      ctx.fillText(a.name, s.x + 10 * devicePixelRatio, s.y - 8 * devicePixelRatio);
      ctx.restore();

      pickBuffer.push({ type: "airport", id: a.airportId, x: s.x, y: s.y, r: 18 * devicePixelRatio });
    }
  }

  function drawTracks(ctx, cam, viewport) {
    if (!state.layers.tracks) return;

    for (const d of scene.drones) {
      if (d.track.length < 2) continue;
      const r = scene.routes.find((x) => x.routeId === d.routeId);
      if (!r) continue;

      const pts = d.track
        .map((p) => pointOnPolyline(r.points, p.t01).p)
        .map((p) => project(p, cam, viewport))
        .filter(Boolean);
      if (pts.length < 2) continue;

      ctx.save();
      ctx.strokeStyle = "rgba(43,209,255,0.22)";
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawDrones(ctx, cam, viewport) {
    if (!state.layers.drones) return;

    for (const d of scene.drones) {
      const r = scene.routes.find((x) => x.routeId === d.routeId);
      if (!r) continue;
      const t = pointOnPolyline(r.points, d.t01);
      const p = t.p;
      const s = project(p, cam, viewport);
      if (!s) continue;

      // body
      const isExec = d.status === "executing";
      const bodyColor = isExec ? "rgba(43,209,255,0.95)" : "rgba(120,170,255,0.9)";
      ctx.save();
      ctx.fillStyle = bodyColor;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();

      // heading arrow
      const dir = vec(Math.sin(t.headingRad), 0, Math.cos(t.headingRad));
      const noseWorld = add(p, mul(dir, 60));
      const nose = project(noseWorld, cam, viewport);
      if (nose) {
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 2 * devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(nose.x, nose.y);
        ctx.stroke();
      }

      // label
      ctx.fillStyle = "rgba(255,255,255,0.86)";
      ctx.font = `${12 * devicePixelRatio}px ui-sans-serif`;
      const tag = `${d.name}  电量${Math.round(d.battery * 100)}%`;
      ctx.fillText(tag, s.x + 10 * devicePixelRatio, s.y + 18 * devicePixelRatio);

      // red pulse when critical alert
      const hasCritical = getActiveAlerts().some(
        (a) => !isAlertAcked(a) && a.bind.droneId === d.droneId && a.severity === "critical",
      );
      if (hasCritical) {
        const pulse = (Math.sin(nowMs() / 180) + 1) / 2;
        ctx.strokeStyle = `rgba(255,59,59,${0.35 + 0.35 * pulse})`;
        ctx.lineWidth = 3 * devicePixelRatio;
        ctx.beginPath();
        ctx.arc(s.x, s.y, (14 + 10 * pulse) * devicePixelRatio, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();

      pickBuffer.push({ type: "drone", id: d.droneId, x: s.x, y: s.y, r: 18 * devicePixelRatio });
    }
  }

  function drawAlertsOnMap(ctx, cam, viewport) {
    // small markers for unacked alerts
    const items = getActiveAlerts().filter((a) => !isAlertAcked(a)).slice(0, 18);
    for (const a of items) {
      const droneId = a.bind?.droneId;
      const d = droneId ? scene.drones.find((x) => x.droneId === droneId) : null;
      if (!d) continue;
      const r = scene.routes.find((x) => x.routeId === d.routeId);
      if (!r) continue;
      const t = pointOnPolyline(r.points, d.t01);
      const s = project(t.p, cam, viewport);
      if (!s) continue;

      const color = a.severity === "critical" ? "rgba(255,59,59,0.95)" : a.severity === "warn" ? "rgba(255,159,26,0.95)" : "rgba(255,210,74,0.95)";
      const pulse = (Math.sin(nowMs() / 220) + 1) / 2;
      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(s.x, s.y - 22 * devicePixelRatio, 5 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35 + 0.35 * pulse;
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath();
      ctx.arc(s.x, s.y - 22 * devicePixelRatio, (10 + 8 * pulse) * devicePixelRatio, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function renderMap() {
    const canvas = ui.mapCanvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const viewport = { width: canvas.width, height: canvas.height };
    const cam = state.map.camera;

    pickBuffer = [];

    drawGround(ctx, cam, viewport);
    drawHighway(ctx, cam, viewport);
    drawNoFly(ctx, cam, viewport);
    drawRoutes(ctx, cam, viewport);
    drawTracks(ctx, cam, viewport);
    drawAirports(ctx, cam, viewport);
    drawDrones(ctx, cam, viewport);
    drawAlertsOnMap(ctx, cam, viewport);

    // tiny watermark
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.font = `${12 * devicePixelRatio}px ui-monospace`;
    ctx.fillText("DEMO / OVERVIEW", 12 * devicePixelRatio, viewport.height - 14 * devicePixelRatio);
    ctx.restore();
  }

  function renderCockpit(simTimeMs) {
    if (!state.cockpit.enabled) return;

    const canvas = ui.cockpitCanvas;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(rect.height * devicePixelRatio));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width,
      h = canvas.height;

    const d = scene.drones.find((x) => x.droneId === "d-01") ?? scene.drones[0];
    const r = scene.routes.find((x) => x.routeId === d.routeId) ?? scene.routes[0];
    const t = pointOnPolyline(r.points, d.t01);

    // Background
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "rgba(30,80,150,0.9)");
    sky.addColorStop(0.55, "rgba(12,25,44,0.95)");
    sky.addColorStop(1, "rgba(6,12,22,1)");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // FPV-ish view
    const heading = t.headingRad;
    const cam = {
      center: t.p,
      yawRad: heading,
      pitchRad: deg2rad(12),
      dist: 420,
      fov: deg2rad(70),
    };

    // horizon line
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.55);
    ctx.lineTo(w, h * 0.55);
    ctx.stroke();

    // Draw a chunk of highway ahead
    ctx.save();
    ctx.globalAlpha = 0.95;

    const startT = d.t01;
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const ti = (startT + i * 0.025) % 1;
      const pi = pointOnPolyline(r.points, ti).p;
      pts.push(pi);
    }

    const pr = pts.map((p) => project(p, cam, { width: w, height: h })).filter(Boolean);
    if (pr.length > 2) {
      ctx.strokeStyle = "rgba(43,209,255,0.25)";
      ctx.lineWidth = 10 * devicePixelRatio;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pr[0].x, pr[0].y);
      for (let i = 1; i < pr.length; i++) ctx.lineTo(pr[i].x, pr[i].y);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.setLineDash([8 * devicePixelRatio, 8 * devicePixelRatio]);
      ctx.beginPath();
      ctx.moveTo(pr[0].x, pr[0].y);
      for (let i = 1; i < pr.length; i++) ctx.lineTo(pr[i].x, pr[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // HUD values
    ui.hudTitle.textContent = `${d.name}（${d.status}）`;
    ui.hudSub.textContent = `航线：${r.name} | 时间：${shortTime(simTimeMs)}`;

    const b = Math.round(d.battery * 100);
    ui.hudBattery.style.width = `${clamp(b, 0, 100)}%`;
    ui.hudBattery.style.background = b <= 15 ? "rgba(255,59,59,0.95)" : b <= 25 ? "rgba(255,159,26,0.95)" : "rgba(41,227,155,0.95)";

    const lq = Math.round(d.linkQuality * 100);
    ui.hudLink.style.width = `${clamp(lq, 0, 100)}%`;

    ui.hudSpeed.textContent = `${formatNum(d.speedMS, 1)} m/s`;
    ui.hudAlt.textContent = `${formatNum(t.p.y, 0)} m`;
    ui.hudHeading.textContent = `${Math.round((rad2deg(heading) + 360) % 360)}°`;
    ui.hudWp.textContent = `${Math.floor(d.t01 * r.points.length)}/${r.points.length}`;
    const eta = Math.round(((1 - d.t01) * (polylineLength(r.points) / Math.max(1, d.speedMS))) / 60);
    ui.hudEta.textContent = `${eta} min`;

    // Strong warning
    const critical = getActiveAlerts().find((a) => !isAlertAcked(a) && a.bind.droneId === d.droneId && a.severity === "critical");
    if (critical) {
      ui.hudWarning.textContent = `${critical.alertType}：${critical.message}`;
      ui.hudWarning.classList.remove("hud__warning--hidden");
    } else {
      ui.hudWarning.classList.add("hud__warning--hidden");
    }
  }

  function updateHeaderKpis() {
    const k = computeKpis(scene);
    ui.kpiAirportsOnline.textContent = String(k.airportsOnline);
    ui.kpiDronesAvailable.textContent = String(k.dronesAvailable);
    ui.kpiDronesExecuting.textContent = String(k.dronesExecuting);
    ui.kpiAlertsOpen.textContent = String(k.openAlerts);

    ui.alertCriticalCount.textContent = String(k.critical);
    ui.alertWarnCount.textContent = String(k.warn);
    ui.alertInfoCount.textContent = String(k.info);
  }

  function bindUi() {
    ui.modeRealtimeBtn.addEventListener("click", () => setMode("realtime"));
    ui.modeReplayBtn.addEventListener("click", () => setMode("replay"));

    ui.viewModeSelect.addEventListener("change", () => setViewMode(ui.viewModeSelect.value));

    ui.routeStyleSelect.addEventListener("change", () => {
      state.routeStyle = ui.routeStyleSelect.value;
    });

    ui.focusPolicySelect.addEventListener("change", () => {
      state.focusPolicy = ui.focusPolicySelect.value;
    });

    ui.layerAirports.addEventListener("change", () => (state.layers.airports = ui.layerAirports.checked));
    ui.layerDrones.addEventListener("change", () => (state.layers.drones = ui.layerDrones.checked));
    ui.layerRoutes.addEventListener("change", () => (state.layers.routes = ui.layerRoutes.checked));
    ui.layerTracks.addEventListener("change", () => (state.layers.tracks = ui.layerTracks.checked));
    ui.layerNoFly.addEventListener("change", () => (state.layers.noFly = ui.layerNoFly.checked));

    ui.routeSelect.addEventListener("change", () => {
      selectObject("route", ui.routeSelect.value);
      // 演示：切换“执行航线”（实时下让无人机-01改飞该航线）
      if (state.timeMode === "realtime") {
        const d = scene.drones.find((x) => x.droneId === "d-01");
        if (d) {
          d.routeId = ui.routeSelect.value;
          d.status = "executing";
          d.dir = 1;
          d.t01 = 0.02;
          d.speedMS = Math.max(d.speedMS, 10);
          d.track = [];
        }
      }
    });

    ui.tabAlerts.addEventListener("click", () => setActiveFeed("alerts"));
    ui.tabTasks.addEventListener("click", () => setActiveFeed("tasks"));
    ui.tabAssets.addEventListener("click", () => setActiveFeed("assets"));

    ui.playBtn.addEventListener("click", () => {
      state.playing = true;
      ui.playBtn.disabled = true;
      ui.pauseBtn.disabled = false;
    });

    ui.pauseBtn.addEventListener("click", () => {
      state.playing = false;
      ui.playBtn.disabled = false;
      ui.pauseBtn.disabled = true;
    });

    ui.speedSelect.addEventListener("change", () => {
      state.speed = Number(ui.speedSelect.value);
    });

    ui.timeSlider.addEventListener("input", () => {
      if (state.timeMode !== "replay") return;
      state.replayCursorSec = Number(ui.timeSlider.value);
      ui.timeText.textContent = `回放：${state.replayCursorSec}s`;
    });

    ui.btnSnapshot.addEventListener("click", snapshot);
    ui.btnResetView.addEventListener("click", resetView);

    ui.btnLocateDrone.addEventListener("click", () => {
      const d = scene.drones.find((x) => x.droneId === "d-01") ?? scene.drones[0];
      selectObject("drone", d.droneId);
      focusOnDrone(d.droneId);
    });

    ui.btnLocateAirport.addEventListener("click", () => {
      const a = scene.airports.find((x) => x.airportId === "a-01") ?? scene.airports[0];
      selectObject("airport", a.airportId);
      focusOnAirport(a.airportId);
    });

    ui.btnToggleLive.addEventListener("click", openLive);
    ui.btnEnterCockpit.addEventListener("click", openCockpit);

    ui.closeLive.addEventListener("click", closeLive);
    ui.liveLayout2.addEventListener("click", () => {
      state.live.layout = 2;
      renderLive();
    });
    ui.liveLayout4.addEventListener("click", () => {
      state.live.layout = 4;
      renderLive();
    });
    ui.liveLayout6.addEventListener("click", () => {
      state.live.layout = 6;
      renderLive();
    });

    ui.closeCockpit.addEventListener("click", closeCockpit);
    ui.cockpitSwitchView.addEventListener("click", () => {
      state.cockpit.view = state.cockpit.view === "fpv" ? "chase" : "fpv";
      // (演示) 当前仅FPV渲染，chase视角用HUD+地图跟随体现。
    });

    ui.searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = ui.searchInput.value.trim();
      if (!q) return;
      const a = scene.airports.find((x) => x.name.includes(q) || x.airportId === q);
      const d = scene.drones.find((x) => x.name.includes(q) || x.droneId === q);
      const r = scene.routes.find((x) => x.name.includes(q) || x.routeId === q);
      if (d) {
        selectObject("drone", d.droneId);
        focusOnDrone(d.droneId);
        return;
      }
      if (a) {
        selectObject("airport", a.airportId);
        focusOnAirport(a.airportId);
        return;
      }
      if (r) {
        selectObject("route", r.routeId);
        focusOnRoute(r.routeId);
      }
    });
  }

  let lastFrameMs = nowMs();

  function loop() {
    const tMs = nowMs();
    const dtSec = Math.min(0.06, (tMs - lastFrameMs) / 1000);
    lastFrameMs = tMs;

    let simTimeMs = tMs;

    if (state.timeMode === "realtime") {
      // In realtime: always on
      state.playing = true;
      ui.playBtn.disabled = false;
      ui.pauseBtn.disabled = true;
      ui.timeText.textContent = `实时：${shortTime(tMs)}`;
      ui.timeSlider.value = String(state.replaySeconds);
    } else {
      // In replay: driven by slider / playhead
      if (state.playing) {
        state.replayCursorSec = clamp(state.replayCursorSec + dtSec * state.speed, 0, state.replaySeconds);
        ui.timeSlider.value = String(state.replayCursorSec);
      }
      ui.timeText.textContent = `回放：${Math.round(state.replayCursorSec)}s`;

      // Sim time = scenarioStart + cursor
      simTimeMs = state.scenarioStartMs + state.replayCursorSec * 1000;
    }

    applyFollow();
    if (state.timeMode === "realtime") updateSimulation(dtSec * state.speed, simTimeMs);
    else updateReplay(simTimeMs);
    updateHeaderKpis();
    renderMap();
    tickLive();
    renderCockpit(simTimeMs);

    requestAnimationFrame(loop);
  }

  function bootstrap() {
    initSelectors();
    bindUi();
    attachMapEvents();
    buildLiveTiles();

    // initial selection
    selectObject("drone", "d-01");
    renderFeed();

    // seed alerts
    const d = scene.drones.find((x) => x.droneId === "d-01");
    const r = scene.routes.find((x) => x.routeId === d.routeId);
    const tt = pointOnPolyline(r.points, d.t01);
    genAlert(scene, d, "DEVIATION", "航迹轻微偏离走廊（演示），建议回到航线。", { type: "point", coords: [tt.p.x, tt.p.y, tt.p.z] });

    setMode("realtime");
    setViewMode("free");

    requestAnimationFrame(loop);
  }

  bootstrap();
})();
