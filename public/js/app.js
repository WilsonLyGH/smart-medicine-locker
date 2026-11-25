/**
 * Smart Medicine Locker — Clinical Light DCS SCADA Web HMI (V2)
 * Implements @HARDWARE_SPEC.md + @DESIGN_SPEC.md + @UPGRADE_SPEC_V2.md
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getDatabase,
  ref as fbRef,
  get as fbGet,
  onValue as fbOnValue,
  set as fbSet,
  update as fbUpdate,
  push as fbPush,
  remove as fbRemove
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

// ============================================================================
// Startup Mode Detection: Production Firebase vs Client-Side Interactive Demo
// ============================================================================
const urlParams = new URLSearchParams(window.location.search);
const forceDemoParam = urlParams.get("demo") === "true" || urlParams.get("demo") === "1";
const rawFirebaseConfig =
  typeof window !== "undefined" && window.FIREBASE_CONFIG && typeof window.FIREBASE_CONFIG === "object"
    ? window.FIREBASE_CONFIG
    : null;

const hasRealFirebaseConfig = Boolean(
  rawFirebaseConfig &&
    rawFirebaseConfig.apiKey &&
    !String(rawFirebaseConfig.apiKey).startsWith("YOUR_") &&
    !String(rawFirebaseConfig.apiKey).startsWith("REPLACE_") &&
    rawFirebaseConfig.databaseURL &&
    !String(rawFirebaseConfig.databaseURL).includes("YOUR_")
);

const isDemoMode = forceDemoParam || !hasRealFirebaseConfig;
const isFirebaseConfigured = !isDemoMode && hasRealFirebaseConfig;
const firebaseApp = isFirebaseConfigured ? initializeApp(rawFirebaseConfig) : null;
const auth = isFirebaseConfigured ? getAuth(firebaseApp) : null;
const db = isFirebaseConfigured ? getDatabase(firebaseApp) : null;

const STORAGE_AUTH_KEY = "scada_local_session";
const LEGACY_AUTH_KEYS = ["scada_auth_user_v2", "scada_auth_user"];
const STORAGE_INTERLOCK_KEY = "scada_pending_inventory_interlock_v2";
const HEARTBEAT_TIMEOUT_MS = 10000;
const DOOR_OPEN_ALARM_MS = 30000;
const FAN_FAULT_DELAY_MS = 5000;
const INTERLOCK_WARN_SECONDS = 15;
const UNLOCK_ARMED_TIMEOUT_MS = 15000;
const HISTORY_INTERVAL_MS = 300000; // 5 minutes
const MAX_HISTORY_SAMPLES = 288;    // 24 hours at 5-min interval
const MAX_PID_CHART_POINTS = 30;
const DEMO_PLANT_TICK_MS = 1500;    // 1.5s virtual plant engine step in Demo Mode
const LOCKER_IDS = ["locker_1", "locker_2", "locker_3"];
const RING_CIRC = 163.36;
const DIAL_CIRC = 226.19;

const DEFAULT_SPEC_DATA = {
  system: {
    emergency_stop: false,
    global_alarm: false,
    telegram: { enabled: false, bot_token: "", chat_id: "", cooldown_sec: 60 }
  },
  auth: { enroll_until: 0, rfid_scan: { uid: "", timestamp: 0, processed: true } },
  users: {
    DEMO_ADMIN_01: {
      name: "System Admin",
      role: "admin",
      username: "admin",
      password: "demo-admin-password",
      active: true,
      allowed_lockers: { locker_1: true, locker_2: true, locker_3: true }
    },
    DEMO_OP_01: {
      name: "Pharmacy Operator",
      role: "operator",
      username: "operator",
      password: "demo-operator-password",
      active: true,
      allowed_lockers: { locker_1: true, locker_2: true, locker_3: false }
    },
    DEMO_MON_01: {
      name: "Public Monitor",
      role: "monitoring",
      username: "public",
      password: "demo-monitor-password",
      active: true,
      allowed_lockers: { locker_1: false, locker_2: false, locker_3: false }
    }
  },
  medicine_catalog: {
    med_general: { name: "General Medicine", category: "Standard Room", default_setpoint_temp: 25.0, max_temp_alarm: 28.0, max_hum_alarm: 70.0, min_stock_alarm: 5 },
    med_antibiotic: { name: "Antibiotic Capsules", category: "Cool Dry", default_setpoint_temp: 22.0, max_temp_alarm: 25.0, max_hum_alarm: 60.0, min_stock_alarm: 10 },
    med_syrup: { name: "Syrup & Solution", category: "Controlled Room", default_setpoint_temp: 23.0, max_temp_alarm: 26.0, max_hum_alarm: 65.0, min_stock_alarm: 5 },
    med_heat_sensitive: { name: "Heat-Sensitive Meds", category: "Cool Storage", default_setpoint_temp: 18.0, max_temp_alarm: 21.0, max_hum_alarm: 60.0, min_stock_alarm: 5 }
  },
  lockers: {
    locker_1: {
      meta: { name: "Locker 01", esp_id: "esp_1", status: "online", heartbeat: Math.floor(Date.now() / 1000), medicine_id: "med_general", medicine_name: "General Medicine", stock: 20, batch_no: "BCH-2026-01", expiry_date: "2027-06-30" },
      sensor: { temp: 25.4, humidity: 58.0, door_open: false, fan_rpm: 1200 },
      control: { unlock_cmd: false, mode: "AUTO", manual_pwm: 0 },
      pid: { setpoint: 25.0, kp: 12.0, ki: 0.5, kd: 2.0, output_pwm: 35 },
      alarm: { over_temp: false, high_hum: false, door_left_open: false, low_stock: false, fan_fault: false, forced_entry: false, expired_med: false, acknowledged: true }
    },
    locker_2: {
      meta: { name: "Locker 02", esp_id: "esp_2", status: "online", heartbeat: Math.floor(Date.now() / 1000), medicine_id: "med_general", medicine_name: "General Medicine", stock: 15, batch_no: "BCH-2026-02", expiry_date: "2027-03-15" },
      sensor: { temp: 24.8, humidity: 56.5, door_open: false, fan_rpm: 950 },
      control: { unlock_cmd: false, mode: "AUTO", manual_pwm: 0 },
      pid: { setpoint: 25.0, kp: 12.0, ki: 0.5, kd: 2.0, output_pwm: 20 },
      alarm: { over_temp: false, high_hum: false, door_left_open: false, low_stock: false, fan_fault: false, forced_entry: false, expired_med: false, acknowledged: true }
    },
    locker_3: {
      meta: { name: "Locker 03", esp_id: "esp_3", status: "online", heartbeat: Math.floor(Date.now() / 1000), medicine_id: "med_general", medicine_name: "General Medicine", stock: 10, batch_no: "BCH-2026-03", expiry_date: "2026-12-10" },
      sensor: { temp: 26.1, humidity: 61.0, door_open: false, fan_rpm: 1650 },
      control: { unlock_cmd: false, mode: "AUTO", manual_pwm: 0 },
      pid: { setpoint: 25.0, kp: 12.0, ki: 0.5, kd: 2.0, output_pwm: 55 },
      alarm: { over_temp: false, high_hum: false, door_left_open: false, low_stock: false, fan_fault: false, forced_entry: false, expired_med: false, acknowledged: true }
    }
  }
};

const state = {
  connected: false,
  currentUser: null,
  currentView: "login",
  authEnrollUntil: 0,
  selectedPidLocker: "locker_1",
  selectedReportLocker: "locker_1",
  highlightedLocker: null,
  pidFormDirtyLocker: null,
  lastRenderedPid: { lockerId: null, setpoint: null, kp: null, ki: null, kd: null },
  fanPendingEdit: { locker_1: false, locker_2: false, locker_3: false },
  fanDraft: {
    locker_1: { mode: "AUTO", pwm: 0 },
    locker_2: { mode: "AUTO", pwm: 0 },
    locker_3: { mode: "AUTO", pwm: 0 }
  },
  tgFormHydrated: false,
  heartbeatSimEnabled: false,
  system: {
    emergency_stop: false,
    global_alarm: false,
    telegram: { enabled: false, bot_token: "", chat_id: "", cooldown_sec: 60 }
  },
  users: isDemoMode ? structuredClone(DEFAULT_SPEC_DATA.users) : {},
  medicineCatalog: structuredClone(DEFAULT_SPEC_DATA.medicine_catalog),
  lockers: {
    locker_1: structuredClone(DEFAULT_SPEC_DATA.lockers.locker_1),
    locker_2: structuredClone(DEFAULT_SPEC_DATA.lockers.locker_2),
    locker_3: structuredClone(DEFAULT_SPEC_DATA.lockers.locker_3)
  },
  runtime: {
    locker_1: { lastHbVal: null, lastHbTime: 0, prevDoorOpen: null, doorOpenedAt: null, doorClosedAt: 0, authorizedOpenSession: false, forcedEntryTimer: null, fanZeroSince: null, lastAuthorizedUnlockAt: 0 },
    locker_2: { lastHbVal: null, lastHbTime: 0, prevDoorOpen: null, doorOpenedAt: null, doorClosedAt: 0, authorizedOpenSession: false, forcedEntryTimer: null, fanZeroSince: null, lastAuthorizedUnlockAt: 0 },
    locker_3: { lastHbVal: null, lastHbTime: 0, prevDoorOpen: null, doorOpenedAt: null, doorClosedAt: 0, authorizedOpenSession: false, forcedEntryTimer: null, fanZeroSince: null, lastAuthorizedUnlockAt: 0 }
  },
  awaitingDoorOpen: { locker_1: false, locker_2: false, locker_3: false },
  awaitingDoorTimers: { locker_1: null, locker_2: null, locker_3: null },
  pidSeries: {
    locker_1: { labels: [], sp: [], pv: [], mv: [] },
    locker_2: { labels: [], sp: [], pv: [], mv: [] },
    locker_3: { labels: [], sp: [], pv: [], mv: [] }
  },
  history: { locker_1: {}, locker_2: {}, locker_3: {} },
  telegramLastSent: {},
  transactions: [],
  alarmLogs: [],
  txFilterLocker: "ALL",
  interlock: { active: false, lockerId: null, idleSecondsLeft: INTERLOCK_WARN_SECONDS, timerId: null }
};

const el = {
  appChrome: document.getElementById("app-chrome"),
  estopBanner: document.getElementById("estop-banner"),
  estopBannerReleaseBtn: document.getElementById("estop-banner-release-btn"),
  globalToast: document.getElementById("global-toast"),
  rtdbConnPill: document.getElementById("rtdb-conn-pill"),
  rtdbLed: document.getElementById("rtdb-conn-led"),
  rtdbText: document.getElementById("rtdb-conn-text"),
  clock: document.getElementById("hmi-clock"),
  loginFooterClock: document.getElementById("login-footer-clock"),
  btnToggleHbSim: document.getElementById("btn-toggle-hb-sim"),

  navBtnDashboard: document.getElementById("nav-btn-dashboard"),
  navBtnReports: document.getElementById("nav-btn-reports"),
  navBtnAdmin: document.getElementById("nav-btn-admin"),
  navBtnCatalog: document.getElementById("nav-btn-catalog"),
  navBtnSimulator: document.getElementById("nav-btn-simulator"),
  headerAlarmPill: document.getElementById("header-alarm-pill"),
  headerAlarmLed: document.getElementById("header-alarm-led"),
  headerAlarmText: document.getElementById("header-alarm-text"),
  headerUserName: document.getElementById("header-user-name"),
  headerUserUid: document.getElementById("header-user-uid"),
  headerUserRole: document.getElementById("header-user-role"),
  btnLogout: document.getElementById("btn-logout"),
  btnEstop: document.getElementById("btn-estop"),
  btnEstopLabel: document.getElementById("btn-estop-label"),

  viewLogin: document.getElementById("view-login"),
  viewDashboard: document.getElementById("view-dashboard"),
  viewReports: document.getElementById("view-reports"),
  viewAdmin: document.getElementById("view-admin"),
  viewSimulator: document.getElementById("view-simulator"),
  btnSimBackDashboard: document.getElementById("btn-sim-back-dashboard"),

  loginRtdbPill: document.getElementById("login-rtdb-pill"),
  loginRtdbLed: document.getElementById("login-rtdb-led"),
  loginRtdbText: document.getElementById("login-rtdb-text"),
  panelLoginManual: document.getElementById("panel-login-manual"),
  loginAlert: document.getElementById("login-alert"),
  loginLastRfid: document.getElementById("login-last-rfid"),
  loginUsername: document.getElementById("login-username"),
  loginPassword: document.getElementById("login-password"),
  demoLoginBox: document.getElementById("demo-login-box"),
  btnDemoLoginAdmin: document.getElementById("btn-demo-login-admin"),
  btnDemoLoginOperator: document.getElementById("btn-demo-login-operator"),

  kpiOnlineCount: document.getElementById("kpi-online-count"),
  kpiOnlineLabel: document.getElementById("kpi-online-label"),
  kpiInterlockState: document.getElementById("kpi-interlock-state"),
  kpiAvgTemp: document.getElementById("kpi-avg-temp"),
  kpiAvgHum: document.getElementById("kpi-avg-hum"),
  kpiAvgFan: document.getElementById("kpi-avg-fan"),
  kpiAvgRpm: document.getElementById("kpi-avg-rpm"),
  kpiPidSummary: document.getElementById("kpi-pid-summary"),
  kpiTotalStock: document.getElementById("kpi-total-stock"),
  kpiDoorsStatus: document.getElementById("kpi-doors-status"),
  kpiActiveAlarms: document.getElementById("kpi-active-alarms"),
  kpiUnackLabel: document.getElementById("kpi-unack-label"),
  btnKpiAckAll: document.getElementById("btn-kpi-ack-all"),
  ringAvgTemp: document.getElementById("ring-avg-temp"),
  ringAvgHum: document.getElementById("ring-avg-hum"),
  ringAvgFan: document.getElementById("ring-avg-fan"),
  ringInterlock: document.getElementById("ring-interlock"),
  ringInterlockText: document.getElementById("ring-interlock-text"),
  lockersGrid: document.getElementById("lockers-grid"),

  panelAlarmLed: document.getElementById("panel-alarm-led"),
  btnAckAllAlarms: document.getElementById("btn-ack-all-alarms"),
  btnExportAlarms: document.getElementById("btn-export-alarms"),
  activeAlarmsStrip: document.getElementById("active-alarms-strip"),
  alarmLogBody: document.getElementById("alarm-log-body"),
  txLogCount: document.getElementById("tx-log-count"),
  txFilterLocker: document.getElementById("tx-filter-locker"),
  btnExportTx: document.getElementById("btn-export-tx"),
  txLogBody: document.getElementById("tx-log-body"),

  // Reports View
  reportPrintMeta: document.getElementById("report-print-meta"),
  btnLogSnapshotNow: document.getElementById("btn-log-snapshot-now"),
  btnExportReportCsv: document.getElementById("btn-export-report-csv"),
  btnExportReportXlsx: document.getElementById("btn-export-report-xlsx"),
  btnPrintReport: document.getElementById("btn-print-report"),
  reportLastLogged: document.getElementById("report-last-logged"),
  reportSummaryBody: document.getElementById("report-summary-body"),
  reportHistoryCanvas: document.getElementById("reportHistoryChart"),
  reportSampleBadge: document.getElementById("report-sample-badge"),
  reportHistoryBody: document.getElementById("report-history-body"),

  // Admin — PID Metrics & Tuning
  btnBackDashboard: document.getElementById("btn-back-dashboard"),
  pidMetricEss: document.getElementById("pid-metric-ess"),
  pidMetricOvershoot: document.getElementById("pid-metric-overshoot"),
  pidMetricPwm: document.getElementById("pid-metric-pwm"),
  pidLiveSp: document.getElementById("pid-live-sp"),
  pidLivePv: document.getElementById("pid-live-pv"),
  pidLiveErr: document.getElementById("pid-live-err"),
  pidLivePwm: document.getElementById("pid-live-pwm"),
  pidLiveRpm: document.getElementById("pid-live-rpm"),
  pidChartCanvas: document.getElementById("pidResponseChart"),
  pidTargetPath: document.getElementById("pid-target-path"),
  pidSelectedBadge: document.getElementById("pid-selected-badge"),
  formPidTuning: document.getElementById("form-pid-tuning"),
  inputPidSp: document.getElementById("input-pid-sp"),
  inputPidKp: document.getElementById("input-pid-kp"),
  inputPidKi: document.getElementById("input-pid-ki"),
  inputPidKd: document.getElementById("input-pid-kd"),
  btnPidModeAuto: document.getElementById("btn-pid-mode-auto"),
  btnPidModeManual: document.getElementById("btn-pid-mode-manual"),
  sliderManualPwm: document.getElementById("slider-manual-pwm"),
  labelManualPwm: document.getElementById("label-manual-pwm"),
  btnApplyManualPwm: document.getElementById("btn-apply-manual-pwm"),

  // Admin — Catalog & Assign Locker (Batch & Expiry)
  sectionMedicineCatalog: document.getElementById("section-medicine-catalog"),
  formAssignMedicine: document.getElementById("form-assign-medicine"),
  assignLockerId: document.getElementById("assign-locker-id"),
  assignMedicineId: document.getElementById("assign-medicine-id"),
  assignBatchNo: document.getElementById("assign-batch-no"),
  assignExpiryDate: document.getElementById("assign-expiry-date"),
  assignAutoSetpoint: document.getElementById("assign-auto-setpoint"),
  assignSyncSpLabel: document.getElementById("assign-sync-sp-label"),
  catalogTableScroll: document.getElementById("catalog-table-scroll"),
  catalogTableBody: document.getElementById("catalog-table-body"),
  formAddMedicine: document.getElementById("form-add-medicine"),
  medNewName: document.getElementById("med-new-name"),
  medNewCat: document.getElementById("med-new-cat"),
  medNewSp: document.getElementById("med-new-sp"),
  medNewMaxT: document.getElementById("med-new-max-t"),
  medNewMaxH: document.getElementById("med-new-max-h"),
  medNewMinS: document.getElementById("med-new-min-s"),

  // Admin — Users (RBAC & RFID Scan-to-Fill)
  usersTableBody: document.getElementById("users-table-body"),
  formAddUser: document.getElementById("form-add-user"),
  userNewUid: document.getElementById("user-new-uid"),
  btnScanUserUid: document.getElementById("btn-scan-user-uid"),
  scanUserUidDot: document.getElementById("scan-user-uid-dot"),
  scanUserUidLabel: document.getElementById("scan-user-uid-label"),
  userScanStatus: document.getElementById("user-scan-status"),
  userNewName: document.getElementById("user-new-name"),
  userNewUsername: document.getElementById("user-new-username"),
  userNewPassword: document.getElementById("user-new-password"),
  userNewRole: document.getElementById("user-new-role"),
  userNewL1: document.getElementById("user-new-l1"),
  userNewL2: document.getElementById("user-new-l2"),
  userNewL3: document.getElementById("user-new-l3"),

  // Admin — Telegram Alerts
  formTelegramConfig: document.getElementById("form-telegram-config"),
  tgEnabled: document.getElementById("tg-enabled"),
  tgBotToken: document.getElementById("tg-bot-token"),
  tgChatId: document.getElementById("tg-chat-id"),
  tgCooldown: document.getElementById("tg-cooldown"),
  btnTgSendTest: document.getElementById("btn-tg-send-test"),

  // Admin — Simulator
  simLockerId: document.getElementById("sim-locker-id"),
  btnSimOpenDoor: document.getElementById("btn-sim-open-door"),
  btnSimCloseDoor: document.getElementById("btn-sim-close-door"),
  btnSimOvertemp: document.getElementById("btn-sim-overtemp"),
  btnSimNormalTemp: document.getElementById("btn-sim-normal-temp"),
  btnSimFanFault: document.getElementById("btn-sim-fan-fault"),
  btnSimForcedEntry: document.getElementById("btn-sim-forced-entry"),
  btnSimExpired: document.getElementById("btn-sim-expired"),
  btnSimClearFaults: document.getElementById("btn-sim-clear-faults"),
  simInputTemp: document.getElementById("sim-input-temp"),
  simInputHum: document.getElementById("sim-input-hum"),
  btnSimSendDht: document.getElementById("btn-sim-send-dht"),
  btnSimOfflineNode: document.getElementById("btn-sim-offline-node"),
  btnSimOnlineNode: document.getElementById("btn-sim-online-node"),
  btnResetRtdbSpec: document.getElementById("btn-reset-rtdb-spec"),

  // Inventory Modal
  inventoryModal: document.getElementById("inventory-modal"),
  invIgnoredBanner: document.getElementById("inv-ignored-banner"),
  invIdleTimer: document.getElementById("inv-idle-timer"),
  formInventoryInterlock: document.getElementById("form-inventory-interlock"),
  invLockerName: document.getElementById("inv-locker-name"),
  invBatchExp: document.getElementById("inv-batch-exp"),
  invMedicineName: document.getElementById("inv-medicine-name"),
  invCurrentStock: document.getElementById("inv-current-stock"),
  invExpiredNotice: document.getElementById("inv-expired-notice"),
  invRadioWithdraw: document.getElementById("inv-radio-withdraw"),
  invRadioRestock: document.getElementById("inv-radio-restock"),
  invRadioInspect: document.getElementById("inv-radio-inspect"),
  invQuantity: document.getElementById("inv-quantity"),
  invStockPreview: document.getElementById("inv-stock-preview"),
  invNotes: document.getElementById("inv-notes"),
  invErrorMsg: document.getElementById("inv-error-msg"),

  // E-Stop Modal
  estopModal: document.getElementById("estop-modal"),
  estopModalTitle: document.getElementById("estop-modal-title"),
  estopModalDesc: document.getElementById("estop-modal-desc"),
  estopModalCancel: document.getElementById("estop-modal-cancel"),
  estopModalConfirm: document.getElementById("estop-modal-confirm")
};

// ============================================================================
// In-Memory RTDB Adapter & Virtual Plant Engine (For GitHub Pages Demo Mode)
// ============================================================================
const demoTree = structuredClone(DEFAULT_SPEC_DATA);
demoTree.history = { locker_1: {}, locker_2: {}, locker_3: {} };
demoTree.logs = { transactions: {}, alarms: {}, role_changes: {} };
const demoListeners = [];
const demoForcedOffline = { locker_1: false, locker_2: false, locker_3: false };
const demoPidState = {
  locker_1: { integral: 1.5, prevErr: 0.4 },
  locker_2: { integral: 0.8, prevErr: 0.1 },
  locker_3: { integral: 2.2, prevErr: 0.9 }
};

function normalizeRtdbPath(path) {
  return String(path || "").replace(/^\/+|\/+$/g, "");
}

function demoGetAtPath(path) {
  const clean = normalizeRtdbPath(path);
  if (clean === ".info/connected") return true;
  if (!clean) return demoTree;
  const parts = clean.split("/");
  let cur = demoTree;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

function demoSetRawAtPath(path, value) {
  const clean = normalizeRtdbPath(path);
  if (!clean) {
    if (value && typeof value === "object") {
      Object.keys(demoTree).forEach((k) => delete demoTree[k]);
      Object.assign(demoTree, structuredClone(value));
    }
    return;
  }
  const parts = clean.split("/");
  let cur = demoTree;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") {
      cur[p] = {};
    }
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) {
    delete cur[last];
  } else {
    cur[last] = structuredClone(value);
  }

  // Track explicit offline/online simulator overrides in Demo Mode
  const statusMatch = clean.match(/^lockers\/(locker_[123])\/meta\/status$/);
  if (statusMatch) {
    demoForcedOffline[statusMatch[1]] = String(value || "").toLowerCase() === "offline";
  }

  // Simulate physical door opening 1.5s after Unlock command in Demo Mode
  const unlockMatch = clean.match(/^lockers\/(locker_[123])\/control\/unlock_cmd$/);
  if (unlockMatch && value === true) {
    const targetId = unlockMatch[1];
    setTimeout(() => {
      if (!isDemoMode || demoTree.system?.emergency_stop) return;
      demoSetRawAtPath(`lockers/${targetId}/control/unlock_cmd`, false);
      demoSetRawAtPath(`lockers/${targetId}/sensor/door_open`, true);
      notifyDemoListeners(`lockers/${targetId}`);
    }, 1500);
  }
}

function notifyDemoListeners(changedPath) {
  const cleanChanged = normalizeRtdbPath(changedPath);
  demoListeners.forEach((sub) => {
    if (!sub.active) return;
    const lp = sub.path;
    if (
      !cleanChanged ||
      !lp ||
      cleanChanged === lp ||
      cleanChanged.startsWith(lp + "/") ||
      lp.startsWith(cleanChanged + "/")
    ) {
      const valSnapshot = structuredClone(demoGetAtPath(lp));
      sub.cb({ val: () => valSnapshot });
    }
  });
}

function ref(dbInstance, path = "") {
  if (isDemoMode) {
    return { __isDemoRef: true, path: normalizeRtdbPath(path) };
  }
  return path ? fbRef(dbInstance, path) : fbRef(dbInstance);
}

function onValue(refObj, callback) {
  if (isDemoMode) {
    const sub = { path: refObj.path, cb: callback, active: true };
    demoListeners.push(sub);
    const initialVal = structuredClone(demoGetAtPath(sub.path));
    callback({ val: () => initialVal });
    return () => {
      sub.active = false;
      const idx = demoListeners.indexOf(sub);
      if (idx >= 0) demoListeners.splice(idx, 1);
    };
  }
  return fbOnValue(refObj, callback);
}

async function get(refObj) {
  if (isDemoMode) {
    const val = structuredClone(demoGetAtPath(refObj.path));
    return { val: () => val, exists: () => val !== null && val !== undefined };
  }
  return fbGet(refObj);
}

async function set(refObj, value) {
  if (isDemoMode) {
    demoSetRawAtPath(refObj.path, value);
    notifyDemoListeners(refObj.path);
    return;
  }
  return fbSet(refObj, value);
}

async function update(refObj, patchObj) {
  if (isDemoMode) {
    const base = refObj.path;
    const touched = new Set();
    Object.entries(patchObj || {}).forEach(([relKey, val]) => {
      const fullPath = base ? `${base}/${normalizeRtdbPath(relKey)}` : normalizeRtdbPath(relKey);
      demoSetRawAtPath(fullPath, val);
      const rootSeg = fullPath.split("/").slice(0, 2).join("/");
      touched.add(rootSeg || fullPath);
    });
    if (base) {
      notifyDemoListeners(base);
    } else {
      touched.forEach((p) => notifyDemoListeners(p));
    }
    return;
  }
  return fbUpdate(refObj, patchObj);
}

async function push(refObj, value) {
  if (isDemoMode) {
    const key = `demo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fullPath = refObj.path ? `${refObj.path}/${key}` : key;
    demoSetRawAtPath(fullPath, value);
    notifyDemoListeners(refObj.path);
    return { key };
  }
  return fbPush(refObj, value);
}

async function remove(refObj) {
  if (isDemoMode) {
    demoSetRawAtPath(refObj.path, null);
    notifyDemoListeners(refObj.path);
    return;
  }
  return fbRemove(refObj);
}

function seedDemoModeInitialData() {
  if (!isDemoMode) return;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const profiles = {
    locker_1: { baseTemp: 25.3, baseHum: 57.8, sp: 25.0, basePwm: 34 },
    locker_2: { baseTemp: 24.8, baseHum: 56.2, sp: 25.0, basePwm: 20 },
    locker_3: { baseTemp: 25.9, baseHum: 60.4, sp: 25.0, basePwm: 52 }
  };

  // 1. Seed 24 Historical Cold-Chain Samples (5-min intervals = 2 hours)
  LOCKER_IDS.forEach((id, idx) => {
    const prof = profiles[id];
    demoTree.lockers[id].meta.heartbeat = nowSec;
    state.runtime[id].lastHbVal = nowSec;
    state.runtime[id].lastHbTime = nowMs;

    for (let i = 24; i >= 1; i--) {
      const sampleSec = nowSec - i * 300;
      const wave = Math.sin((i + idx * 3) * 0.45);
      const tVal = Number((prof.baseTemp + wave * 0.35).toFixed(1));
      const hVal = Number((prof.baseHum + Math.cos((i + idx) * 0.4) * 1.2).toFixed(1));
      const pwmVal = Math.max(0, Math.min(100, Math.round(prof.basePwm + wave * 8)));
      demoTree.history[id][String(sampleSec)] = {
        temp: tVal,
        hum: hVal,
        pwm: pwmVal,
        sp: prof.sp,
        excursion: false
      };
    }

    // 2. Seed 20 Live PID Chart Points so PID Tuning chart & metrics are ready immediately
    const series = state.pidSeries[id];
    series.labels = [];
    series.sp = [];
    series.pv = [];
    series.mv = [];
    for (let j = 20; j >= 1; j--) {
      const ptMs = nowMs - j * 1500;
      const wave = Math.sin((j + idx * 2) * 0.38);
      const pv = Number((prof.baseTemp + wave * 0.28).toFixed(1));
      const mv = Math.max(0, Math.min(100, Math.round(prof.basePwm + wave * 7)));
      series.labels.push(formatTime(ptMs));
      series.sp.push(prof.sp);
      series.pv.push(pv);
      series.mv.push(mv);
    }
  });

  // 3. Seed Realistic Audit Trail Transactions & Alarm Logs
  demoTree.logs.transactions = {
    demo_tx_1: {
      timestamp: nowMs - 3600000,
      user_uid: "DEMO_ADMIN_01",
      user_name: "System Admin",
      role: "admin",
      locker_id: "locker_1",
      locker_name: "Locker 01",
      medicine_name: "General Medicine",
      batch_no: "BCH-2026-01",
      action: "RESTOCK",
      quantity: 5,
      stock_before: 15,
      stock_after: 20,
      notes: "Morning pharmacy replenishment"
    },
    demo_tx_2: {
      timestamp: nowMs - 1800000,
      user_uid: "DEMO_OP_01",
      user_name: "Pharmacy Operator",
      role: "operator",
      locker_id: "locker_2",
      locker_name: "Locker 02",
      medicine_name: "General Medicine",
      batch_no: "BCH-2026-02",
      action: "WITHDRAW",
      quantity: 2,
      stock_before: 17,
      stock_after: 15,
      notes: "Ward B routine dispense"
    },
    demo_tx_3: {
      timestamp: nowMs - 600000,
      user_uid: "DEMO_ADMIN_01",
      user_name: "System Admin",
      role: "admin",
      locker_id: "locker_3",
      locker_name: "Locker 03",
      medicine_name: "General Medicine",
      batch_no: "BCH-2026-03",
      action: "INSPECT",
      quantity: 0,
      stock_before: 10,
      stock_after: 10,
      notes: "FEFO cold-chain batch verification"
    }
  };

  demoTree.logs.alarms = {
    demo_alm_1: {
      timestamp: nowMs - 5400000,
      locker_id: "SYSTEM",
      type: "INFO",
      message: "3-Node ESP32 DCS Cluster synchronized (Demo Simulation Engine)",
      acknowledged: true
    }
  };
}

function stepDemoVirtualPlant() {
  if (!isDemoMode) return;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const eStop = Boolean(demoTree.system?.emergency_stop);
  const dtSec = DEMO_PLANT_TICK_MS / 1000;

  LOCKER_IDS.forEach((id, idx) => {
    const locker = demoTree.lockers[id];
    if (!locker) return;

    if (!demoForcedOffline[id]) {
      locker.meta.status = "online";
      locker.meta.heartbeat = nowSec;
      state.runtime[id].lastHbVal = nowSec;
      state.runtime[id].lastHbTime = nowMs;
    }

    const sp = Number(locker.pid?.setpoint ?? 25.0);
    const kp = Number(locker.pid?.kp ?? 12.0);
    const ki = Number(locker.pid?.ki ?? 0.5);
    const kd = Number(locker.pid?.kd ?? 2.0);
    const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
    const curTemp = Number(locker.sensor?.temp ?? 25.0);
    const curHum = Number(locker.sensor?.humidity ?? 58.0);
    const curPwm = eStop ? 0 : Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;

    // Realistic thermal balance: ambient heat gain vs forced-air fan cooling
    const ambientTarget = sp + 0.45 + idx * 0.18;
    const coolingEffect = (curPwm / 100) * 0.22;
    const naturalDrift = (ambientTarget - curTemp) * 0.16;
    const jitter = (Math.random() - 0.49) * 0.08;
    const nextTemp = Number(Math.max(15.0, Math.min(36.0, curTemp + naturalDrift - coolingEffect + jitter)).toFixed(1));
    const nextHum = Number(Math.max(38.0, Math.min(85.0, curHum + (58.0 - curHum) * 0.08 + (Math.random() - 0.5) * 0.3)).toFixed(1));

    // Discrete Reverse-Acting PID calculation (matching ESP32 firmware)
    const pidMem = demoPidState[id];
    const err = nextTemp - sp;
    let computedAutoPwm = 0;
    if (err <= 0) {
      pidMem.integral = 0;
      pidMem.prevErr = err;
      computedAutoPwm = 0;
    } else {
      pidMem.integral = Math.max(0, Math.min(50, pidMem.integral + err * dtSec));
      const deriv = (err - pidMem.prevErr) / dtSec;
      pidMem.prevErr = err;
      computedAutoPwm = Math.max(0, Math.min(100, Math.round(kp * err + ki * pidMem.integral + kd * deriv)));
    }

    const nextPwm = eStop ? 0 : isManual ? Number(locker.control?.manual_pwm ?? 0) : computedAutoPwm;
    const fanFault = Boolean(locker.alarm?.fan_fault);
    const nextRpm =
      eStop || fanFault || nextPwm <= 0
        ? 0
        : Math.max(350, Math.min(4000, Math.round((nextPwm / 100) * 2800 + (Math.random() * 40 - 20))));

    locker.sensor.temp = nextTemp;
    locker.sensor.humidity = nextHum;
    locker.sensor.fan_rpm = nextRpm;
    if (!isManual) {
      locker.pid.output_pwm = nextPwm;
    }

    notifyDemoListeners(`lockers/${id}`);
  });
}

// ============================================================================
// Utilities & Helpers
// ============================================================================
function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTime(ts = Date.now()) {
  const d = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDateTime(ts = Date.now()) {
  const d = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatTime(d.getTime())}`;
}

function formatDateYmd(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatFilenameStamp(ts = Date.now()) {
  const d = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts));
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function isMonitoringUser() {
  return String(state.currentUser?.role || "").toLowerCase() === "monitoring";
}

function canWriteOperationalRtdb() {
  if (isDemoMode) return true;
  if (!isFirebaseConfigured || !auth?.currentUser || auth.currentUser.isAnonymous) return false;
  if (!state.currentUser || isMonitoringUser()) return false;
  return String(auth.currentUser.email || "").toLowerCase() !== "public@locker.local";
}

function canWriteAdminOrSensorRtdb() {
  if (isDemoMode) return true;
  if (!isFirebaseConfigured || !auth?.currentUser || auth.currentUser.isAnonymous) return false;
  return String(state.currentUser?.role || "").toLowerCase() === "admin";
}

function showToast(msg, isError = false) {
  el.globalToast.textContent = msg;
  el.globalToast.className = isError
    ? "bg-red-600 text-white px-4 py-1.5 font-mono-tabular text-xs font-bold tracking-wide text-center shadow-sm"
    : "bg-teal-600 text-white px-4 py-1.5 font-mono-tabular text-xs font-bold tracking-wide text-center shadow-sm";
  el.globalToast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.globalToast.classList.add("hidden"), 3500);
}

function playAlertBeep(freq = 880, durationMs = 200) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, durationMs);
  } catch (_) {}
}

function isLockerOnline(lockerId) {
  const locker = state.lockers[lockerId];
  const rt = state.runtime[lockerId];
  if (!locker || !locker.meta) return false;
  if (String(locker.meta.status || "").toLowerCase() !== "online") return false;
  return Date.now() - rt.lastHbTime <= HEARTBEAT_TIMEOUT_MS;
}

function setRingProgress(circleEl, percent) {
  if (!circleEl) return;
  const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
  circleEl.style.strokeDashoffset = String(RING_CIRC * (1 - clamped / 100));
}

function normalizeActionLabel(act) {
  const up = String(act || "INSPECT").toUpperCase();
  if (up === "AMBIL" || up === "WITHDRAW") return "WITHDRAW";
  if (up === "SIMPAN" || up === "RESTOCK") return "RESTOCK";
  return "INSPECT";
}

// FEFO Expiry Calculator
function getExpiryStatus(expiryDateStr) {
  if (!expiryDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(expiryDateStr).trim())) {
    return { status: "OK", daysLeft: null };
  }
  const [y, m, d] = String(expiryDateStr).trim().split("-").map(Number);
  const expTime = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const todayTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const daysLeft = Math.ceil((expTime - todayTime) / 86400000);
  if (daysLeft <= 0) return { status: "EXPIRED", daysLeft };
  if (daysLeft < 30) return { status: "EXP_SOON", daysLeft };
  return { status: "OK", daysLeft };
}

// Per-Locker Granular RBAC Checker
function canUserAccessLocker(lockerId) {
  if (!state.currentUser || isMonitoringUser()) return false;
  if (state.currentUser.role === "admin") return true;
  const liveUser = state.users[state.currentUser.uid];
  const allowedMap = liveUser?.allowed_lockers || state.currentUser.allowed_lockers;
  if (!allowedMap || typeof allowedMap !== "object") return true;
  return allowedMap[lockerId] !== false;
}

// ============================================================================
// Telegram Instant Alert Integration (Cooldown-Protected)
// ============================================================================
async function sendTelegramAlert(alertKey, message, bypassCooldown = false, overrideConfig = null) {
  const tg = overrideConfig || state.system.telegram || {};
  if (!bypassCooldown && !tg.enabled) return { ok: false, skipped: true };

  const token = String(tg.bot_token || "").trim();
  const chatId = String(tg.chat_id || "").trim();
  if (!token || !chatId) return { ok: false, error: "Missing Bot Token or Chat ID" };

  const cooldownMs = Math.max(5, Number(tg.cooldown_sec || 60)) * 1000;
  const lastTs = state.telegramLastSent[alertKey] || 0;
  if (!bypassCooldown && Date.now() - lastTs < cooldownMs) {
    return { ok: false, skipped: true };
  }

  state.telegramLastSent[alertKey] = Date.now();
  const formattedText = `[SMART MEDICINE LOCKER]\n${message}\nTime: ${formatDateTime()}`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formattedText })
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) {
      return { ok: false, error: json.description || `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// Build 3 Locker Cards with Batch/Exp, RBAC & Circular Animated Fan Dial
// ============================================================================
function buildLockerCards() {
  el.lockersGrid.textContent = "";
  LOCKER_IDS.forEach((id, idx) => {
    const num = idx + 1;
    const padNum = pad2(num);
    const card = document.createElement("article");
    card.id = `card-${id}`;
    card.dataset.cardLocker = id;
    card.className = "hmi-panel p-4 flex flex-col md:flex-row items-stretch justify-between gap-4";
    card.innerHTML = `
      <div class="flex-1 flex flex-col justify-between space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="px-2 py-0.5 rounded-full bg-teal-50 border border-teal-200 text-teal-800 text-[10px] font-mono-tabular font-extrabold uppercase">
              ESP ${num}
            </span>
            <h3 id="${id}-title" class="text-base font-extrabold text-slate-900 uppercase">Locker ${padNum}</h3>
            <span id="${id}-door-badge" class="px-2.5 py-0.5 rounded-full text-[11px] font-mono-tabular font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              CLOSED | LOCKED
            </span>
          </div>
          <div class="flex items-center gap-2">
            <span id="${id}-status-pill" class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-[10px] font-mono-tabular font-bold text-emerald-700">
              <span id="${id}-status-led" class="led-dot led-green"></span>
              <span id="${id}-status-text">ONLINE</span>
            </span>
            <span id="${id}-hb-text" class="text-[10px] font-mono-tabular text-slate-400">0s</span>
          </div>
        </div>

        <!-- Medicine, Stock, Batch & Expiry Row -->
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-1.5">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#F3F8FA] border border-[#E2EEF3] text-xs font-mono-tabular">
              <span id="${id}-med-name" class="font-bold text-slate-800">General Medicine</span>
              <span class="text-slate-300">•</span>
              <span class="text-slate-600">Stock: <strong id="${id}-stock-val" class="text-teal-700 font-extrabold">20</strong></span>
              <span id="${id}-min-stock" class="text-[10px] text-slate-400">(Min: 5)</span>
            </div>
            <div id="${id}-batch-pill" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#F3F8FA] border border-[#E2EEF3] text-[10px] font-mono-tabular text-slate-600">
              <span>Batch: <strong id="${id}-batch-val" class="text-slate-800">--</strong></span>
              <span class="text-slate-300">|</span>
              <span>Exp: <strong id="${id}-exp-val" class="text-slate-800">--</strong></span>
            </div>
          </div>
          <div id="${id}-alarm-tags" class="flex flex-wrap items-center gap-1.5 text-[10px] font-mono-tabular"></div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pt-0.5">
          <div class="hmi-subcard px-3 py-2">
            <span class="text-[10px] font-mono-tabular font-bold uppercase text-slate-400 block">Temp</span>
            <div class="flex items-baseline gap-1.5 mt-0.5">
              <strong id="${id}-temp-val" class="text-2xl font-extrabold font-mono-tabular text-slate-900">25.4°C</strong>
              <span id="${id}-temp-err" class="text-[11px] font-mono-tabular font-semibold text-teal-700">+0.4°C</span>
            </div>
            <span id="${id}-sp-label" class="text-[10px] font-mono-tabular text-slate-500">SP: 25.0°C</span>
          </div>

          <div class="hmi-subcard px-3 py-2">
            <span class="text-[10px] font-mono-tabular font-bold uppercase text-slate-400 block">Humidity</span>
            <div class="flex items-baseline gap-1.5 mt-0.5">
              <strong id="${id}-hum-val" class="text-2xl font-extrabold font-mono-tabular text-sky-700">58.0%</strong>
              <span id="${id}-hum-badge" class="text-[10px] font-mono-tabular font-bold text-emerald-700">OK</span>
            </div>
            <span id="${id}-hum-limit" class="text-[10px] font-mono-tabular text-slate-500">Max: 70%</span>
          </div>

          <div class="col-span-2 sm:col-span-1 flex flex-col justify-between gap-1.5">
            <button
              id="${id}-btn-unlock"
              type="button"
              data-unlock-locker="${id}"
              class="w-full flex-1 py-2 px-3 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-mono-tabular font-bold text-xs uppercase tracking-wider shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Unlock
            </button>
            <button
              id="${id}-btn-ack"
              type="button"
              data-ack-locker="${id}"
              class="hidden w-full py-1 px-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-mono-tabular font-bold text-[11px] uppercase animate-alarm-pulse"
            >
              ACK
            </button>
          </div>
        </div>
      </div>

      <!-- Circular Animated Fan & PWM Dial -->
      <div class="md:w-44 hmi-subcard p-3 flex flex-col items-center justify-center text-center shrink-0">
        <div class="flex items-center justify-between w-full text-[10px] font-mono-tabular text-slate-500 mb-1">
          <span id="${id}-mode-badge" class="px-2 py-0.5 rounded-full bg-teal-50 text-teal-800 border border-teal-200 font-bold">AUTO</span>
          <span id="${id}-pid-gains">Kp:12 Ki:0.5</span>
        </div>

        <div class="relative w-20 h-20 flex items-center justify-center my-0.5">
          <svg class="w-20 h-20" viewBox="0 0 88 88">
            <circle cx="44" cy="44" r="36" fill="none" stroke="#E2EEF3" stroke-width="6"></circle>
            <circle
              id="${id}-dial-ring"
              cx="44"
              cy="44"
              r="36"
              fill="none"
              stroke="#0D9488"
              stroke-width="6"
              stroke-linecap="round"
              stroke-dasharray="${DIAL_CIRC}"
              stroke-dashoffset="${DIAL_CIRC * 0.65}"
              class="gauge-ring-fg"
            ></circle>
          </svg>
          <svg id="${id}-fan-icon" class="absolute w-10 h-10 text-teal-600 fan-rotor" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4zm0 0c2.67-2 4-4 4-6a4 4 0 1 0-8 0c0 2 1.33 4 4 6zm0 0c-2.67 2-4 4-4 6a4 4 0 0 0 8 0c0-2-1.33-4-4-6z"></path>
            <circle cx="12" cy="12" r="2.2" fill="#0F172A"></circle>
          </svg>
        </div>

        <p class="text-[11px] font-mono-tabular font-extrabold text-slate-800 mt-1">
          <span id="${id}-rpm-val" class="text-teal-700">1200 RPM</span>
          <span class="text-slate-300">|</span>
          <span id="${id}-pwm-val" class="text-amber-600">35%</span>
        </p>
      </div>
    `;

    card.addEventListener("mouseenter", () => setHighlightedLocker(id));
    card.addEventListener("mouseleave", () => setHighlightedLocker(null));
    el.lockersGrid.appendChild(card);
  });

  document.querySelectorAll("[data-unlock-locker]").forEach((btn) => {
    btn.addEventListener("click", () => handleUnlockLockerCommand(btn.dataset.unlockLocker));
  });
  document.querySelectorAll("[data-ack-locker]").forEach((btn) => {
    btn.addEventListener("click", () => acknowledgeLockerAlarms(btn.dataset.ackLocker));
  });

  document.querySelectorAll("[data-iso-locker]").forEach((tier) => {
    const id = tier.dataset.isoLocker;
    tier.addEventListener("mouseenter", () => setHighlightedLocker(id));
    tier.addEventListener("mouseleave", () => setHighlightedLocker(null));
    tier.addEventListener("click", () => {
      setHighlightedLocker(id);
      const card = document.getElementById(`card-${id}`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
}

function setHighlightedLocker(lockerId) {
  state.highlightedLocker = lockerId;
  LOCKER_IDS.forEach((id) => {
    const card = document.getElementById(`card-${id}`);
    const tier = document.getElementById(`iso-tier-${id}`);
    if (card) card.classList.toggle("locker-card-highlight", id === lockerId);
    if (tier) tier.classList.toggle("iso-tier-active", id === lockerId);
  });
}

// ============================================================================
// Update Interactive Isometric Locker SVG (Including FAN FAULT & FORCED ENTRY)
// ============================================================================
function updateIsometricLockerSvg() {
  const eStop = Boolean(state.system.emergency_stop);

  LOCKER_IDS.forEach((id, idx) => {
    const locker = state.lockers[id];
    if (!locker) return;

    const num = idx + 1;
    const temp = Number(locker.sensor?.temp ?? 25.0);
    const sp = Number(locker.pid?.setpoint ?? 25.0);
    const doorOpen = Boolean(locker.sensor?.door_open);
    const unlocked = Boolean(locker.control?.unlock_cmd);
    const fanFault = Boolean(locker.alarm?.fan_fault);
    const forcedEntry = Boolean(locker.alarm?.forced_entry);
    const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
    const rawPwm = Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;
    const pwm = eStop ? 0 : Math.min(100, Math.max(0, rawPwm));

    const slotMed = document.getElementById(`login-slot${num}-med`);
    const slotTemp = document.getElementById(`login-slot${num}-temp`);
    const slotDoor = document.getElementById(`login-slot${num}-door`);
    if (slotMed) slotMed.textContent = locker.meta?.medicine_name || "General Medicine";
    if (slotTemp) slotTemp.textContent = `${temp.toFixed(1)}°C`;
    if (slotDoor) {
      slotDoor.textContent = doorOpen ? "OPEN" : "LOCKED";
      slotDoor.className = doorOpen
        ? "block text-[10px] text-amber-600 font-bold"
        : "block text-[10px] text-emerald-700 font-semibold";
    }

    // Fan Rotor + Ring (Stops & turns RED on FAN FAULT)
    const isoFan = document.getElementById(`iso-fan-${id}`);
    const isoFanRing = document.getElementById(`iso-fan-ring-${id}`);
    const isoFanBlade = document.getElementById(`iso-fan-blade-${id}`);
    if (isoFan) {
      if (fanFault) {
        isoFan.style.animationPlayState = "paused";
        if (isoFanRing) isoFanRing.setAttribute("stroke", "#EF4444");
        if (isoFanBlade) isoFanBlade.setAttribute("fill", "#EF4444");
      } else if (pwm <= 0) {
        isoFan.style.animationPlayState = "paused";
        if (isoFanRing) isoFanRing.setAttribute("stroke", "#94A3B8");
        if (isoFanBlade) isoFanBlade.setAttribute("fill", "#94A3B8");
      } else {
        const dur = Math.max(0.28, 2.3 - (pwm / 100) * 1.95);
        isoFan.style.animationDuration = `${dur.toFixed(2)}s`;
        isoFan.style.animationPlayState = "running";
        if (isoFanRing) isoFanRing.setAttribute("stroke", "#0D9488");
        if (isoFanBlade) isoFanBlade.setAttribute("fill", "#0D9488");
      }
    }

    // Airflow Arrows
    const isoAirflow = document.getElementById(`iso-airflow-${id}`);
    if (isoAirflow) {
      if (pwm <= 0 || fanFault) {
        isoAirflow.style.opacity = "0.06";
        isoAirflow.style.animationPlayState = "paused";
      } else {
        const opacity = Math.min(1, 0.25 + (pwm / 100) * 0.75);
        const airDur = Math.max(0.35, 1.6 - (pwm / 100) * 1.2);
        isoAirflow.style.opacity = opacity.toFixed(2);
        isoAirflow.style.animationDuration = `${airDur.toFixed(2)}s`;
        isoAirflow.style.animationPlayState = "running";
      }
    }

    // Thermal / Fault Interior Glow
    const isoGlow = document.getElementById(`iso-glow-${id}`);
    const isWarm = temp > sp + 0.5 || Boolean(locker.alarm?.over_temp);
    if (isoGlow) {
      if (forcedEntry || fanFault) {
        isoGlow.setAttribute("fill", "url(#glowDanger)");
        isoGlow.setAttribute("stroke", "#EF4444");
      } else if (isWarm) {
        isoGlow.setAttribute("fill", "url(#glowWarm)");
        isoGlow.setAttribute("stroke", "#F59E0B");
      } else {
        isoGlow.setAttribute("fill", "url(#glowCool)");
        isoGlow.setAttribute("stroke", "#14B8A6");
      }
    }

    // Isometric Door & Lock Tag
    const isoDoor = document.getElementById(`iso-door-${id}`);
    const isoLockBg = document.getElementById(`iso-lock-bg-${id}`);
    const isoLockTxt = document.getElementById(`iso-lock-txt-${id}`);
    const isOpenOrUnlocked = doorOpen || unlocked;
    if (isoDoor) isoDoor.classList.toggle("iso-door-open", doorOpen);
    if (isoLockBg && isoLockTxt) {
      if (forcedEntry) {
        isoLockBg.setAttribute("fill", "#FEE2E2");
        isoLockBg.setAttribute("stroke", "#EF4444");
        isoLockTxt.setAttribute("fill", "#B91C1C");
        isoLockTxt.textContent = "FORCED!";
      } else if (isOpenOrUnlocked) {
        isoLockBg.setAttribute("fill", "#FEF3C7");
        isoLockBg.setAttribute("stroke", "#F59E0B");
        isoLockTxt.setAttribute("fill", "#B45309");
        isoLockTxt.textContent = doorOpen ? "OPEN" : "UNLOCK";
      } else {
        isoLockBg.setAttribute("fill", "#DCFCE7");
        isoLockBg.setAttribute("stroke", "#10B981");
        isoLockTxt.setAttribute("fill", "#047857");
        isoLockTxt.textContent = "LOCKED";
      }
    }

    const isoTempTxt = document.getElementById(`iso-temp-txt-${id}`);
    if (isoTempTxt) {
      isoTempTxt.textContent = fanFault ? `${temp.toFixed(1)}°C • FAULT` : `${temp.toFixed(1)}°C • ${pwm}%`;
      isoTempTxt.setAttribute("fill", fanFault || forcedEntry ? "#DC2626" : isWarm ? "#D97706" : "#0D9488");
    }
  });
}

// ============================================================================
// Authentication & View Routing (100% Per-Device Local Session Isolation)
// ============================================================================
let rfidScanUnsubscribe = null;
let rfidClaimInProgress = false;
let enrollScanUnsubscribe = null;
let enrollTimeoutId = null;
let enrollClaimInProgress = false;
let isEnrollingCard = false;

function setEnrollStatusMessage(text, tone = "info") {
  if (!el.userScanStatus) return;
  if (!text) {
    el.userScanStatus.textContent = "";
    el.userScanStatus.classList.add("hidden");
    return;
  }
  el.userScanStatus.textContent = text;
  if (tone === "success") {
    el.userScanStatus.className = "text-[11px] font-mono-tabular font-bold text-emerald-700";
  } else if (tone === "warn") {
    el.userScanStatus.className = "text-[11px] font-mono-tabular font-bold text-amber-700";
  } else {
    el.userScanStatus.className = "text-[11px] font-mono-tabular font-bold text-teal-700 animate-pulse";
  }
}

function stopRfidCardEnrollment(statusText = "", statusTone = "info") {
  if (typeof enrollScanUnsubscribe === "function") {
    enrollScanUnsubscribe();
    enrollScanUnsubscribe = null;
  }
  if (enrollTimeoutId) {
    clearTimeout(enrollTimeoutId);
    enrollTimeoutId = null;
  }
  const wasEnrolling = isEnrollingCard;
  isEnrollingCard = false;
  enrollClaimInProgress = false;

  if (el.btnScanUserUid) {
    el.btnScanUserUid.className =
      "shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-teal-50 hover:bg-teal-100 border border-teal-300 text-[11px] font-mono-tabular font-bold text-teal-800 transition whitespace-nowrap";
  }
  if (el.scanUserUidDot) el.scanUserUidDot.classList.add("hidden");
  if (el.scanUserUidLabel) el.scanUserUidLabel.textContent = "Scan Card";
  setEnrollStatusMessage(statusText, statusTone);

  if (wasEnrolling && (isFirebaseConfigured || isDemoMode)) {
    state.authEnrollUntil = 0;
    set(ref(db, "auth/enroll_until"), 0).catch(() => {});
  }
}

function startRfidCardEnrollment() {
  if ((!isFirebaseConfigured && !isDemoMode) || state.currentUser?.role !== "admin") return;
  if (isEnrollingCard) {
    stopRfidCardEnrollment("", "info");
    return;
  }

  isEnrollingCard = true;
  enrollClaimInProgress = false;
  const enrollStartTime = Date.now();
  const enrollUntil = enrollStartTime + 30000;
  state.authEnrollUntil = enrollUntil;

  if (el.btnScanUserUid) {
    el.btnScanUserUid.className =
      "shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-teal-100 hover:bg-red-50 border border-teal-500 text-[11px] font-mono-tabular font-bold text-teal-900 transition whitespace-nowrap";
  }
  if (el.scanUserUidDot) el.scanUserUidDot.classList.remove("hidden");
  if (el.scanUserUidLabel) el.scanUserUidLabel.textContent = "Tap Card... (Cancel)";
  setEnrollStatusMessage(isDemoMode ? "Simulating ESP 1 Card Tap..." : "Waiting for ESP 1...", "info");

  set(ref(db, "auth/enroll_until"), enrollUntil).catch(() => {});

  if (isDemoMode) {
    setTimeout(() => {
      if (!isEnrollingCard) return;
      const simHex = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join("");
      update(ref(db, "auth/rfid_scan"), {
        uid: simHex,
        timestamp: Date.now(),
        processed: false
      }).catch(() => {});
    }, 1200);
  }

  enrollTimeoutId = setTimeout(() => {
    stopRfidCardEnrollment("", "info");
    showToast("Scan timeout (30s)", true);
  }, 30000);

  let isInitialSnapshot = true;
  let baselineScanStamp = null;

  enrollScanUnsubscribe = onValue(ref(db, "auth/rfid_scan"), async (snap) => {
    if (!isEnrollingCard || state.currentView !== "admin" || state.currentUser?.role !== "admin") {
      stopRfidCardEnrollment("", "info");
      return;
    }

    const scan = snap.val();
    if (!scan) {
      isInitialSnapshot = false;
      return;
    }

    const scanUid = String(scan.uid || "").trim();
    const scanTs = Number(scan.timestamp || 0);
    const scanStamp = `${scanUid}_${scanTs}`;

    // Ignore stale data already in /auth/rfid_scan when Scan Card was clicked
    if (isInitialSnapshot) {
      isInitialSnapshot = false;
      baselineScanStamp = scanStamp;
      return;
    }

    if (!scanUid || scanStamp === baselineScanStamp || enrollClaimInProgress) {
      return;
    }
    if (scan.processed !== false) {
      return;
    }

    baselineScanStamp = scanStamp;
    enrollClaimInProgress = true;

    try {
      await update(ref(db, "auth/rfid_scan"), { processed: true });
    } catch (_) {}

    if (!isEnrollingCard) return;

    el.userNewUid.value = scanUid;
    const alreadyRegistered = Boolean(
      state.users &&
        (state.users[scanUid] ||
          Object.values(state.users).some(
            (u) => String(u?.rfid_uid || "").trim().toUpperCase() === scanUid.toUpperCase()
          ))
    );

    if (alreadyRegistered) {
      stopRfidCardEnrollment("UID Already Registered", "warn");
      playAlertBeep(480, 240);
      showToast(`UID Already Registered (${scanUid})`, true);
    } else {
      stopRfidCardEnrollment("UID Captured", "success");
      playAlertBeep(1040, 140);
      showToast(`UID Captured: ${scanUid}`);
      if (el.userNewName) el.userNewName.focus();
    }
  });
}

function purgeLegacyAuthKeys() {
  try {
    LEGACY_AUTH_KEYS.forEach((k) => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });
  } catch (_) {}
}

function loadSavedSession() {
  purgeLegacyAuthKeys();
  try {
    const raw = localStorage.getItem(STORAGE_AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.uid || !parsed.role) {
      localStorage.removeItem(STORAGE_AUTH_KEY);
      return null;
    }
    return {
      uid: String(parsed.uid),
      name: String(parsed.name || parsed.uid),
      role: String(parsed.role || "operator").toLowerCase(),
      username: String(parsed.username || parsed.uid),
      allowed_lockers: parsed.allowed_lockers || { locker_1: true, locker_2: true, locker_3: true },
      loginTime: Number(parsed.loginTime || Date.now())
    };
  } catch (_) {
    return null;
  }
}

function saveSession(userObj) {
  const cleanSession = {
    uid: String(userObj.uid),
    name: String(userObj.name || userObj.uid),
    role: String(userObj.role || "operator").toLowerCase(),
    username: String(userObj.username || userObj.uid),
    allowed_lockers: userObj.allowed_lockers || { locker_1: true, locker_2: true, locker_3: true },
    loginTime: Number(userObj.loginTime || Date.now())
  };
  state.currentUser = cleanSession;
  try {
    localStorage.setItem(STORAGE_AUTH_KEY, JSON.stringify(cleanSession));
    sessionStorage.setItem(STORAGE_AUTH_KEY, JSON.stringify(cleanSession));
  } catch (_) {}
}

function clearSession() {
  stopRfidCardEnrollment("", "info");
  state.currentUser = null;
  purgeLegacyAuthKeys();
  try {
    localStorage.removeItem(STORAGE_AUTH_KEY);
    sessionStorage.removeItem(STORAGE_AUTH_KEY);
  } catch (_) {}
  LOCKER_IDS.forEach((id) => disarmLockerUnlock(id, false));
}

async function ensureAnonymousLoginScreenAuth() {
  if (!isFirebaseConfigured || !auth) return;
  if (auth.currentUser) return;
  try {
    await signInAnonymously(auth);
  } catch (_) {}
}

async function resolveAndCompleteFirebaseLogin(fbUser, announceLogin = true) {
  if (!isFirebaseConfigured || !fbUser || fbUser.isAnonymous) return;

  const email = String(fbUser.email || "").trim().toLowerCase();
  const usernameFromEmail = email.includes("@") ? email.split("@")[0] : email;

  // Special case: public@locker.local -> forced monitoring (read-only) without reading /system/telegram
  const isPublicEmail = email === "public@locker.local" || usernameFromEmail === "public";

  let usersMap = {};
  try {
    const snap = await get(ref(db, "users"));
    usersMap = snap.val() || {};
    state.users = usersMap;
  } catch (_) {
    usersMap = state.users || {};
  }

  const matchedEntry = Object.entries(usersMap).find(
    ([, u]) => String(u?.username || "").trim().toLowerCase() === usernameFromEmail
  );

  if (matchedEntry && matchedEntry[1]?.active === false) {
    clearSession();
    await signOut(auth).catch(() => {});
    playAlertBeep(360, 300);
    el.loginAlert.textContent = "Access Denied: Account is disabled.";
    el.loginAlert.classList.remove("hidden");
    return;
  }

  const profileKey = matchedEntry ? matchedEntry[0] : isPublicEmail ? "USER_PUBLIC" : fbUser.uid;
  const rawRec = matchedEntry ? matchedEntry[1] : null;
  const resolvedRole = isPublicEmail
    ? "monitoring"
    : String(rawRec?.role || "operator").trim().toLowerCase();

  const resolvedUserRec = {
    name: rawRec?.name || (isPublicEmail ? "Public Monitoring" : usernameFromEmail),
    username: rawRec?.username || usernameFromEmail,
    role: resolvedRole,
    rfid_uid: rawRec?.rfid_uid || "",
    active: true,
    allowed_lockers:
      isPublicEmail || resolvedRole === "monitoring"
        ? { locker_1: false, locker_2: false, locker_3: false }
        : resolvedRole === "admin"
          ? { locker_1: true, locker_2: true, locker_3: true }
          : rawRec?.allowed_lockers || { locker_1: true, locker_2: true, locker_3: true }
  };

  attachProtectedUserListeners(resolvedRole === "admin" && !isPublicEmail);
  loginWithUser(profileKey, resolvedUserRec, announceLogin);
}

async function handleRfidUidLoginAttempt(uid) {
  if (state.currentUser || state.currentView !== "login") return;
  const cleanUid = String(uid || "").trim();
  if (!cleanUid) return;

  el.loginLastRfid.textContent = cleanUid;

  if (isDemoMode) {
    const matchedDemo =
      state.users[cleanUid] ||
      Object.values(state.users).find((u) => String(u?.rfid_uid || "").toUpperCase() === cleanUid.toUpperCase());
    if (matchedDemo && matchedDemo.active !== false) {
      playAlertBeep(1040, 150);
      loginWithUser(cleanUid, matchedDemo, true);
    } else {
      playAlertBeep(360, 350);
      el.loginAlert.textContent = `Access Denied: Unregistered UID (${cleanUid})`;
      el.loginAlert.classList.remove("hidden");
      showToast(`Access Denied (${cleanUid})`, true);
    }
    return;
  }

  try {
    await ensureAnonymousLoginScreenAuth();
    const credSnap = await get(ref(db, `rfid_auth/${cleanUid}`));
    const cred = credSnap.val();
    if (!cred || !cred.email || !cred.password) {
      playAlertBeep(360, 350);
      el.loginAlert.textContent = `Access Denied: Unregistered UID (${cleanUid})`;
      el.loginAlert.classList.remove("hidden");
      showToast(`Access Denied (${cleanUid})`, true);
      return;
    }

    const userCred = await signInWithEmailAndPassword(auth, String(cred.email).trim(), String(cred.password));
    // Now authenticated as non-anonymous user -> mark rfid_scan processed
    await update(ref(db, "auth/rfid_scan"), { processed: true }).catch(() => {});
    playAlertBeep(1040, 150);
    await resolveAndCompleteFirebaseLogin(userCred.user, true);
  } catch (_) {
    playAlertBeep(360, 350);
    el.loginAlert.textContent = `Access Denied: RFID Auth Failed (${cleanUid})`;
    el.loginAlert.classList.remove("hidden");
    showToast(`Access Denied (${cleanUid})`, true);
  }
}

function detachRfidLoginListener() {
  if (typeof rfidScanUnsubscribe === "function") {
    rfidScanUnsubscribe();
    rfidScanUnsubscribe = null;
  }
  rfidClaimInProgress = false;
}

function attachRfidLoginListener() {
  if (!isFirebaseConfigured) return;
  if (!auth?.currentUser) return;
  if (state.currentUser || state.currentView !== "login") {
    detachRfidLoginListener();
    return;
  }
  if (typeof rfidScanUnsubscribe === "function") return;

  let isInitialSnapshot = true;
  let baselineScanStamp = null;

  rfidScanUnsubscribe = onValue(ref(db, "auth/rfid_scan"), async (snap) => {
    // Strict Guard: Never process RFID login if this device is already authenticated as a user
    if (state.currentUser || state.currentView !== "login") {
      detachRfidLoginListener();
      return;
    }

    const scan = snap.val();
    if (!scan) {
      isInitialSnapshot = false;
      return;
    }

    const scanUid = String(scan.uid || "").trim();
    const scanTs = Number(scan.timestamp || 0);
    const scanStamp = `${scanUid}_${scanTs}`;

    // Ignore stale data already sitting in RTDB when Login Page first loads
    if (isInitialSnapshot) {
      isInitialSnapshot = false;
      baselineScanStamp = scanStamp;
      if (scanUid) el.loginLastRfid.textContent = scanUid;
      if (scan.processed === false && Date.now() >= state.authEnrollUntil && canWriteOperationalRtdb()) {
        update(ref(db, "auth/rfid_scan"), { processed: true }).catch(() => {});
      }
      return;
    }

    // Ignore scan on Login Page if an Admin is currently enrolling a card (30s window)
    if (Date.now() < state.authEnrollUntil) {
      baselineScanStamp = scanStamp;
      return;
    }

    // Only claim genuinely new unprocessed scans that arrived after Login Page opened
    if (scan.processed !== false || !scanUid || scanStamp === baselineScanStamp || rfidClaimInProgress) {
      return;
    }

    baselineScanStamp = scanStamp;
    el.loginLastRfid.textContent = scanUid;
    rfidClaimInProgress = true;

    try {
      if (state.currentUser || state.currentView !== "login") return;
      await handleRfidUidLoginAttempt(scanUid);
    } catch (_) {
    } finally {
      rfidClaimInProgress = false;
    }
  });
}

function loginWithUser(uid, userRec, announceToast = true) {
  detachRfidLoginListener();
  const sessionUser = {
    uid,
    name: userRec.name || uid,
    role: String(userRec.role || "operator").toLowerCase(),
    username: userRec.username || uid,
    allowed_lockers: userRec.allowed_lockers || { locker_1: true, locker_2: true, locker_3: true },
    loginTime: Date.now()
  };
  saveSession(sessionUser);
  el.loginAlert.classList.add("hidden");
  navigateToView("dashboard");
  if (announceToast) {
    showToast(`Signed in: ${sessionUser.name} (${sessionUser.role.toUpperCase()})`);
  }
  renderDashboardLockers();
  restorePendingInterlockIfAny();
}

function navigateToView(targetView, focusCatalog = false) {
  if (targetView !== "admin" && isEnrollingCard) {
    stopRfidCardEnrollment("", "info");
  }
  if (!state.currentUser) {
    state.currentView = "login";
    el.appChrome.classList.add("hidden");
    el.viewLogin.classList.remove("hidden");
    el.viewDashboard.classList.add("hidden");
    el.viewReports.classList.add("hidden");
    el.viewAdmin.classList.add("hidden");
    if (el.viewSimulator) el.viewSimulator.classList.add("hidden");
    attachRfidLoginListener();
    return;
  }

  detachRfidLoginListener();

  if ((targetView === "admin" || targetView === "simulator") && state.currentUser.role !== "admin") {
    playAlertBeep(440, 300);
    showToast("Access Denied: Admin only.", true);
    targetView = "dashboard";
  }

  state.currentView = targetView;
  el.appChrome.classList.remove("hidden");
  el.viewLogin.classList.add("hidden");

  const isAdmin = state.currentUser.role === "admin";
  const isMonitoring = isMonitoringUser();
  el.headerUserName.textContent = state.currentUser.name;
  el.headerUserUid.textContent = state.currentUser.uid;
  el.headerUserRole.textContent = isAdmin ? "ADMIN" : isMonitoring ? "MONITORING" : "OPERATOR";
  el.headerUserRole.className = isAdmin
    ? "px-1.5 py-0.5 rounded-full text-[9px] font-mono-tabular font-bold uppercase bg-teal-100 text-teal-800 border border-teal-300"
    : isMonitoring
      ? "px-1.5 py-0.5 rounded-full text-[9px] font-mono-tabular font-bold uppercase bg-indigo-100 text-indigo-800 border border-indigo-300"
      : "px-1.5 py-0.5 rounded-full text-[9px] font-mono-tabular font-bold uppercase bg-emerald-100 text-emerald-800 border border-emerald-300";

  el.navBtnAdmin.classList.toggle("hidden", !isAdmin);
  if (el.navBtnCatalog) el.navBtnCatalog.classList.toggle("hidden", !isAdmin);
  if (el.navBtnSimulator) el.navBtnSimulator.classList.toggle("hidden", !isAdmin);

  // Read-Only guard for MONITORING role (disable E-STOP, ACK, and Log Snapshot controls)
  if (el.btnEstop) {
    el.btnEstop.disabled = isMonitoring;
    el.btnEstop.classList.toggle("opacity-50", isMonitoring);
    el.btnEstop.classList.toggle("cursor-not-allowed", isMonitoring);
    el.btnEstop.title = isMonitoring ? "View Only (Monitoring Role)" : "Emergency Stop";
  }
  if (el.estopBannerReleaseBtn) el.estopBannerReleaseBtn.classList.toggle("hidden", isMonitoring);
  if (el.btnKpiAckAll) el.btnKpiAckAll.classList.toggle("hidden", isMonitoring);
  if (el.btnAckAllAlarms) el.btnAckAllAlarms.classList.toggle("hidden", isMonitoring);
  if (el.btnLogSnapshotNow) el.btnLogSnapshotNow.classList.toggle("hidden", !isAdmin && !isDemoMode);

  const activePill = "px-3.5 py-1 rounded-full text-xs font-mono-tabular font-bold uppercase bg-teal-600 text-white shadow-sm transition";
  const idlePill = "px-3.5 py-1 rounded-full text-xs font-mono-tabular font-semibold uppercase bg-white text-slate-600 hover:bg-teal-50 hover:text-teal-700 border border-slate-200 transition";

  el.viewDashboard.classList.toggle("hidden", targetView !== "dashboard");
  el.viewReports.classList.toggle("hidden", targetView !== "reports");
  el.viewAdmin.classList.toggle("hidden", targetView !== "admin");
  if (el.viewSimulator) el.viewSimulator.classList.toggle("hidden", targetView !== "simulator");

  el.navBtnDashboard.className = targetView === "dashboard" ? activePill : idlePill;
  el.navBtnReports.className = targetView === "reports" ? activePill : idlePill;
  if (isAdmin) {
    el.navBtnAdmin.className = targetView === "admin" && !focusCatalog ? activePill : idlePill;
    if (el.navBtnCatalog) el.navBtnCatalog.className = targetView === "admin" && focusCatalog ? activePill : idlePill;
    if (el.navBtnSimulator) el.navBtnSimulator.className = targetView === "simulator" ? activePill : idlePill;
  }

  if (targetView === "reports") {
    renderReportsView();
  } else if (targetView === "admin") {
    renderUsersAdmin();
    populatePidFormForSelectedLocker(true);
    populateAssignLockerFields(false);
    updatePidChartView();
    if (focusCatalog && el.sectionMedicineCatalog) {
      setTimeout(() => el.sectionMedicineCatalog.scrollIntoView({ behavior: "smooth" }), 80);
    }
  }
}

// ============================================================================
// Page 3: Mandatory Inventory Modal (Hard Interlock + Expired Operator Lock)
// ============================================================================
function triggerInventoryInterlock(lockerId, reason = "UNLOCK") {
  if (!LOCKER_IDS.includes(lockerId)) return;
  if (isMonitoringUser()) {
    localStorage.removeItem(STORAGE_INTERLOCK_KEY);
    return;
  }
  state.interlock.active = true;
  state.interlock.lockerId = lockerId;
  state.interlock.idleSecondsLeft = INTERLOCK_WARN_SECONDS;

  localStorage.setItem(STORAGE_INTERLOCK_KEY, JSON.stringify({ lockerId, reason, timestamp: Date.now() }));

  const locker = state.lockers[lockerId];
  el.invLockerName.textContent = locker?.meta?.name || lockerId.toUpperCase();
  el.invMedicineName.textContent = locker?.meta?.medicine_name || "General Medicine";
  el.invCurrentStock.textContent = String(locker?.meta?.stock ?? 0);
  el.invBatchExp.textContent = `${locker?.meta?.batch_no || "--"} | Exp ${locker?.meta?.expiry_date || "--"}`;

  // FEFO Expiry Block for Operator on EXPIRED medicine
  const expInfo = getExpiryStatus(locker?.meta?.expiry_date);
  const isExpired = expInfo.status === "EXPIRED";
  const isAdmin = state.currentUser?.role === "admin";
  const blockWithdraw = isExpired && !isAdmin;

  el.invRadioWithdraw.disabled = blockWithdraw;
  if (isExpired) {
    el.invExpiredNotice.textContent = blockWithdraw
      ? "EXPIRED — Withdraw Blocked (Operator)"
      : "EXPIRED — Admin Override Active";
    el.invExpiredNotice.classList.remove("hidden");
  } else {
    el.invExpiredNotice.classList.add("hidden");
  }

  if (blockWithdraw) {
    el.invRadioInspect.checked = true;
  } else {
    el.invRadioWithdraw.checked = true;
  }

  el.invQuantity.value = "1";
  el.invNotes.value = "";
  el.invErrorMsg.classList.add("hidden");
  el.invIgnoredBanner.classList.add("hidden");
  updateInventoryFormPreview();

  el.inventoryModal.classList.remove("hidden");
  startInterlockIdleCountdown();
}

function restorePendingInterlockIfAny() {
  if (!state.currentUser) return;
  if (isMonitoringUser()) {
    localStorage.removeItem(STORAGE_INTERLOCK_KEY);
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_INTERLOCK_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.lockerId) {
      triggerInventoryInterlock(parsed.lockerId, "RESTORED");
      showInterlockIgnoredWarning();
    }
  } catch (_) {}
}

function startInterlockIdleCountdown() {
  clearInterval(state.interlock.timerId);
  state.interlock.idleSecondsLeft = INTERLOCK_WARN_SECONDS;
  el.invIdleTimer.textContent = `${state.interlock.idleSecondsLeft}s`;

  state.interlock.timerId = setInterval(() => {
    if (!state.interlock.active) {
      clearInterval(state.interlock.timerId);
      return;
    }
    state.interlock.idleSecondsLeft -= 1;
    if (state.interlock.idleSecondsLeft > 0) {
      el.invIdleTimer.textContent = `${state.interlock.idleSecondsLeft}s`;
    } else {
      el.invIdleTimer.textContent = "REQUIRED";
      showInterlockIgnoredWarning();
    }
  }, 1000);
}

function resetInterlockIdleTimerOnInput() {
  if (!state.interlock.active) return;
  state.interlock.idleSecondsLeft = INTERLOCK_WARN_SECONDS;
  el.invIdleTimer.textContent = `${state.interlock.idleSecondsLeft}s`;
}

function showInterlockIgnoredWarning() {
  el.invIgnoredBanner.classList.remove("hidden");
  playAlertBeep(960, 240);
}

function getSelectedInventoryAction() {
  const checked = el.formInventoryInterlock.querySelector('input[name="inv_action"]:checked');
  return checked ? checked.value : "INSPECT";
}

function updateInventoryFormPreview() {
  const lockerId = state.interlock.lockerId || "locker_1";
  const curStock = Number(state.lockers[lockerId]?.meta?.stock ?? 0);
  const action = getSelectedInventoryAction();

  if (action === "INSPECT") {
    el.invQuantity.value = "0";
    el.invQuantity.disabled = true;
    el.invStockPreview.textContent = `Stock: ${curStock}`;
    el.invStockPreview.className = "text-xs font-mono-tabular font-bold text-teal-700";
  } else {
    el.invQuantity.disabled = false;
    if (Number(el.invQuantity.value) <= 0) el.invQuantity.value = "1";
    const qty = Math.max(0, Math.floor(Number(el.invQuantity.value) || 0));
    const after = action === "WITHDRAW" ? curStock - qty : curStock + qty;
    el.invStockPreview.textContent = `Stock: ${after}`;
    el.invStockPreview.className =
      after < 0 ? "text-xs font-mono-tabular text-red-600 font-bold" : "text-xs font-mono-tabular font-bold text-teal-700";
  }
}

async function handleInventorySubmit(e) {
  e.preventDefault();
  const lockerId = state.interlock.lockerId;
  if (!lockerId) return;

  const locker = state.lockers[lockerId];
  const curStock = Number(locker?.meta?.stock ?? 0);
  const action = getSelectedInventoryAction();
  const rawQty = Math.floor(Number(el.invQuantity.value) || 0);
  const notes = el.invNotes.value.trim();

  el.invErrorMsg.classList.add("hidden");
  let quantity = rawQty;
  let newStock = curStock;

  if (action === "WITHDRAW") {
    const expInfo = getExpiryStatus(locker?.meta?.expiry_date);
    if (expInfo.status === "EXPIRED" && state.currentUser?.role !== "admin") {
      el.invErrorMsg.textContent = "Blocked: Expired item (Admin only).";
      el.invErrorMsg.classList.remove("hidden");
      playAlertBeep(440, 260);
      return;
    }
    if (quantity < 1) {
      el.invErrorMsg.textContent = "Min quantity: 1.";
      el.invErrorMsg.classList.remove("hidden");
      return;
    }
    if (quantity > curStock) {
      el.invErrorMsg.textContent = `Insufficient stock (Available: ${curStock}).`;
      el.invErrorMsg.classList.remove("hidden");
      playAlertBeep(520, 240);
      return;
    }
    newStock = curStock - quantity;
  } else if (action === "RESTOCK") {
    if (quantity < 1) {
      el.invErrorMsg.textContent = "Min quantity: 1.";
      el.invErrorMsg.classList.remove("hidden");
      return;
    }
    newStock = curStock + quantity;
  } else if (action === "INSPECT") {
    quantity = 0;
    newStock = curStock;
    if (!notes) {
      el.invErrorMsg.textContent = "Note required for Inspect.";
      el.invErrorMsg.classList.remove("hidden");
      playAlertBeep(520, 240);
      return;
    }
  }

  const medId = locker?.meta?.medicine_id || "med_general";
  const minStockAlarm = Number(state.medicineCatalog[medId]?.min_stock_alarm ?? 5);
  const isLowStock = newStock <= minStockAlarm;
  const user = state.currentUser || { uid: "UNKNOWN", name: "Operator", role: "operator" };

  const txPayload = {
    timestamp: Date.now(),
    user_uid: user.uid,
    user_name: user.name,
    role: user.role,
    locker_id: lockerId,
    locker_name: locker?.meta?.name || lockerId,
    medicine_name: locker?.meta?.medicine_name || "General Medicine",
    batch_no: locker?.meta?.batch_no || "",
    action,
    quantity,
    stock_before: curStock,
    stock_after: newStock,
    notes: notes || (action === "WITHDRAW" ? "Routine dispense" : "Pharmacy restock")
  };

  try {
    const updates = {
      [`lockers/${lockerId}/meta/stock`]: newStock,
      [`lockers/${lockerId}/control/unlock_cmd`]: false,
      [`lockers/${lockerId}/alarm/low_stock`]: isLowStock
    };
    if (isLowStock) updates[`lockers/${lockerId}/alarm/acknowledged`] = false;

    await update(ref(db), updates);
    await push(ref(db, "logs/transactions"), txPayload);

    if (isLowStock) {
      await push(ref(db, "logs/alarms"), {
        timestamp: Date.now(),
        locker_id: lockerId,
        type: "LOW_STOCK",
        message: `${locker?.meta?.name}: LOW STOCK (${newStock} <= ${minStockAlarm})`,
        acknowledged: false
      });
    }

    state.interlock.active = false;
    state.interlock.lockerId = null;
    clearInterval(state.interlock.timerId);
    localStorage.removeItem(STORAGE_INTERLOCK_KEY);
    el.inventoryModal.classList.add("hidden");
    showToast(`Inventory updated (${action}): Stock ${newStock}`);

    // In Interactive Demo Mode, automatically close the simulated door 1.5s after inventory confirmation
    if (isDemoMode) {
      setTimeout(() => {
        update(ref(db, `lockers/${lockerId}`), {
          "sensor/door_open": false,
          "alarm/door_left_open": false
        }).catch(() => {});
      }, 1500);
    }
  } catch (err) {
    el.invErrorMsg.textContent = `Save failed: ${err.message}`;
    el.invErrorMsg.classList.remove("hidden");
  }
}

// ============================================================================
// 2-Stage Unlock Command (Armed State + RBAC Guard + Authorized Window)
// ============================================================================
function disarmLockerUnlock(lockerId, notifyTimeout = false) {
  if (state.awaitingDoorTimers[lockerId]) {
    clearTimeout(state.awaitingDoorTimers[lockerId]);
    state.awaitingDoorTimers[lockerId] = null;
  }
  const wasArmed = state.awaitingDoorOpen[lockerId];
  state.awaitingDoorOpen[lockerId] = false;
  if (wasArmed) {
    renderDashboardLockers();
    if (notifyTimeout) {
      if (!Boolean(state.lockers[lockerId]?.sensor?.door_open)) {
        state.runtime[lockerId].authorizedOpenSession = false;
      }
      set(ref(db, `lockers/${lockerId}/control/unlock_cmd`), false).catch(() => {});
      showToast(`${state.lockers[lockerId]?.meta?.name || lockerId.toUpperCase()}: Door timeout`);
    }
  }
}

async function handleUnlockLockerCommand(lockerId) {
  if (isMonitoringUser()) {
    playAlertBeep(440, 220);
    showToast("View Only: Monitoring account", true);
    return;
  }
  if (!canUserAccessLocker(lockerId)) {
    playAlertBeep(440, 260);
    showToast("Access Denied: Restricted", true);
    return;
  }
  if (state.system.emergency_stop) {
    playAlertBeep(480, 250);
    showToast("Blocked: E-STOP Active", true);
    return;
  }

  try {
    state.runtime[lockerId].lastAuthorizedUnlockAt = Date.now();
    state.runtime[lockerId].authorizedOpenSession = true;
    state.awaitingDoorOpen[lockerId] = true;
    if (state.awaitingDoorTimers[lockerId]) {
      clearTimeout(state.awaitingDoorTimers[lockerId]);
    }
    state.awaitingDoorTimers[lockerId] = setTimeout(() => {
      disarmLockerUnlock(lockerId, true);
    }, UNLOCK_ARMED_TIMEOUT_MS);

    renderDashboardLockers();

    await update(ref(db, `lockers/${lockerId}`), {
      "control/unlock_cmd": true
    });

    if (Boolean(state.lockers[lockerId]?.sensor?.door_open) && state.awaitingDoorOpen[lockerId]) {
      disarmLockerUnlock(lockerId, false);
      triggerInventoryInterlock(lockerId, "ARMED_DOOR_OPEN");
    }

    setTimeout(async () => {
      try {
        await set(ref(db, `lockers/${lockerId}/control/unlock_cmd`), false);
      } catch (_) {}
    }, 4000);
  } catch (err) {
    disarmLockerUnlock(lockerId, false);
    showToast(`Unlock error: ${err.message}`, true);
  }
}

// ============================================================================
// Alarm Evaluation (V1 + V2: FAN FAULT, FORCED ENTRY, EXPIRED + Telegram)
// ============================================================================
async function evaluateLockerAlarms(lockerId) {
  const locker = state.lockers[lockerId];
  if (!locker) return;

  const medId = locker.meta?.medicine_id || "med_general";
  const medSpec = state.medicineCatalog[medId] || { max_temp_alarm: 28.0, max_hum_alarm: 70.0, min_stock_alarm: 5 };
  const temp = Number(locker.sensor?.temp ?? 25);
  const hum = Number(locker.sensor?.humidity ?? 55);
  const stock = Number(locker.meta?.stock ?? 10);
  const doorOpen = Boolean(locker.sensor?.door_open);
  const eStop = Boolean(state.system.emergency_stop);
  const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
  const pwm = eStop ? 0 : Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;
  const rpm = Number(locker.sensor?.fan_rpm ?? 0);
  const rt = state.runtime[lockerId];
  const curAlarm = locker.alarm || {};

  // Fan Fault watchdog (>5s with PWM > 30% & RPM == 0 while not E-Stop)
  if (!eStop && pwm > 30 && rpm === 0) {
    if (!rt.fanZeroSince) rt.fanZeroSince = Date.now();
  } else {
    rt.fanZeroSince = null;
  }

  let fanFault = Boolean(curAlarm.fan_fault);
  if (!eStop && pwm > 30 && rpm === 0 && rt.fanZeroSince && Date.now() - rt.fanZeroSince > FAN_FAULT_DELAY_MS) {
    fanFault = true;
  } else if (rpm > 0 || pwm <= 30 || eStop) {
    fanFault = false;
  }

  const overTemp = temp > Number(medSpec.max_temp_alarm);
  const highHum = hum > Number(medSpec.max_hum_alarm);
  const lowStock = stock <= Number(medSpec.min_stock_alarm);
  const expiredMed = getExpiryStatus(locker.meta?.expiry_date).status === "EXPIRED";
  const forcedEntry = Boolean(curAlarm.forced_entry);
  const doorLeftOpen =
    Boolean(curAlarm.door_left_open) ||
    (doorOpen && rt.doorOpenedAt && Date.now() - rt.doorOpenedAt > DOOR_OPEN_ALARM_MS);

  const newlyTriggered =
    (overTemp && !curAlarm.over_temp) ||
    (highHum && !curAlarm.high_hum) ||
    (lowStock && !curAlarm.low_stock) ||
    (doorLeftOpen && !curAlarm.door_left_open) ||
    (fanFault && !curAlarm.fan_fault) ||
    (expiredMed && !curAlarm.expired_med);

  const hasChanged =
    overTemp !== Boolean(curAlarm.over_temp) ||
    highHum !== Boolean(curAlarm.high_hum) ||
    lowStock !== Boolean(curAlarm.low_stock) ||
    doorLeftOpen !== Boolean(curAlarm.door_left_open) ||
    fanFault !== Boolean(curAlarm.fan_fault) ||
    expiredMed !== Boolean(curAlarm.expired_med);

  if (hasChanged && canWriteOperationalRtdb()) {
    const anyActive = overTemp || highHum || lowStock || doorLeftOpen || fanFault || forcedEntry || expiredMed;
    const nextAck = newlyTriggered ? false : anyActive ? Boolean(curAlarm.acknowledged) : true;
    try {
      await update(ref(db, `lockers/${lockerId}/alarm`), {
        over_temp: overTemp,
        high_hum: highHum,
        low_stock: lowStock,
        door_left_open: doorLeftOpen,
        fan_fault: fanFault,
        expired_med: expiredMed,
        acknowledged: nextAck
      });
      if (newlyTriggered) {
        const lockerLabel = locker.meta?.name || lockerId;
        const reasons = [];
        if (overTemp && !curAlarm.over_temp) {
          reasons.push(`OVER TEMP (${temp.toFixed(1)}°C)`);
          sendTelegramAlert(`${lockerId}_over_temp`, `OVER TEMP on ${lockerLabel}: ${temp.toFixed(1)}°C (Max ${medSpec.max_temp_alarm}°C)`);
        }
        if (highHum && !curAlarm.high_hum) reasons.push(`HIGH HUMIDITY (${hum.toFixed(1)}%)`);
        if (lowStock && !curAlarm.low_stock) reasons.push(`LOW STOCK (${stock})`);
        if (doorLeftOpen && !curAlarm.door_left_open) reasons.push("DOOR OPEN >30s");
        if (fanFault && !curAlarm.fan_fault) {
          reasons.push("FAN FAULT (0 RPM)");
          sendTelegramAlert(`${lockerId}_fan_fault`, `FAN FAULT on ${lockerLabel}: PWM ${pwm}% with 0 RPM`);
        }
        if (expiredMed && !curAlarm.expired_med) reasons.push(`EXPIRED (${locker.meta?.expiry_date})`);

        await push(ref(db, "logs/alarms"), {
          timestamp: Date.now(),
          locker_id: lockerId,
          type: (fanFault && !curAlarm.fan_fault) || (overTemp && !curAlarm.over_temp) ? "CRITICAL" : "ALARM",
          message: `${lockerLabel}: ${reasons.join(", ")}`,
          acknowledged: false
        });
      }
    } catch (_) {}
  }
}

async function triggerForcedEntryAlarm(lockerId) {
  if (!canWriteOperationalRtdb()) return;
  const locker = state.lockers[lockerId];
  const lockerLabel = locker?.meta?.name || lockerId.toUpperCase();
  try {
    await update(ref(db, `lockers/${lockerId}/alarm`), {
      forced_entry: true,
      acknowledged: false
    });
    await push(ref(db, "logs/alarms"), {
      timestamp: Date.now(),
      locker_id: lockerId,
      type: "CRITICAL",
      message: `${lockerLabel}: FORCED ENTRY (Unauthorized door open)`,
      acknowledged: false
    });
    sendTelegramAlert(`${lockerId}_forced_entry`, `CRITICAL — FORCED ENTRY detected on ${lockerLabel}!`);
    playAlertBeep(980, 320);
  } catch (_) {}
}

async function acknowledgeLockerAlarms(lockerId) {
  if (isMonitoringUser()) return;
  const doorOpen = Boolean(state.lockers[lockerId]?.sensor?.door_open);
  const lockerLabel = state.lockers[lockerId]?.meta?.name || lockerId.toUpperCase();
  const actor = state.currentUser
    ? `${state.currentUser.name} (${state.currentUser.role.toUpperCase()})`
    : "Operator";
  try {
    const patch = { acknowledged: true };
    if (!doorOpen) {
      patch.door_left_open = false;
      patch.forced_entry = false;
    }
    await update(ref(db, `lockers/${lockerId}/alarm`), patch);
    await push(ref(db, "logs/alarms"), {
      timestamp: Date.now(),
      locker_id: lockerId,
      type: "INFO",
      message: `${lockerLabel}: Alarms ACKED by ${actor}`,
      acknowledged: true
    });
    showToast(`ACK: ${lockerLabel}`);
  } catch (err) {
    showToast(`ACK error: ${err.message}`, true);
  }
}

async function acknowledgeAllAlarms() {
  if (isMonitoringUser()) return;
  const actor = state.currentUser
    ? `${state.currentUser.name} (${state.currentUser.role.toUpperCase()})`
    : "Operator";
  try {
    const updates = { "system/global_alarm": false };
    LOCKER_IDS.forEach((id) => {
      updates[`lockers/${id}/alarm/acknowledged`] = true;
      if (!state.lockers[id]?.sensor?.door_open) {
        updates[`lockers/${id}/alarm/door_left_open`] = false;
        updates[`lockers/${id}/alarm/forced_entry`] = false;
      }
    });
    await update(ref(db), updates);
    await push(ref(db, "logs/alarms"), {
      timestamp: Date.now(),
      locker_id: "SYSTEM",
      type: "INFO",
      message: `All Alarms ACKED by ${actor}`,
      acknowledged: true
    });
    showToast("All Alarms ACKED");
  } catch (err) {
    showToast(`ACK error: ${err.message}`, true);
  }
}

// ============================================================================
// Historical Logging (Every 5 Min to /history/locker_X, Max 288 Samples)
// ============================================================================
async function logHistorySnapshots(manualTrigger = false) {
  if (!state.connected || !canWriteAdminOrSensorRtdb()) return;
  const epochSec = String(Math.floor(Date.now() / 1000));
  const eStop = Boolean(state.system.emergency_stop);

  for (const id of LOCKER_IDS) {
    const locker = state.lockers[id];
    if (!locker) continue;
    const medId = locker.meta?.medicine_id || "med_general";
    const maxTemp = Number(state.medicineCatalog[medId]?.max_temp_alarm ?? 28.0);
    const temp = Number(locker.sensor?.temp ?? 25.0);
    const hum = Number(locker.sensor?.humidity ?? 55.0);
    const sp = Number(locker.pid?.setpoint ?? 25.0);
    const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
    const pwm = eStop ? 0 : Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;

    const sample = {
      temp: Number(temp.toFixed(1)),
      hum: Number(hum.toFixed(1)),
      pwm,
      sp: Number(sp.toFixed(1)),
      excursion: temp > maxTemp
    };

    try {
      await set(ref(db, `history/${id}/${epochSec}`), sample);

      // Prune beyond 288 samples (24h @ 5 min)
      const existingKeys = Object.keys(state.history[id] || {}).sort((a, b) => Number(a) - Number(b));
      if (existingKeys.length > MAX_HISTORY_SAMPLES) {
        const toDelete = existingKeys.slice(0, existingKeys.length - MAX_HISTORY_SAMPLES);
        for (const oldKey of toDelete) {
          await remove(ref(db, `history/${id}/${oldKey}`));
        }
      }
    } catch (_) {}
  }

  if (manualTrigger) {
    showToast(`Snapshot logged (${formatTime()})`);
  }
}

// ============================================================================
// Reports Tab Renderer & 24H History Chart (Chart.js Light Theme)
// ============================================================================
let reportChart = null;

function initReportChart() {
  if (!el.reportHistoryCanvas || typeof Chart === "undefined") return;
  const ctx = el.reportHistoryCanvas.getContext("2d");

  reportChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "SP (°C)",
          data: [],
          borderColor: "#6366F1",
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.1,
          yAxisID: "y"
        },
        {
          label: "Temp (°C)",
          data: [],
          borderColor: "#0D9488",
          backgroundColor: "rgba(13, 148, 136, 0.12)",
          borderWidth: 2.5,
          pointRadius: 2.5,
          fill: true,
          tension: 0.25,
          yAxisID: "y"
        },
        {
          label: "Humidity (%)",
          data: [],
          borderColor: "#0284C7",
          borderWidth: 1.8,
          borderDash: [3, 3],
          pointRadius: 1.5,
          fill: false,
          tension: 0.25,
          yAxisID: "y1"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 150 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#475569", font: { family: "JetBrains Mono, monospace", size: 11 } } }
      },
      scales: {
        x: { grid: { color: "#E2EEF3" }, ticks: { color: "#64748B", maxTicksLimit: 8, font: { family: "JetBrains Mono, monospace", size: 10 } } },
        y: { type: "linear", position: "left", title: { display: true, text: "Temp (°C)", color: "#0D9488", font: { family: "JetBrains Mono, monospace", size: 11 } }, grid: { color: "#E2EEF3" }, ticks: { color: "#64748B", font: { family: "JetBrains Mono, monospace", size: 10 } } },
        y1: { type: "linear", position: "right", min: 0, max: 100, title: { display: true, text: "Humidity (%)", color: "#0284C7", font: { family: "JetBrains Mono, monospace", size: 11 } }, grid: { drawOnChartArea: false }, ticks: { color: "#0284C7", font: { family: "JetBrains Mono, monospace", size: 10 } } }
      }
    }
  });
}

function getSortedHistoryEntries(lockerId) {
  const map = state.history[lockerId] || {};
  return Object.entries(map)
    .map(([ts, row]) => ({ ts: Number(ts), ...row }))
    .sort((a, b) => a.ts - b.ts);
}

function renderReportsView() {
  if (!el.reportSummaryBody) return;
  el.reportSummaryBody.textContent = "";

  let latestTs = 0;

  LOCKER_IDS.forEach((id, idx) => {
    const locker = state.lockers[id];
    const medId = locker?.meta?.medicine_id || "med_general";
    const maxTempAlarm = Number(state.medicineCatalog[medId]?.max_temp_alarm ?? 28.0);
    const entries = getSortedHistoryEntries(id);

    const temps = entries.map((e) => Number(e.temp)).filter(Number.isFinite);
    const hums = entries.map((e) => Number(e.hum)).filter(Number.isFinite);
    const excursionCount = entries.filter((e) => Boolean(e.excursion) || Number(e.temp) > maxTempAlarm).length;
    const excursionMin = excursionCount * 5;
    if (entries.length > 0 && entries[entries.length - 1].ts > latestTs) {
      latestTs = entries[entries.length - 1].ts;
    }

    const tempStats =
      temps.length > 0
        ? `${Math.min(...temps).toFixed(1)} / ${(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)} / ${Math.max(...temps).toFixed(1)}°C`
        : "-- / -- / --";
    const humStats =
      hums.length > 0
        ? `${Math.min(...hums).toFixed(0)} / ${(hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(0)} / ${Math.max(...hums).toFixed(0)}%`
        : "-- / -- / --";

    const pass = excursionMin === 0;
    const expStatus = getExpiryStatus(locker?.meta?.expiry_date);
    const expColor =
      expStatus.status === "EXPIRED" ? "text-red-600 font-bold" : expStatus.status === "EXP_SOON" ? "text-amber-700 font-bold" : "text-slate-600";

    const tr = document.createElement("tr");
    tr.className = idx % 2 === 0 ? "bg-white" : "bg-[#F8FBFD]";
    tr.innerHTML = `
      <td class="py-2.5 px-4 font-bold text-slate-900 whitespace-nowrap">${locker?.meta?.name || `Locker 0${idx + 1}`}</td>
      <td class="py-2.5 px-3 text-slate-700 whitespace-nowrap">
        <span class="font-bold text-teal-800">${locker?.meta?.medicine_name || "General Medicine"}</span>
        <span class="text-slate-400 text-[10px] block">${locker?.meta?.batch_no || "--"}</span>
      </td>
      <td class="py-2.5 px-3 whitespace-nowrap ${expColor}">${locker?.meta?.expiry_date || "--"}</td>
      <td class="py-2.5 px-2 text-right text-slate-600">${entries.length}</td>
      <td class="py-2.5 px-3 text-right font-semibold text-teal-800 whitespace-nowrap">${tempStats}</td>
      <td class="py-2.5 px-3 text-right font-semibold text-sky-700 whitespace-nowrap">${humStats}</td>
      <td class="py-2.5 px-3 text-right font-extrabold ${pass ? "text-emerald-700" : "text-red-600"}">${excursionMin} min</td>
      <td class="py-2.5 px-4 text-center">
        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${
          pass ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-300"
        }">${pass ? "PASS" : "EXCURSION"}</span>
      </td>
    `;
    el.reportSummaryBody.appendChild(tr);
  });

  el.reportLastLogged.textContent = latestTs ? `Last Log: ${formatDateTime(latestTs)}` : "Last Log: --";
  if (el.reportPrintMeta) {
    el.reportPrintMeta.textContent = `Generated: ${formatDateTime()} | Operator: ${state.currentUser?.name || "--"}`;
  }

  // Update Selected Locker History Chart & Log Table
  const selId = state.selectedReportLocker;
  document.querySelectorAll(".report-locker-tab").forEach((btn) => {
    const active = btn.dataset.reportLocker === selId;
    btn.className = active
      ? "report-locker-tab px-3 py-1 rounded-full font-bold bg-teal-600 text-white shadow-sm"
      : "report-locker-tab px-3 py-1 rounded-full font-semibold text-slate-600 hover:text-teal-700";
  });
  el.reportSampleBadge.textContent = (state.lockers[selId]?.meta?.name || selId).toUpperCase();

  const selEntries = getSortedHistoryEntries(selId);
  if (reportChart) {
    reportChart.data.labels = selEntries.map((e) => formatTime(e.ts));
    reportChart.data.datasets[0].data = selEntries.map((e) => Number(e.sp ?? 25));
    reportChart.data.datasets[1].data = selEntries.map((e) => Number(e.temp ?? 25));
    reportChart.data.datasets[2].data = selEntries.map((e) => Number(e.hum ?? 55));
    reportChart.update("none");
  }

  el.reportHistoryBody.textContent = "";
  if (selEntries.length === 0) {
    el.reportHistoryBody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-slate-400">No history logged.</td></tr>`;
  } else {
    const frag = document.createDocumentFragment();
    [...selEntries].reverse().slice(0, 100).forEach((row) => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-teal-50/40";
      tr.innerHTML = `
        <td class="py-2 px-3 text-slate-500 whitespace-nowrap">${formatDateTime(row.ts)}</td>
        <td class="py-2 px-2 text-right font-bold ${row.excursion ? "text-red-600" : "text-teal-700"}">${Number(row.temp).toFixed(1)}°C</td>
        <td class="py-2 px-2 text-right text-indigo-600">${Number(row.sp).toFixed(1)}°C</td>
        <td class="py-2 px-2 text-right text-sky-700">${Number(row.hum).toFixed(0)}%</td>
        <td class="py-2 px-2 text-right text-amber-600">${row.pwm ?? 0}%</td>
        <td class="py-2 px-3 text-center">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${
            row.excursion ? "bg-red-50 text-red-700 border border-red-200" : "bg-emerald-50 text-emerald-700 border border-emerald-200"
          }">${row.excursion ? "EXCURSION" : "PASS"}</span>
        </td>
      `;
      frag.appendChild(tr);
    });
    el.reportHistoryBody.appendChild(frag);
  }
}

// ============================================================================
// Chart.js — Clinical Light Mode PID Response Chart + Live PID Metrics
// ============================================================================
let pidChart = null;

function initPidChart() {
  if (!el.pidChartCanvas || typeof Chart === "undefined") return;
  const ctx = el.pidChartCanvas.getContext("2d");

  pidChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "SP (°C)", data: [], borderColor: "#6366F1", borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0.1, yAxisID: "y" },
        { label: "Temp (°C)", data: [], borderColor: "#0D9488", backgroundColor: "rgba(13, 148, 136, 0.10)", borderWidth: 2.5, pointRadius: 2.5, fill: true, tension: 0.25, yAxisID: "y" },
        { label: "PWM (%)", data: [], borderColor: "#F59E0B", backgroundColor: "rgba(245, 158, 11, 0.08)", borderWidth: 2, pointRadius: 2, fill: true, tension: 0.25, yAxisID: "y1" }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#475569", font: { family: "JetBrains Mono, monospace", size: 11 } } },
        tooltip: {
          backgroundColor: "rgba(255, 255, 255, 0.96)",
          titleColor: "#0F172A",
          bodyColor: "#334155",
          borderColor: "#DCEAF0",
          borderWidth: 1,
          titleFont: { family: "JetBrains Mono, monospace" },
          bodyFont: { family: "JetBrains Mono, monospace" }
        }
      },
      scales: {
        x: { grid: { color: "#E2EEF3" }, ticks: { color: "#64748B", maxTicksLimit: 8, font: { family: "JetBrains Mono, monospace", size: 10 } } },
        y: { type: "linear", position: "left", title: { display: true, text: "Temp / SP (°C)", color: "#0D9488", font: { family: "JetBrains Mono, monospace", size: 11 } }, grid: { color: "#E2EEF3" }, ticks: { color: "#64748B", font: { family: "JetBrains Mono, monospace", size: 10 } } },
        y1: { type: "linear", position: "right", min: 0, max: 100, title: { display: true, text: "PWM (%)", color: "#D97706", font: { family: "JetBrains Mono, monospace", size: 11 } }, grid: { drawOnChartArea: false }, ticks: { color: "#D97706", font: { family: "JetBrains Mono, monospace", size: 10 } } }
      }
    }
  });
}

function recordPidSample(lockerId) {
  const locker = state.lockers[lockerId];
  if (!locker) return;
  const sp = Number(locker.pid?.setpoint ?? 25.0);
  const pv = Number(locker.sensor?.temp ?? 25.0);
  const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
  const mv = Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;

  const series = state.pidSeries[lockerId];
  series.labels.push(formatTime());
  series.sp.push(sp);
  series.pv.push(pv);
  series.mv.push(mv);

  if (series.labels.length > MAX_PID_CHART_POINTS) {
    series.labels.shift();
    series.sp.shift();
    series.pv.shift();
    series.mv.shift();
  }
  if (state.selectedPidLocker === lockerId) updatePidChartView();
}

function updatePidChartView() {
  const id = state.selectedPidLocker;
  const locker = state.lockers[id];
  const series = state.pidSeries[id];
  if (!locker || !series) return;

  const sp = Number(locker.pid?.setpoint ?? 25.0);
  const pv = Number(locker.sensor?.temp ?? 25.0);
  const err = pv - sp;
  const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
  const pwm = Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;
  const rpm = Number(locker.sensor?.fan_rpm ?? 0);

  el.pidLiveSp.textContent = `${sp.toFixed(1)} °C`;
  el.pidLivePv.textContent = `${pv.toFixed(1)} °C`;
  el.pidLiveErr.textContent = `${err >= 0 ? "+" : ""}${err.toFixed(1)} °C`;
  el.pidLiveErr.className = err > 0.5 ? "text-amber-600 text-sm font-bold" : "text-teal-700 text-sm font-bold";
  el.pidLivePwm.textContent = `${pwm}% (${isManual ? "MAN" : "AUTO"})`;
  el.pidLiveRpm.textContent = `${rpm} RPM`;

  // V2 Live PID Performance Metrics
  if (series.pv.length > 0) {
    const last5 = series.pv.slice(-5);
    const meanLast5 = last5.reduce((a, b) => a + b, 0) / last5.length;
    const ess = meanLast5 - sp;
    const tMax = Math.max(...series.pv);
    const overshoot = sp > 0 ? Math.max(0, ((tMax - sp) / sp) * 100) : 0;
    const avgPwmLoad = series.mv.reduce((a, b) => a + b, 0) / series.mv.length;

    el.pidMetricEss.textContent = `${ess >= 0 ? "+" : ""}${ess.toFixed(2)} °C`;
    el.pidMetricEss.className =
      Math.abs(ess) <= 0.5
        ? "text-2xl font-extrabold font-mono-tabular text-emerald-700 mt-0.5 block"
        : "text-2xl font-extrabold font-mono-tabular text-amber-600 mt-0.5 block";

    el.pidMetricOvershoot.textContent = `${overshoot.toFixed(1)} %`;
    el.pidMetricOvershoot.className =
      overshoot <= 5
        ? "text-2xl font-extrabold font-mono-tabular text-indigo-600 mt-0.5 block"
        : "text-2xl font-extrabold font-mono-tabular text-red-600 mt-0.5 block";

    el.pidMetricPwm.textContent = `${avgPwmLoad.toFixed(1)} %`;
  } else {
    el.pidMetricEss.textContent = "-- °C";
    el.pidMetricOvershoot.textContent = "-- %";
    el.pidMetricPwm.textContent = "-- %";
  }

  if (pidChart) {
    pidChart.data.labels = [...series.labels];
    pidChart.data.datasets[0].data = [...series.sp];
    pidChart.data.datasets[1].data = [...series.pv];
    pidChart.data.datasets[2].data = [...series.mv];
    pidChart.update("none");
  }
}

function renderFanControlUi(modeStr, pwmVal) {
  const isManual = String(modeStr || "AUTO").toUpperCase() === "MANUAL";
  const clampedPwm = Math.min(100, Math.max(0, Math.round(Number(pwmVal) || 0)));
  el.btnPidModeAuto.className = !isManual
    ? "px-3 py-1 rounded-full font-bold bg-teal-600 text-white"
    : "px-3 py-1 rounded-full font-semibold text-slate-600 hover:text-teal-700";
  el.btnPidModeManual.className = isManual
    ? "px-3 py-1 rounded-full font-bold bg-amber-500 text-white"
    : "px-3 py-1 rounded-full font-semibold text-slate-600 hover:text-teal-700";
  el.sliderManualPwm.value = String(clampedPwm);
  el.labelManualPwm.textContent = `${clampedPwm}%`;
}

function populatePidFormForSelectedLocker(force = false) {
  const id = state.selectedPidLocker;
  const locker = state.lockers[id];
  if (!locker) return;

  el.pidTargetPath.textContent = `/lockers/${id}/pid`;
  el.pidSelectedBadge.textContent = (locker.meta?.name || id).toUpperCase();

  document.querySelectorAll(".pid-locker-tab").forEach((btn) => {
    const active = btn.dataset.pidLocker === id;
    btn.className = active
      ? "pid-locker-tab px-3 py-1 rounded-full font-bold bg-teal-600 text-white shadow-sm"
      : "pid-locker-tab px-3 py-1 rounded-full font-semibold text-slate-600 hover:text-teal-700";
  });

  const liveSp = Number(locker.pid?.setpoint ?? locker.control?.setpoint ?? 25.0);
  const liveKp = Number(locker.pid?.kp ?? 12.0);
  const liveKi = Number(locker.pid?.ki ?? 0.5);
  const liveKd = Number(locker.pid?.kd ?? 2.0);
  const switchedLocker = force || state.pidFormDirtyLocker !== id || state.lastRenderedPid.lockerId !== id;

  if (switchedLocker || (liveSp !== state.lastRenderedPid.setpoint && document.activeElement !== el.inputPidSp)) {
    el.inputPidSp.value = liveSp.toFixed(1);
    state.lastRenderedPid.setpoint = liveSp;
  }
  if (switchedLocker || (liveKp !== state.lastRenderedPid.kp && document.activeElement !== el.inputPidKp)) {
    el.inputPidKp.value = liveKp;
    state.lastRenderedPid.kp = liveKp;
  }
  if (switchedLocker || (liveKi !== state.lastRenderedPid.ki && document.activeElement !== el.inputPidKi)) {
    el.inputPidKi.value = liveKi;
    state.lastRenderedPid.ki = liveKi;
  }
  if (switchedLocker || (liveKd !== state.lastRenderedPid.kd && document.activeElement !== el.inputPidKd)) {
    el.inputPidKd.value = liveKd;
    state.lastRenderedPid.kd = liveKd;
  }
  state.pidFormDirtyLocker = id;
  state.lastRenderedPid.lockerId = id;

  // Fan Control Dirty/Editing Guard:
  // Do NOT overwrite mode buttons or slider while user is adjusting MANUAL mode/slider before clicking Apply!
  if (state.fanPendingEdit[id]) {
    const draft = state.fanDraft[id] || { mode: "MANUAL", pwm: 0 };
    renderFanControlUi(draft.mode, draft.pwm);
  } else {
    const liveMode = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL" ? "MANUAL" : "AUTO";
    const manualPwm = Number(locker.control?.manual_pwm ?? 0);
    state.fanDraft[id] = { mode: liveMode, pwm: manualPwm };
    renderFanControlUi(liveMode, manualPwm);
  }
}

function updateAssignSetpointPreview() {
  if (!el.assignSyncSpLabel) return;
  const medId = el.assignMedicineId.value;
  const med = state.medicineCatalog[medId];
  const targetSp = Number(med?.default_setpoint_temp);
  if (Number.isFinite(targetSp)) {
    el.assignSyncSpLabel.textContent = `Sync Default SP (→ ${targetSp.toFixed(1)}°C)`;
  } else {
    el.assignSyncSpLabel.textContent = "Sync Default SP";
  }
}

function populateAssignLockerFields(preserveSelection = false) {
  const lockerId = el.assignLockerId.value;
  const locker = state.lockers[lockerId];
  const prevSelectedMed = el.assignMedicineId.value;
  if (!locker) {
    updateAssignSetpointPreview();
    return;
  }

  if (preserveSelection && prevSelectedMed && state.medicineCatalog[prevSelectedMed]) {
    el.assignMedicineId.value = prevSelectedMed;
  } else {
    const lockerMedId = locker.meta?.medicine_id;
    if (lockerMedId && state.medicineCatalog[lockerMedId]) {
      el.assignMedicineId.value = lockerMedId;
    } else if (el.assignMedicineId.options.length > 0 && !el.assignMedicineId.value) {
      el.assignMedicineId.selectedIndex = 0;
    }
    el.assignBatchNo.value = locker.meta?.batch_no || "";
    el.assignExpiryDate.value = locker.meta?.expiry_date || "";
    if (el.assignAutoSetpoint && !preserveSelection) {
      el.assignAutoSetpoint.checked = true;
    }
  }
  updateAssignSetpointPreview();
}

function hydrateTelegramForm() {
  const tg = state.system.telegram || {};
  el.tgEnabled.checked = Boolean(tg.enabled);
  el.tgBotToken.value = tg.bot_token || "";
  el.tgChatId.value = tg.chat_id || "";
  el.tgCooldown.value = Number(tg.cooldown_sec ?? 60);
}

// ============================================================================
// Dashboard, Alarm Strip, Audit Log & Admin Tables Renderers
// ============================================================================
function renderConnectionStatus(connected) {
  if (isDemoMode) {
    state.connected = true;
    el.rtdbLed.className = "led-dot led-cyan";
    el.loginRtdbLed.className = "led-dot led-cyan";
    el.rtdbText.textContent = "DEMO MODE (SIMULATED)";
    el.loginRtdbText.textContent = "DEMO MODE (SIMULATED)";
    if (el.rtdbConnPill) {
      el.rtdbConnPill.className =
        "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-teal-50 border border-teal-300 text-teal-800 font-bold";
    }
    if (el.loginRtdbPill) {
      el.loginRtdbPill.className =
        "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-teal-50 border border-teal-300 text-xs font-mono-tabular";
    }
    return;
  }
  state.connected = connected;
  const ledClass = connected ? "led-dot led-green" : "led-dot led-red";
  el.rtdbLed.className = ledClass;
  el.loginRtdbLed.className = ledClass;
  el.rtdbText.textContent = connected ? "Firebase: Synced" : "Firebase: Offline";
  el.loginRtdbText.textContent = connected ? "Firebase: Synced" : "OFFLINE";
}

function renderDashboardLockers() {
  let onlineCount = 0;
  let tempSum = 0;
  let humSum = 0;
  let pwmSum = 0;
  let rpmSum = 0;
  let totalStock = 0;
  let anyDoorOpen = false;
  let activeAlarmCount = 0;
  let unackAlarmCount = 0;
  const eStop = Boolean(state.system.emergency_stop);

  LOCKER_IDS.forEach((id, idx) => {
    const locker = state.lockers[id];
    const rt = state.runtime[id];
    if (!locker) return;

    const online = isLockerOnline(id);
    if (online) onlineCount += 1;

    const medId = locker.meta?.medicine_id || "med_general";
    const medSpec = state.medicineCatalog[medId] || {
      name: locker.meta?.medicine_name || "General Medicine",
      category: locker.meta?.category || "Standard",
      default_setpoint_temp: locker.pid?.setpoint ?? locker.control?.setpoint ?? 25.0,
      max_temp_alarm: locker.meta?.max_temp_alarm ?? 28.0,
      max_hum_alarm: locker.meta?.max_hum_alarm ?? 70.0,
      min_stock_alarm: locker.meta?.min_stock_alarm ?? 5
    };

    const temp = Number(locker.sensor?.temp ?? 25.0);
    const hum = Number(locker.sensor?.humidity ?? 55.0);
    const sp = Number(locker.pid?.setpoint ?? locker.control?.setpoint ?? medSpec.default_setpoint_temp ?? 25.0);
    const err = temp - sp;
    const stock = Number(locker.meta?.stock ?? 0);
    const doorOpen = Boolean(locker.sensor?.door_open);
    const unlocked = Boolean(locker.control?.unlock_cmd);
    const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
    const rawPwm = Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;
    const pwm = eStop ? 0 : Math.min(100, Math.max(0, rawPwm));
    const rpm = eStop ? 0 : Number(locker.sensor?.fan_rpm ?? 0);
    const alarmObj = locker.alarm || {};
    const fanFault = Boolean(alarmObj.fan_fault);
    const forcedEntry = Boolean(alarmObj.forced_entry);
    const expInfo = getExpiryStatus(locker.meta?.expiry_date);

    tempSum += temp;
    humSum += hum;
    pwmSum += pwm;
    rpmSum += rpm;
    totalStock += stock;
    if (doorOpen) anyDoorOpen = true;

    const miniLed = document.getElementById(`mini-led-${id}`);
    if (miniLed) miniLed.className = online ? "led-dot led-green" : "led-dot led-red";
    const loginLed = document.getElementById(`login-led-${id}`);
    if (loginLed) loginLed.className = online ? "led-dot led-green" : "led-dot led-red";
    const loginSvgDot = document.getElementById(`login-svg-dot-${id}`);
    if (loginSvgDot) loginSvgDot.setAttribute("fill", online ? "#10B981" : "#EF4444");

    document.getElementById(`${id}-title`).textContent = locker.meta?.name || `Locker 0${idx + 1}`;
    document.getElementById(`${id}-med-name`).textContent = locker.meta?.medicine_name || medSpec.name;

    // Batch & Expiry display
    document.getElementById(`${id}-batch-val`).textContent = locker.meta?.batch_no || "--";
    const expValEl = document.getElementById(`${id}-exp-val`);
    const batchPill = document.getElementById(`${id}-batch-pill`);
    expValEl.textContent = locker.meta?.expiry_date || "--";
    if (expInfo.status === "EXPIRED") {
      expValEl.className = "text-red-700 font-extrabold";
      batchPill.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 border border-red-200 text-[10px] font-mono-tabular text-red-700";
    } else if (expInfo.status === "EXP_SOON") {
      expValEl.className = "text-amber-800 font-extrabold";
      batchPill.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-[10px] font-mono-tabular text-amber-800";
    } else {
      expValEl.className = "text-slate-800 font-bold";
      batchPill.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#F3F8FA] border border-[#E2EEF3] text-[10px] font-mono-tabular text-slate-600";
    }

    const statusLed = document.getElementById(`${id}-status-led`);
    const statusText = document.getElementById(`${id}-status-text`);
    const statusPill = document.getElementById(`${id}-status-pill`);
    statusLed.className = online ? "led-dot led-green" : "led-dot led-red";
    statusText.textContent = online ? "ONLINE" : "OFFLINE";
    statusPill.className = online
      ? "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-[10px] font-mono-tabular font-bold text-emerald-700"
      : "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-[10px] font-mono-tabular font-bold text-red-700";

    const hbSec = Math.max(0, Math.floor((Date.now() - rt.lastHbTime) / 1000));
    document.getElementById(`${id}-hb-text`).textContent = `${hbSec}s`;

    const doorBadge = document.getElementById(`${id}-door-badge`);
    if (forcedEntry) {
      doorBadge.textContent = "FORCED ENTRY";
      doorBadge.className = "px-2.5 py-0.5 rounded-full text-[11px] font-mono-tabular font-bold bg-red-600 text-white border border-red-700 animate-alarm-pulse";
    } else if (doorOpen || unlocked) {
      const openSec = rt.doorOpenedAt ? Math.floor((Date.now() - rt.doorOpenedAt) / 1000) : 0;
      doorBadge.textContent = doorOpen ? `OPEN (${openSec}s)` : "UNLOCKED";
      doorBadge.className =
        openSec > 30
          ? "px-2.5 py-0.5 rounded-full text-[11px] font-mono-tabular font-bold bg-red-100 text-red-800 border border-red-300 animate-alarm-pulse"
          : "px-2.5 py-0.5 rounded-full text-[11px] font-mono-tabular font-bold bg-amber-100 text-amber-800 border border-amber-300";
    } else {
      doorBadge.textContent = "CLOSED | LOCKED";
      doorBadge.className = "px-2.5 py-0.5 rounded-full text-[11px] font-mono-tabular font-bold bg-emerald-50 text-emerald-700 border border-emerald-200";
    }

    // Unlock button: Monitoring (View Only) vs RBAC Restricted vs Armed (Waiting for Door...) vs Normal Unlock
    const btnUnlock = document.getElementById(`${id}-btn-unlock`);
    const isMonitoring = isMonitoringUser();
    const allowed = canUserAccessLocker(id);
    const isArmed = Boolean(state.awaitingDoorOpen[id]);

    if (isMonitoring) {
      btnUnlock.disabled = true;
      btnUnlock.textContent = "View Only";
      btnUnlock.className =
        "w-full flex-1 py-2 px-3 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200 font-mono-tabular font-bold text-xs uppercase tracking-wider cursor-not-allowed";
    } else if (!allowed) {
      btnUnlock.disabled = true;
      btnUnlock.textContent = "Restricted";
      btnUnlock.className =
        "w-full flex-1 py-2 px-3 rounded-xl bg-slate-200 text-slate-500 border border-slate-300 font-mono-tabular font-bold text-xs uppercase tracking-wider cursor-not-allowed";
    } else if (isArmed) {
      btnUnlock.disabled = eStop;
      btnUnlock.textContent = "Waiting for Door...";
      btnUnlock.className =
        "w-full flex-1 py-2 px-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-mono-tabular font-bold text-xs uppercase tracking-wider shadow-sm animate-pulse transition disabled:opacity-40 disabled:cursor-not-allowed";
    } else {
      btnUnlock.disabled = eStop;
      btnUnlock.textContent = "Unlock";
      btnUnlock.className =
        "w-full flex-1 py-2 px-3 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-mono-tabular font-bold text-xs uppercase tracking-wider shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed";
    }

    const isOverTemp = temp > Number(medSpec.max_temp_alarm);
    const isWarm = temp > sp + 0.5;
    const tempValEl = document.getElementById(`${id}-temp-val`);
    tempValEl.textContent = `${temp.toFixed(1)}°C`;
    tempValEl.className = isOverTemp
      ? "text-2xl font-extrabold font-mono-tabular text-red-600"
      : isWarm
        ? "text-2xl font-extrabold font-mono-tabular text-amber-600"
        : "text-2xl font-extrabold font-mono-tabular text-slate-900";

    document.getElementById(`${id}-temp-err`).textContent = `${err >= 0 ? "+" : ""}${err.toFixed(1)}°C`;
    document.getElementById(`${id}-sp-label`).textContent = `SP: ${sp.toFixed(1)}°C`;

    const isHighHum = hum > Number(medSpec.max_hum_alarm);
    document.getElementById(`${id}-hum-val`).textContent = `${hum.toFixed(1)}%`;
    const humBadgeEl = document.getElementById(`${id}-hum-badge`);
    humBadgeEl.textContent = isHighHum ? "HIGH" : "OK";
    humBadgeEl.className = isHighHum
      ? "text-[10px] font-mono-tabular font-bold text-red-600"
      : "text-[10px] font-mono-tabular font-bold text-emerald-700";
    document.getElementById(`${id}-hum-limit`).textContent = `Max: ${Number(medSpec.max_hum_alarm).toFixed(0)}%`;

    const isLowStock = stock <= Number(medSpec.min_stock_alarm);
    const stockValEl = document.getElementById(`${id}-stock-val`);
    stockValEl.textContent = String(stock);
    stockValEl.className = isLowStock ? "text-amber-600 font-extrabold" : "text-teal-700 font-extrabold";
    document.getElementById(`${id}-min-stock`).textContent = `(Min: ${medSpec.min_stock_alarm})`;

    const modeBadge = document.getElementById(`${id}-mode-badge`);
    modeBadge.textContent = isManual ? "MANUAL" : "AUTO";
    modeBadge.className = isManual
      ? "px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 font-bold"
      : "px-2 py-0.5 rounded-full bg-teal-50 text-teal-800 border border-teal-200 font-bold";

    document.getElementById(`${id}-pid-gains`).textContent = `Kp:${locker.pid?.kp ?? 12} Ki:${locker.pid?.ki ?? 0.5}`;

    const rpmValEl = document.getElementById(`${id}-rpm-val`);
    const pwmValEl = document.getElementById(`${id}-pwm-val`);
    const dialRing = document.getElementById(`${id}-dial-ring`);
    const fanIcon = document.getElementById(`${id}-fan-icon`);

    if (fanFault) {
      rpmValEl.textContent = "FAN FAULT";
      rpmValEl.className = "text-red-600 font-extrabold";
      pwmValEl.textContent = `${pwm}%`;
      pwmValEl.className = "text-red-600";
      if (dialRing) {
        dialRing.style.strokeDashoffset = String(DIAL_CIRC * (1 - pwm / 100));
        dialRing.setAttribute("stroke", "#EF4444");
      }
      if (fanIcon) {
        fanIcon.style.animationPlayState = "paused";
        fanIcon.setAttribute("class", "absolute w-10 h-10 text-red-500 fan-rotor");
      }
    } else {
      rpmValEl.textContent = `${rpm} RPM`;
      rpmValEl.className = "text-teal-700";
      pwmValEl.textContent = `${pwm}%`;
      pwmValEl.className = "text-amber-600";
      if (dialRing) {
        dialRing.style.strokeDashoffset = String(DIAL_CIRC * (1 - pwm / 100));
        dialRing.setAttribute("stroke", isWarm ? "#F59E0B" : "#0D9488");
      }
      if (fanIcon) {
        if (pwm <= 0) {
          fanIcon.style.animationPlayState = "paused";
          fanIcon.setAttribute("class", "absolute w-10 h-10 text-slate-300 fan-rotor");
        } else {
          const dur = Math.max(0.28, 2.3 - (pwm / 100) * 1.95);
          fanIcon.style.animationDuration = `${dur.toFixed(2)}s`;
          fanIcon.style.animationPlayState = "running";
          fanIcon.setAttribute("class", `absolute w-10 h-10 ${isWarm ? "text-amber-500" : "text-teal-600"} fan-rotor`);
        }
      }
    }

    // Alarm & FEFO Badges
    const tags = [];
    if (forcedEntry) tags.push({ label: "FORCED ENTRY", level: "CRITICAL" });
    if (fanFault) tags.push({ label: "FAN FAULT", level: "DANGER" });
    if (expInfo.status === "EXPIRED") tags.push({ label: "EXPIRED", level: "DANGER" });
    else if (expInfo.status === "EXP_SOON") tags.push({ label: "EXP SOON", level: "WARN" });
    if (alarmObj.over_temp || isOverTemp) tags.push({ label: "HIGH TEMP", level: "DANGER" });
    else if (isWarm) tags.push({ label: "HIGH TEMP", level: "WARN" });
    if (alarmObj.high_hum || isHighHum) tags.push({ label: "HIGH HUMIDITY", level: "WARN" });
    if (alarmObj.door_left_open) tags.push({ label: "DOOR OPEN", level: "WARN" });
    if (alarmObj.low_stock || isLowStock) tags.push({ label: "LOW STOCK", level: "WARN" });
    if (!online) tags.push({ label: "OFFLINE", level: "WARN" });

    const tagsContainer = document.getElementById(`${id}-alarm-tags`);
    const btnAck = document.getElementById(`${id}-btn-ack`);
    tagsContainer.textContent = "";

    const hasHardAlarm =
      forcedEntry || fanFault || expInfo.status === "EXPIRED" || alarmObj.over_temp || isOverTemp || alarmObj.high_hum || isHighHum || alarmObj.door_left_open || alarmObj.low_stock || isLowStock;

    if (tags.length > 0) {
      if (hasHardAlarm) activeAlarmCount += 1;
      const isUnack = alarmObj.acknowledged === false && hasHardAlarm;
      if (isUnack) unackAlarmCount += 1;
      btnAck.classList.toggle("hidden", !isUnack || isMonitoringUser());

      tags.forEach((t) => {
        const span = document.createElement("span");
        if (t.level === "CRITICAL" || (isUnack && t.level === "DANGER")) {
          span.className = "px-2 py-0.5 rounded-full text-[10px] font-bold isa-unack-flash border";
        } else if (t.level === "DANGER") {
          span.className = "px-2 py-0.5 rounded-full bg-red-100 text-red-800 border border-red-300 text-[10px] font-bold";
        } else {
          span.className = "px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-bold";
        }
        span.textContent = t.label;
        tagsContainer.appendChild(span);
      });
    } else {
      btnAck.classList.add("hidden");
    }
  });

  const avgTemp = tempSum / 3;
  const avgHum = humSum / 3;
  const avgPwm = Math.round(pwmSum / 3);
  const avgRpm = Math.round(rpmSum / 3);

  el.kpiAvgTemp.textContent = `${avgTemp.toFixed(1)}°C`;
  setRingProgress(el.ringAvgTemp, ((avgTemp - 10) / 25) * 100);

  el.kpiAvgHum.textContent = `${avgHum.toFixed(0)}%`;
  setRingProgress(el.ringAvgHum, avgHum);

  if (el.kpiAvgFan) el.kpiAvgFan.textContent = `${avgPwm}%`;
  if (el.kpiAvgRpm) el.kpiAvgRpm.textContent = `${avgRpm} RPM`;
  setRingProgress(el.ringAvgFan, avgPwm);

  el.kpiTotalStock.textContent = String(totalStock);
  el.kpiDoorsStatus.textContent = anyDoorOpen ? "OPEN" : "CLOSED";
  el.kpiDoorsStatus.className = anyDoorOpen ? "font-bold text-amber-600" : "font-bold text-emerald-700";

  el.kpiOnlineCount.textContent = `(${onlineCount}/3)`;
  if (el.kpiInterlockState) {
    el.kpiInterlockState.textContent = eStop ? "LOCKED" : "READY";
    el.kpiInterlockState.className = eStop
      ? "text-xl font-extrabold font-mono-tabular text-red-600"
      : "text-xl font-extrabold font-mono-tabular text-emerald-700";
  }
  if (el.ringInterlock && el.ringInterlockText) {
    setRingProgress(el.ringInterlock, eStop ? 100 : (onlineCount / 3) * 100);
    el.ringInterlock.setAttribute("stroke", eStop ? "#EF4444" : "#10B981");
    el.ringInterlockText.textContent = eStop ? "LOCK" : "OK";
    el.ringInterlockText.className = eStop
      ? "absolute text-[10px] font-mono-tabular font-bold text-red-600"
      : "absolute text-[10px] font-mono-tabular font-bold text-emerald-700";
  }

  el.kpiActiveAlarms.textContent = String(activeAlarmCount);
  el.kpiActiveAlarms.className = activeAlarmCount > 0 ? "text-red-600 font-bold" : "text-emerald-700 font-bold";
  el.kpiUnackLabel.textContent = unackAlarmCount > 0 ? `(${unackAlarmCount} UNACK)` : "CLEAR";

  el.estopBanner.classList.toggle("hidden", !eStop);
  if (el.estopBannerReleaseBtn) {
    el.estopBannerReleaseBtn.classList.toggle("hidden", isMonitoringUser());
  }
  el.btnEstop.classList.toggle("estop-btn-engaged", eStop);
  el.btnEstopLabel.textContent = "E-STOP";

  if (eStop || activeAlarmCount > 0) {
    el.headerAlarmPill.className =
      "flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-50 border border-red-300 font-mono-tabular text-xs animate-alarm-pulse";
    el.headerAlarmLed.className = "led-dot led-red";
    el.headerAlarmText.textContent = eStop ? "E-STOP" : `${activeAlarmCount} ALARM`;
    el.headerAlarmText.className = "font-bold text-red-700";
    el.panelAlarmLed.className = "led-dot led-red";
  } else {
    el.headerAlarmPill.className =
      "flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 font-mono-tabular text-xs";
    el.headerAlarmLed.className = "led-dot led-green";
    el.headerAlarmText.textContent = "NORMAL";
    el.headerAlarmText.className = "font-bold text-emerald-700";
    el.panelAlarmLed.className = "led-dot led-green";
  }

  updateIsometricLockerSvg();
  renderActiveAlarmsStrip();
}

function renderActiveAlarmsStrip() {
  el.activeAlarmsStrip.textContent = "";
  let anyRendered = false;

  LOCKER_IDS.forEach((id) => {
    const locker = state.lockers[id];
    if (!locker) return;
    const alm = locker.alarm || {};
    const expInfo = getExpiryStatus(locker.meta?.expiry_date);
    const items = [];
    if (alm.forced_entry) items.push("FORCED ENTRY");
    if (alm.fan_fault) items.push("FAN FAULT");
    if (alm.expired_med || expInfo.status === "EXPIRED") items.push("EXPIRED");
    if (alm.over_temp) items.push("HIGH TEMP");
    if (alm.high_hum) items.push("HIGH HUMIDITY");
    if (alm.door_left_open) items.push("DOOR OPEN");
    if (alm.low_stock) items.push("LOW STOCK");

    if (items.length > 0) {
      anyRendered = true;
      const unack = alm.acknowledged === false;
      const row = document.createElement("div");
      row.className = `rounded-xl px-3 py-2 border flex items-center justify-between gap-2 text-xs font-mono-tabular ${
        unack ? "isa-unack-flash" : "bg-amber-50 border-amber-300 text-amber-900"
      }`;
      const info = document.createElement("div");
      info.innerHTML = `<strong class="uppercase">${locker.meta?.name || id}:</strong> ${items.join(" • ")} <span class="ml-1 text-[10px] font-bold">[${unack ? "UNACK" : "ACKED"}]</span>`;
      row.append(info);
      if (unack && !isMonitoringUser()) {
        const ackBtn = document.createElement("button");
        ackBtn.type = "button";
        ackBtn.className = "px-2.5 py-0.5 rounded-full bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold uppercase shrink-0";
        ackBtn.textContent = "ACK";
        ackBtn.addEventListener("click", () => acknowledgeLockerAlarms(id));
        row.append(ackBtn);
      }
      el.activeAlarmsStrip.appendChild(row);
    }
  });

  if (!anyRendered) {
    const empty = document.createElement("div");
    empty.className = "text-xs font-mono-tabular text-emerald-700 font-semibold py-0.5 flex items-center gap-2";
    empty.innerHTML = `<span class="led-dot led-green"></span> No Active Alarms`;
    el.activeAlarmsStrip.appendChild(empty);
  }
}

function renderAlarmHistoryTable() {
  el.alarmLogBody.textContent = "";
  if (state.alarmLogs.length === 0) {
    el.alarmLogBody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-slate-400">No alarms logged.</td></tr>`;
    return;
  }
  const frag = document.createDocumentFragment();
  state.alarmLogs.slice(0, 100).forEach((item) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-teal-50/40";
    tr.innerHTML = `
      <td class="py-2 px-3.5 text-slate-500 whitespace-nowrap">${formatTime(item.timestamp)}</td>
      <td class="py-2 px-2 font-bold text-slate-800 uppercase whitespace-nowrap">${item.locker_id || "SYSTEM"}</td>
      <td class="py-2 px-2 whitespace-nowrap">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${
          item.type === "INFO" ? "bg-teal-50 text-teal-700 border border-teal-200" : "bg-red-50 text-red-700 border border-red-200"
        }">${item.type || "ALARM"}</span>
      </td>
      <td class="py-2 px-3.5 text-slate-700">${item.message || ""}</td>
    `;
    frag.appendChild(tr);
  });
  el.alarmLogBody.appendChild(frag);
}

function renderTransactionsTable() {
  const filtered =
    state.txFilterLocker === "ALL"
      ? state.transactions
      : state.transactions.filter((t) => t.locker_id === state.txFilterLocker);

  el.txLogCount.textContent = String(state.transactions.length);
  el.txLogBody.textContent = "";

  if (filtered.length === 0) {
    el.txLogBody.innerHTML = `<tr><td colspan="8" class="py-8 text-center text-slate-400">No transactions recorded.</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  filtered.slice(0, 150).forEach((tx) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-teal-50/40 transition-colors";
    const act = normalizeActionLabel(tx.action);
    const badgeClass =
      act === "WITHDRAW"
        ? "bg-amber-50 text-amber-800 border border-amber-200"
        : act === "RESTOCK"
          ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
          : "bg-teal-50 text-teal-800 border border-teal-200";
    const qtyStr = act === "WITHDRAW" ? `-${tx.quantity}` : act === "RESTOCK" ? `+${tx.quantity}` : "0";

    tr.innerHTML = `
      <td class="py-2 px-3.5 text-slate-500 whitespace-nowrap">${formatDateTime(tx.timestamp)}</td>
      <td class="py-2 px-2.5 font-semibold text-slate-800 whitespace-nowrap">${tx.user_name || "--"}</td>
      <td class="py-2 px-2.5 font-bold text-teal-700 whitespace-nowrap">${tx.locker_name || tx.locker_id || "--"}</td>
      <td class="py-2 px-2.5 text-slate-800 whitespace-nowrap">${tx.medicine_name || "--"}</td>
      <td class="py-2 px-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeClass}">${act}</span></td>
      <td class="py-2 px-2 text-right font-bold text-slate-900 whitespace-nowrap">${qtyStr}</td>
      <td class="py-2 px-2 text-right font-extrabold text-teal-700 whitespace-nowrap">${tx.stock_after ?? "--"}</td>
      <td class="py-2 px-3.5 text-slate-600">${tx.notes || ""}</td>
    `;
    frag.appendChild(tr);
  });
  el.txLogBody.appendChild(frag);
}

function renderMedicineCatalogAdmin(highlightSlug = "") {
  const prevMed = highlightSlug || el.assignMedicineId.value;
  el.catalogTableBody.textContent = "";
  el.assignMedicineId.textContent = "";

  let highlightedRow = null;
  Object.entries(state.medicineCatalog).forEach(([id, med], idx) => {
    const spNum = Number(med.default_setpoint_temp ?? med.setpoint ?? med.target_temp ?? 25);
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `${med.name || id} (SP: ${spNum.toFixed(1)}°C)`;
    el.assignMedicineId.appendChild(opt);

    const tr = document.createElement("tr");
    const isHighlighted = Boolean(highlightSlug && id === highlightSlug);
    tr.dataset.medId = id;
    tr.title = "Click to select this medicine for Assign Locker";
    tr.className = isHighlighted
      ? "bg-teal-50 hover:bg-teal-100/70 cursor-pointer transition-colors"
      : idx % 2 === 0
        ? "bg-white hover:bg-teal-50/40 cursor-pointer transition-colors"
        : "bg-[#F8FBFD] hover:bg-teal-50/40 cursor-pointer transition-colors";
    tr.innerHTML = `
      <td class="py-2 px-3 text-slate-400">${id}</td>
      <td class="py-2 px-3 font-bold text-slate-900">${med.name || id}</td>
      <td class="py-2 px-2"><span class="px-2 py-0.5 rounded-full bg-teal-50 border border-teal-200 text-teal-800 text-[10px] font-bold">${med.category || "Room"}</span></td>
      <td class="py-2 px-2 text-right font-bold text-teal-700">${spNum.toFixed(1)}°C</td>
      <td class="py-2 px-2 text-right font-semibold text-red-600">${Number(med.max_temp_alarm ?? 28).toFixed(1)}°C</td>
      <td class="py-2 px-2 text-right text-sky-700">${Number(med.max_hum_alarm ?? 70).toFixed(0)}%</td>
      <td class="py-2 px-2 text-right font-semibold text-amber-700">${med.min_stock_alarm ?? 5}</td>
    `;
    tr.addEventListener("click", () => {
      el.assignMedicineId.value = id;
      if (el.assignAutoSetpoint) el.assignAutoSetpoint.checked = true;
      updateAssignSetpointPreview();
    });
    el.catalogTableBody.appendChild(tr);
    if (isHighlighted) highlightedRow = tr;
  });

  if (prevMed && state.medicineCatalog[prevMed]) {
    el.assignMedicineId.value = prevMed;
  }
  populateAssignLockerFields(Boolean(prevMed && state.medicineCatalog[prevMed]));

  if (highlightedRow) {
    highlightedRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function countOtherActiveAdmins(excludeUid) {
  return Object.entries(state.users).filter(([otherUid, rec]) => {
    if (otherUid === excludeUid) return false;
    return String(rec?.role || "").toLowerCase() === "admin" && rec?.active !== false;
  }).length;
}

function renderUsersAdmin() {
  el.usersTableBody.textContent = "";
  const currentUid = state.currentUser?.uid || "";

  Object.entries(state.users).forEach(([uid, u]) => {
    const rawRole = String(u.role || "operator").toLowerCase();
    const currentRole = rawRole === "admin" ? "admin" : rawRole === "monitoring" ? "monitoring" : "operator";
    const isAdmin = currentRole === "admin";
    const isMonitoring = currentRole === "monitoring";
    const isActive = u.active !== false;
    const isSelf = Boolean(currentUid && currentUid === uid);
    const allowed = u.allowed_lockers || { locker_1: true, locker_2: true, locker_3: true };

    const tr = document.createElement("tr");
    tr.className = "hover:bg-teal-50/40";
    const uidDisplay = u.rfid_uid ? `${uid} (${u.rfid_uid})` : uid;
    tr.innerHTML = `
      <td class="py-2 px-3 font-bold text-teal-700 whitespace-nowrap">${uidDisplay}</td>
      <td class="py-2 px-2 font-semibold text-slate-900 whitespace-nowrap">${u.name || "--"}${
        isSelf ? ' <span class="ml-1 px-1.5 py-0.5 rounded-full bg-teal-50 border border-teal-200 text-[9px] font-bold text-teal-700">YOU</span>' : ""
      }</td>
      <td class="py-2 px-2 whitespace-nowrap"></td>
      <td class="py-2 px-2 whitespace-nowrap"></td>
      <td class="py-2 px-2"><span class="font-bold ${isActive ? "text-emerald-600" : "text-red-600"}">${
        isActive ? "ACTIVE" : "OFF"
      }</span></td>
      <td class="py-2 px-2 text-right space-x-1 whitespace-nowrap"></td>
    `;

    // Inline Role Dropdown Pill (ADMIN = soft teal, OPERATOR = soft slate, MONITORING = soft indigo)
    const roleCell = tr.children[2];
    const roleSelect = document.createElement("select");
    roleSelect.setAttribute("aria-label", `Role for ${u.name || uid}`);
    roleSelect.disabled = isSelf;
    if (isSelf) roleSelect.title = "Cannot change own role";
    roleSelect.className = isAdmin
      ? "px-2 py-0.5 rounded-full text-[10px] font-mono-tabular font-bold uppercase bg-teal-50 text-teal-800 border border-teal-300 focus:outline-none focus:border-teal-500 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed transition"
      : isMonitoring
        ? "px-2 py-0.5 rounded-full text-[10px] font-mono-tabular font-bold uppercase bg-indigo-50 text-indigo-800 border border-indigo-300 focus:outline-none focus:border-indigo-500 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed transition"
        : "px-2 py-0.5 rounded-full text-[10px] font-mono-tabular font-bold uppercase bg-slate-100 text-slate-700 border border-slate-300 focus:outline-none focus:border-teal-500 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed transition";

    const optAdmin = document.createElement("option");
    optAdmin.value = "admin";
    optAdmin.textContent = "ADMIN";
    const optOperator = document.createElement("option");
    optOperator.value = "operator";
    optOperator.textContent = "OPERATOR";
    const optMonitoring = document.createElement("option");
    optMonitoring.value = "monitoring";
    optMonitoring.textContent = "MONITORING";
    roleSelect.append(optAdmin, optOperator, optMonitoring);
    roleSelect.value = currentRole;

    roleSelect.addEventListener("change", async () => {
      const nextRole = roleSelect.value;
      if (nextRole === currentRole) return;

      // Safety Interlock 1: Never allow changing own role
      if (isSelf) {
        roleSelect.value = currentRole;
        playAlertBeep(440, 220);
        showToast("Cannot change own role", true);
        return;
      }

      // Safety Interlock 2: Always preserve at least 1 active Admin
      if (isAdmin && nextRole !== "admin" && isActive && countOtherActiveAdmins(uid) < 1) {
        roleSelect.value = "admin";
        playAlertBeep(440, 260);
        showToast("At least 1 active Admin required", true);
        return;
      }

      const prevHadAnyLocker =
        u.allowed_lockers &&
        typeof u.allowed_lockers === "object" &&
        (u.allowed_lockers.locker_1 === true || u.allowed_lockers.locker_2 === true || u.allowed_lockers.locker_3 === true);

      const nextAllowed =
        nextRole === "admin"
          ? { locker_1: true, locker_2: true, locker_3: true }
          : nextRole === "monitoring"
            ? { locker_1: false, locker_2: false, locker_3: false }
            : !isMonitoring && prevHadAnyLocker
              ? {
                  locker_1: u.allowed_lockers.locker_1 !== false,
                  locker_2: u.allowed_lockers.locker_2 !== false,
                  locker_3: u.allowed_lockers.locker_3 !== false
                }
              : { locker_1: true, locker_2: true, locker_3: true };

      const targetName = u.name || uid;
      const actorUid = state.currentUser?.uid || "SYSTEM";
      const actorName = state.currentUser?.name || "Admin";
      const ts = Date.now();

      try {
        await update(ref(db, `users/${uid}`), {
          role: nextRole,
          allowed_lockers: nextAllowed
        });

        await push(ref(db, "logs/alarms"), {
          timestamp: ts,
          locker_id: "RBAC",
          type: "INFO",
          message: `Role updated: ${targetName} (${uid}) ${currentRole.toUpperCase()} -> ${nextRole.toUpperCase()} by ${actorName}`,
          acknowledged: true
        });

        await push(ref(db, "logs/role_changes"), {
          timestamp: ts,
          actor_uid: actorUid,
          actor_name: actorName,
          target_uid: uid,
          target_name: targetName,
          old_role: currentRole,
          new_role: nextRole
        });

        showToast(`Role updated: ${targetName} -> ${nextRole.toUpperCase()}`);
      } catch (err) {
        roleSelect.value = currentRole;
        showToast(`Role update failed: ${err.message}`, true);
      }
    });
    roleCell.appendChild(roleSelect);

    // Granular Per-Locker RBAC Checkboxes (L1, L2, L3), ALL (L1-L3) for Admin, or VIEW ONLY for Monitoring
    const accessCell = tr.children[3];
    if (isAdmin) {
      accessCell.innerHTML = `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-bold">ALL (L1-L3)</span>`;
    } else if (isMonitoring) {
      accessCell.innerHTML = `<span class="px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] font-bold">VIEW ONLY</span>`;
    } else {
      const wrap = document.createElement("div");
      wrap.className = "inline-flex items-center gap-2 text-[11px] font-bold text-slate-700";
      LOCKER_IDS.forEach((locId, idx) => {
        const lbl = document.createElement("label");
        lbl.className = "inline-flex items-center gap-1 cursor-pointer";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "accent-teal-600";
        cb.checked = allowed[locId] !== false;
        cb.addEventListener("change", async () => {
          await set(ref(db, `users/${uid}/allowed_lockers/${locId}`), cb.checked);
          showToast(`RBAC ${uid}: L${idx + 1} ${cb.checked ? "ON" : "OFF"}`);
        });
        lbl.append(cb, document.createTextNode(`L${idx + 1}`));
        wrap.appendChild(lbl);
      });
      accessCell.appendChild(wrap);
    }

    const actionCell = tr.lastElementChild;
    const btnToggle = document.createElement("button");
    btnToggle.type = "button";
    btnToggle.className = "px-2 py-0.5 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-200 text-[10px] font-semibold text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed";
    btnToggle.textContent = isActive ? "Disable" : "Enable";
    btnToggle.addEventListener("click", async () => {
      if (isActive && isAdmin && countOtherActiveAdmins(uid) < 1) {
        playAlertBeep(440, 260);
        showToast("At least 1 active Admin required", true);
        return;
      }
      if (isSelf && isActive) {
        playAlertBeep(440, 220);
        showToast("Cannot disable own account", true);
        return;
      }
      await set(ref(db, `users/${uid}/active`), !isActive);
      showToast(`${u.name || uid}: ${!isActive ? "ACTIVE" : "DISABLED"}`);
    });

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "px-2 py-0.5 rounded-lg bg-red-50 hover:bg-red-100 border border-red-200 text-[10px] font-semibold text-red-700 disabled:opacity-40 disabled:cursor-not-allowed";
    btnDel.textContent = "Delete";
    btnDel.addEventListener("click", async () => {
      if (isActive && isAdmin && countOtherActiveAdmins(uid) < 1) {
        playAlertBeep(440, 260);
        showToast("At least 1 active Admin required", true);
        return;
      }
      if (isSelf) {
        playAlertBeep(440, 220);
        showToast("Cannot delete own account", true);
        return;
      }
      await remove(ref(db, `users/${uid}`));
      showToast(`Deleted user: ${u.name || uid}`);
    });

    actionCell.append(btnToggle, btnDel);
    el.usersTableBody.appendChild(tr);
  });
}

function escapeCsvCell(val) {
  return `"${String(val ?? "").replace(/"/g, '""')}"`;
}

function downloadAoACsv(filename, aoaRows) {
  const csvLines = aoaRows.map((row) => {
    if (!Array.isArray(row) || row.length === 0 || (row.length === 1 && row[0] === "")) {
      return "";
    }
    return row.map(escapeCsvCell).join(",");
  });
  // Prepend UTF-8 BOM (\uFEFF) and Excel separator directive (sep=,) for Indonesian/European Excel locales
  const csvContent = "\uFEFFsep=,\r\n" + csvLines.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(filename, headers, rows) {
  downloadAoACsv(filename, [headers, ...rows]);
}

function buildComplianceReportData(nowTs = Date.now()) {
  const exporterName = state.currentUser?.name || "System";
  const exporterRole = String(state.currentUser?.role || "operator").toUpperCase();

  const summaryRows = [];
  const detailEntries = [];
  let minTs = Infinity;
  let maxTs = 0;

  LOCKER_IDS.forEach((id, idx) => {
    const locker = state.lockers[id] || {};
    const lockerName = locker.meta?.name || `Locker 0${idx + 1}`;
    const medId = locker.meta?.medicine_id || "med_general";
    const medName = locker.meta?.medicine_name || state.medicineCatalog[medId]?.name || "General Medicine";
    const batchNo = locker.meta?.batch_no || "--";
    const expiryDate = locker.meta?.expiry_date || "--";
    const maxTempAlarm = Number(state.medicineCatalog[medId]?.max_temp_alarm ?? 28.0);
    const liveSp = Number(locker.pid?.setpoint ?? 25.0);
    const liveTemp = Number(locker.sensor?.temp ?? 25.0);
    const liveHum = Number(locker.sensor?.humidity ?? 55.0);
    const isManual = String(locker.control?.mode || "AUTO").toUpperCase() === "MANUAL";
    const livePwm = state.system.emergency_stop
      ? 0
      : Number(isManual ? locker.control?.manual_pwm : locker.pid?.output_pwm) || 0;

    const entries = getSortedHistoryEntries(id);
    const effectiveEntries =
      entries.length > 0
        ? entries
        : [
            {
              ts: Math.floor(nowTs / 1000),
              temp: liveTemp,
              sp: liveSp,
              hum: liveHum,
              pwm: livePwm,
              excursion: liveTemp > maxTempAlarm
            }
          ];

    const temps = effectiveEntries.map((e) => Number(e.temp)).filter(Number.isFinite);
    const hums = effectiveEntries.map((e) => Number(e.hum)).filter(Number.isFinite);
    const excursionCount = entries.filter((e) => Boolean(e.excursion) || Number(e.temp) > maxTempAlarm).length;
    const excursionMin = excursionCount * 5;
    const complianceStatus = excursionMin === 0 ? "PASS" : "EXCURSION";

    const minTemp = temps.length > 0 ? Math.min(...temps).toFixed(1) : liveTemp.toFixed(1);
    const avgTemp =
      temps.length > 0 ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : liveTemp.toFixed(1);
    const maxTemp = temps.length > 0 ? Math.max(...temps).toFixed(1) : liveTemp.toFixed(1);
    const avgHum =
      hums.length > 0 ? (hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(1) : liveHum.toFixed(1);

    summaryRows.push([
      lockerName,
      medName,
      batchNo,
      expiryDate,
      liveSp.toFixed(1),
      minTemp,
      avgTemp,
      maxTemp,
      avgHum,
      String(excursionMin),
      complianceStatus
    ]);

    effectiveEntries.forEach((e) => {
      const tsMs = Number(e.ts) < 1e12 ? Number(e.ts) * 1000 : Number(e.ts);
      if (tsMs < minTs) minTs = tsMs;
      if (tsMs > maxTs) maxTs = tsMs;
      const rowTemp = Number(e.temp ?? liveTemp);
      const rowSp = Number(e.sp ?? liveSp);
      const rowHum = Number(e.hum ?? liveHum);
      const rowPwm = Number(e.pwm ?? 0);
      const isExcursion = Boolean(e.excursion) || rowTemp > maxTempAlarm;

      detailEntries.push({
        tsMs,
        lockerIdx: idx,
        row: [
          formatDateTime(tsMs),
          lockerName,
          rowTemp.toFixed(1),
          rowSp.toFixed(1),
          rowHum.toFixed(1),
          String(Math.round(rowPwm)),
          isExcursion ? "YES" : "NO"
        ]
      });
    });
  });

  detailEntries.sort((a, b) => b.tsMs - a.tsMs || a.lockerIdx - b.lockerIdx);

  const periodStr =
    minTs <= maxTs && Number.isFinite(minTs)
      ? `${formatDateTime(minTs)} to ${formatDateTime(maxTs)}`
      : `${formatDateTime(nowTs)} (Live Snapshot)`;

  const aoa = [
    // Block 1 — Report Metadata (Header Info)
    ["SMART MEDICINE LOCKER - COLD-CHAIN COMPLIANCE REPORT"],
    ["Export Date/Time", formatDateTime(nowTs)],
    ["Exported By", `${exporterName} (${exporterRole})`],
    ["Data Period", periodStr],
    [""],
    // Block 2 — Compliance Summary Table
    [
      "Locker",
      "Medicine Name",
      "Batch No",
      "Expiry Date",
      "Setpoint (°C)",
      "Min Temp (°C)",
      "Avg Temp (°C)",
      "Max Temp (°C)",
      "Avg Humidity (%)",
      "Excursion Time (min)",
      "Compliance Status"
    ],
    ...summaryRows,
    // 1 Blank Separator Row
    [""],
    // Block 3 — Detailed Telemetry Log Table
    ["Timestamp", "Locker", "Temp (°C)", "Setpoint (°C)", "Humidity (%)", "Fan PWM (%)", "Excursion"],
    ...detailEntries.map((d) => d.row)
  ];

  return {
    aoa,
    stamp: formatFilenameStamp(nowTs)
  };
}

function exportComplianceReportCsv() {
  const { aoa, stamp } = buildComplianceReportData(Date.now());
  const filename = `SCADA_Compliance_Report_${stamp}.csv`;
  downloadAoACsv(filename, aoa);
  showToast(`Exported CSV: ${filename}`);
}

function exportComplianceReportXlsx() {
  const { aoa, stamp } = buildComplianceReportData(Date.now());
  const filename = `SCADA_Compliance_Report_${stamp}.xlsx`;

  if (typeof window.XLSX === "undefined") {
    downloadAoACsv(`SCADA_Compliance_Report_${stamp}.csv`, aoa);
    showToast("Excel library unavailable — exported CSV fallback", true);
    return;
  }

  const ws = window.XLSX.utils.aoa_to_sheet(aoa);
  const colWidths = [];
  aoa.forEach((row, rowIdx) => {
    if (!Array.isArray(row)) return;
    // Skip title row when calculating column 0 width so column A stays compact
    if (rowIdx === 0) return;
    row.forEach((cell, colIdx) => {
      const len = String(cell ?? "").length;
      colWidths[colIdx] = Math.max(colWidths[colIdx] || 12, Math.min(34, len + 4));
    });
  });
  ws["!cols"] = colWidths.map((wch) => ({ wch }));

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Compliance Report");
  window.XLSX.writeFile(wb, filename);
  showToast(`Exported Excel: ${filename}`);
}

// ============================================================================
// Firebase Realtime Database Listeners (Role & Rule-Aware)
// ============================================================================
let publicRtdbListenersAttached = false;
let usersRtdbUnsubscribe = null;
let telegramRtdbUnsubscribe = null;

function detachProtectedUserListeners() {
  if (typeof usersRtdbUnsubscribe === "function") {
    usersRtdbUnsubscribe();
    usersRtdbUnsubscribe = null;
  }
  if (typeof telegramRtdbUnsubscribe === "function") {
    telegramRtdbUnsubscribe();
    telegramRtdbUnsubscribe = null;
  }
  state.tgFormHydrated = false;
}

function attachProtectedUserListeners(canReadTelegram = false) {
  if (!isFirebaseConfigured && !isDemoMode) return;

  if (typeof usersRtdbUnsubscribe !== "function") {
    usersRtdbUnsubscribe = onValue(ref(db, "users"), (snap) => {
      state.users = snap.val() || {};
      // Sync only the local user's own permissions/role without ever switching user session
      if (state.currentUser && state.currentUser.uid) {
        const liveSelf = state.users[state.currentUser.uid];
        if (!liveSelf && Object.keys(state.users).length > 0 && isDemoMode) {
          clearSession();
          navigateToView("login");
          showToast("Session ended: Account removed.", true);
        } else if (liveSelf) {
          if (liveSelf.active === false) {
            clearSession();
            if (isFirebaseConfigured && auth) {
              signOut(auth).catch(() => {});
            }
            navigateToView("login");
            showToast("Session ended: Account disabled.", true);
          } else {
            const isPublicAcct =
              String(auth?.currentUser?.email || "").toLowerCase() === "public@locker.local" ||
              String(liveSelf.username || "").toLowerCase() === "public";
            const prevRole = state.currentUser.role;
            const nextRole = isPublicAcct
              ? "monitoring"
              : String(liveSelf.role || state.currentUser.role).toLowerCase();
            saveSession({
              ...state.currentUser,
              name: liveSelf.name || state.currentUser.name,
              role: nextRole,
              allowed_lockers: isPublicAcct
                ? { locker_1: false, locker_2: false, locker_3: false }
                : liveSelf.allowed_lockers || state.currentUser.allowed_lockers
            });

            if (prevRole !== nextRole) {
              if (nextRole === "monitoring" && state.interlock.active) {
                state.interlock.active = false;
                state.interlock.lockerId = null;
                clearInterval(state.interlock.timerId);
                localStorage.removeItem(STORAGE_INTERLOCK_KEY);
                el.inventoryModal.classList.add("hidden");
              }
              if (nextRole !== "admin" && typeof telegramRtdbUnsubscribe === "function") {
                telegramRtdbUnsubscribe();
                telegramRtdbUnsubscribe = null;
              }
              if (nextRole !== "admin" && (state.currentView === "admin" || state.currentView === "simulator")) {
                navigateToView("dashboard");
                showToast(`Role updated to ${nextRole.toUpperCase()} — redirected to Overview`, true);
              } else {
                navigateToView(state.currentView);
                showToast(`Role updated: ${nextRole.toUpperCase()}`);
              }
            }
          }
        }
      }
      renderUsersAdmin();
      renderDashboardLockers();
    });
  }

  // Only Admin (or Demo Mode) reads /system/telegram — Operator & Public Monitoring NEVER read /system/telegram
  if ((canReadTelegram || isDemoMode) && typeof telegramRtdbUnsubscribe !== "function") {
    telegramRtdbUnsubscribe = onValue(ref(db, "system/telegram"), (snap) => {
      const tg = snap.val();
      if (!tg) return;
      state.system.telegram = {
        enabled: Boolean(tg.enabled),
        bot_token: tg.bot_token || "",
        chat_id: tg.chat_id || "",
        cooldown_sec: Number(tg.cooldown_sec ?? 60)
      };
      if (!state.tgFormHydrated) {
        hydrateTelegramForm();
        state.tgFormHydrated = true;
      }
    });
  }
}

function attachRtdbListeners() {
  if (!isFirebaseConfigured && !isDemoMode) return;
  if (publicRtdbListenersAttached) return;
  publicRtdbListenersAttached = true;

  onValue(ref(db, ".info/connected"), (snap) => renderConnectionStatus(snap.val() === true));

  onValue(ref(db, "auth/enroll_until"), (snap) => {
    state.authEnrollUntil = Number(snap.val() || 0);
  });

  onValue(ref(db, "system/emergency_stop"), (snap) => {
    state.system.emergency_stop = Boolean(snap.val());
    renderDashboardLockers();
  });

  onValue(ref(db, "system/global_alarm"), (snap) => {
    state.system.global_alarm = Boolean(snap.val());
    renderDashboardLockers();
  });

  if (isDemoMode) {
    attachProtectedUserListeners(true);
  }

  onValue(ref(db, "medicine_catalog"), (snap) => {
    state.medicineCatalog = snap.val() || {};
    renderMedicineCatalogAdmin();
    renderDashboardLockers();
    if (state.currentView === "reports") renderReportsView();
  });

  LOCKER_IDS.forEach((id) => {
    onValue(ref(db, `lockers/${id}`), (snap) => {
      const val = snap.val();
      if (!val) return;

      const rt = state.runtime[id];
      const incomingHb = val.meta?.heartbeat;
      if (incomingHb !== undefined) {
        if (rt.lastHbVal === null) {
          rt.lastHbVal = incomingHb;
          rt.lastHbTime = Date.now() - (HEARTBEAT_TIMEOUT_MS - 6000);
        } else if (incomingHb !== rt.lastHbVal) {
          rt.lastHbVal = incomingHb;
          rt.lastHbTime = Date.now();
        }
      }

      if (Boolean(val.control?.unlock_cmd)) {
        rt.lastAuthorizedUnlockAt = Date.now();
        rt.authorizedOpenSession = true;
      }

      const incomingDoor = Boolean(val.sensor?.door_open);
      const wasDoorOpen = rt.prevDoorOpen;
      if (incomingDoor && wasDoorOpen === false) {
        rt.doorOpenedAt = Date.now();
      } else if (!incomingDoor) {
        if (wasDoorOpen === true) {
          rt.doorClosedAt = Date.now();
        }
        rt.doorOpenedAt = null;
        if (rt.forcedEntryTimer) {
          clearTimeout(rt.forcedEntryTimer);
          rt.forcedEntryTimer = null;
        }
      }
      rt.prevDoorOpen = incomingDoor;

      state.lockers[id] = val;

      // Stage 2 Trigger: ONLY open Mandatory Inventory Modal when armed (awaitingDoorOpen)
      if (incomingDoor && state.awaitingDoorOpen[id]) {
        rt.authorizedOpenSession = true;
        disarmLockerUnlock(id, false);
        if (state.currentUser && !state.interlock.active) {
          triggerInventoryInterlock(id, "ARMED_DOOR_OPEN");
        }
      } else if (
        incomingDoor &&
        wasDoorOpen === false &&
        !state.awaitingDoorOpen[id] &&
        !rt.authorizedOpenSession &&
        !Boolean(val.control?.unlock_cmd) &&
        !Boolean(val.alarm?.forced_entry) &&
        Date.now() - rt.lastAuthorizedUnlockAt > UNLOCK_ARMED_TIMEOUT_MS &&
        Date.now() - rt.doorClosedAt > 2000
      ) {
        // Unauthorized door open outside authorized session & 2s post-close grace:
        // Confirm door stays open >= 500ms continuously before triggering FORCED ENTRY
        if (rt.forcedEntryTimer) clearTimeout(rt.forcedEntryTimer);
        rt.forcedEntryTimer = setTimeout(() => {
          rt.forcedEntryTimer = null;
          if (
            Boolean(state.lockers[id]?.sensor?.door_open) &&
            !state.awaitingDoorOpen[id] &&
            !rt.authorizedOpenSession &&
            !Boolean(state.lockers[id]?.alarm?.forced_entry)
          ) {
            triggerForcedEntryAlarm(id);
          }
        }, 500);
      }

      // Clear authorizedOpenSession only after door is closed and 2s grace has passed
      if (!incomingDoor && rt.authorizedOpenSession) {
        setTimeout(() => {
          if (!Boolean(state.lockers[id]?.sensor?.door_open) && Date.now() - rt.lastAuthorizedUnlockAt > 2000) {
            rt.authorizedOpenSession = false;
          }
        }, 2200);
      }

      recordPidSample(id);
      evaluateLockerAlarms(id);
      renderDashboardLockers();

      if (state.currentView === "admin" && state.selectedPidLocker === id) {
        populatePidFormForSelectedLocker(false);
        updatePidChartView();
      }
      if (state.currentView === "reports") {
        renderReportsView();
      }
    });

    // Historical Logging Listener (/history/locker_X)
    onValue(ref(db, `history/${id}`), (snap) => {
      state.history[id] = snap.val() || {};
      if (state.currentView === "reports") {
        renderReportsView();
      }
    });
  });

  onValue(ref(db, "logs/transactions"), (snap) => {
    const val = snap.val() || {};
    state.transactions = Object.values(val).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    renderTransactionsTable();
  });

  onValue(ref(db, "logs/alarms"), (snap) => {
    const val = snap.val() || {};
    state.alarmLogs = Object.values(val).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    renderAlarmHistoryTable();
  });
}

// ============================================================================
// Event Bindings
// ============================================================================
function bindEvents() {
  el.panelLoginManual.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rawUser = el.loginUsername.value.trim().toLowerCase();
    const uPass = el.loginPassword.value;
    if (!rawUser || !uPass) return;

    if (isDemoMode) {
      const uName = rawUser.includes("@") ? rawUser.split("@")[0] : rawUser;
      const found = Object.entries(state.users).find(
        ([, u]) =>
          String(u.username || "").trim().toLowerCase() === uName &&
          u.password === uPass &&
          u.active !== false
      );
      if (found) {
        loginWithUser(found[0], found[1], true);
      } else {
        playAlertBeep(360, 300);
        el.loginAlert.textContent = "Access Denied: Invalid credentials.";
        el.loginAlert.classList.remove("hidden");
      }
      return;
    }

    const email = rawUser.includes("@") ? rawUser : `${rawUser}@locker.local`;
    el.loginAlert.classList.add("hidden");
    try {
      const cred = await signInWithEmailAndPassword(auth, email, uPass);
      el.loginPassword.value = "";
      await resolveAndCompleteFirebaseLogin(cred.user, true);
    } catch (_) {
      playAlertBeep(360, 300);
      el.loginAlert.textContent = "Access Denied: Invalid credentials.";
      el.loginAlert.classList.remove("hidden");
    }
  });

  // Interactive Demo Mode 1-Click Login Buttons (Visible ONLY when isDemoMode === true)
  if (isDemoMode && el.demoLoginBox) {
    el.demoLoginBox.classList.remove("hidden");
    if (el.btnDemoLoginAdmin) {
      el.btnDemoLoginAdmin.addEventListener("click", () => {
        const adminEntry =
          Object.entries(state.users).find(([, u]) => String(u.role || "").toLowerCase() === "admin" && u.active !== false) || [
            "DEMO_ADMIN_01",
            DEFAULT_SPEC_DATA.users.DEMO_ADMIN_01
          ];
        playAlertBeep(1040, 140);
        loginWithUser(adminEntry[0], adminEntry[1]);
      });
    }
    if (el.btnDemoLoginOperator) {
      el.btnDemoLoginOperator.addEventListener("click", () => {
        const opEntry =
          Object.entries(state.users).find(([, u]) => String(u.role || "").toLowerCase() === "operator" && u.active !== false) || [
            "DEMO_OP_01",
            DEFAULT_SPEC_DATA.users.DEMO_OP_01
          ];
        playAlertBeep(1040, 140);
        loginWithUser(opEntry[0], opEntry[1]);
      });
    }
  }

  // Navigation Tabs
  el.navBtnDashboard.addEventListener("click", () => navigateToView("dashboard"));
  el.navBtnReports.addEventListener("click", () => navigateToView("reports"));
  el.navBtnAdmin.addEventListener("click", () => navigateToView("admin", false));
  if (el.navBtnCatalog) el.navBtnCatalog.addEventListener("click", () => navigateToView("admin", true));
  if (el.navBtnSimulator) el.navBtnSimulator.addEventListener("click", () => navigateToView("simulator"));
  el.btnBackDashboard.addEventListener("click", () => navigateToView("dashboard"));
  if (el.btnSimBackDashboard) el.btnSimBackDashboard.addEventListener("click", () => navigateToView("dashboard"));

  el.btnLogout.addEventListener("click", async () => {
    if (state.interlock.active) {
      showInterlockIgnoredWarning();
      return;
    }
    clearSession();
    if (isFirebaseConfigured && auth) {
      detachProtectedUserListeners();
      try {
        await signOut(auth);
      } catch (_) {}
      await ensureAnonymousLoginScreenAuth();
    }
    navigateToView("login");
  });

  // Reports Tab Actions
  document.querySelectorAll(".report-locker-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedReportLocker = btn.dataset.reportLocker;
      renderReportsView();
    });
  });

  el.btnLogSnapshotNow.addEventListener("click", () => logHistorySnapshots(true));

  el.btnExportReportCsv.addEventListener("click", exportComplianceReportCsv);
  if (el.btnExportReportXlsx) {
    el.btnExportReportXlsx.addEventListener("click", exportComplianceReportXlsx);
  }

  el.btnPrintReport.addEventListener("click", () => {
    renderReportsView();
    window.print();
  });

  // Heartbeat Simulator Toggle (Inside Admin Simulator View)
  el.btnToggleHbSim.addEventListener("click", async () => {
    state.heartbeatSimEnabled = !state.heartbeatSimEnabled;
    el.btnToggleHbSim.textContent = state.heartbeatSimEnabled ? "HB Sim: ON" : "HB Sim: OFF";
    el.btnToggleHbSim.className = state.heartbeatSimEnabled
      ? "px-3.5 py-1.5 rounded-full bg-teal-600 hover:bg-teal-700 text-white text-xs font-mono-tabular font-bold uppercase shadow-sm transition"
      : "px-3.5 py-1.5 rounded-full bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-800 text-xs font-mono-tabular font-bold uppercase transition";

    if (state.heartbeatSimEnabled && state.connected) {
      const nowSec = Math.floor(Date.now() / 1000);
      const updates = {};
      LOCKER_IDS.forEach((id) => {
        state.runtime[id].lastHbTime = Date.now();
        updates[`lockers/${id}/meta/status`] = "online";
        updates[`lockers/${id}/meta/heartbeat`] = nowSec;
      });
      renderDashboardLockers();
      try {
        await update(ref(db), updates);
      } catch (_) {}
    }
  });

  // Alarms & Audit Log CSV
  el.btnKpiAckAll.addEventListener("click", acknowledgeAllAlarms);
  el.btnAckAllAlarms.addEventListener("click", acknowledgeAllAlarms);
  el.btnExportAlarms.addEventListener("click", () => {
    downloadCsv(
      `scada-alarms-${Date.now()}.csv`,
      ["Time", "Locker", "Type", "Alarm"],
      state.alarmLogs.map((a) => [formatDateTime(a.timestamp), a.locker_id, a.type, a.message])
    );
  });

  el.txFilterLocker.addEventListener("change", (e) => {
    state.txFilterLocker = e.target.value;
    renderTransactionsTable();
  });

  el.btnExportTx.addEventListener("click", () => {
    downloadCsv(
      `scada-audit-log-${Date.now()}.csv`,
      ["Time", "User", "UID", "Role", "Locker", "Item", "Batch", "Action", "Qty", "Stock Before", "Stock", "Note"],
      state.transactions.map((t) => [
        formatDateTime(t.timestamp),
        t.user_name,
        t.user_uid,
        t.role,
        t.locker_name,
        t.medicine_name,
        t.batch_no || "",
        normalizeActionLabel(t.action),
        t.quantity,
        t.stock_before,
        t.stock_after,
        t.notes
      ])
    );
  });

  // Mandatory Inventory Modal
  el.inventoryModal.addEventListener("click", (e) => {
    if (e.target === el.inventoryModal) showInterlockIgnoredWarning();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.interlock.active) {
        e.preventDefault();
        showInterlockIgnoredWarning();
      } else {
        el.estopModal.classList.add("hidden");
      }
    }
  });

  document.querySelectorAll("[data-qty-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (getSelectedInventoryAction() === "INSPECT") return;
      const delta = Number(btn.dataset.qtyAdd) || 1;
      const cur = Math.max(0, Math.floor(Number(el.invQuantity.value) || 0));
      el.invQuantity.value = String(cur + delta);
      resetInterlockIdleTimerOnInput();
      updateInventoryFormPreview();
    });
  });

  document.querySelectorAll("[data-qty-reset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (getSelectedInventoryAction() === "INSPECT") return;
      el.invQuantity.value = "1";
      resetInterlockIdleTimerOnInput();
      updateInventoryFormPreview();
    });
  });

  el.formInventoryInterlock.querySelectorAll('input[name="inv_action"]').forEach((r) => {
    r.addEventListener("change", () => {
      resetInterlockIdleTimerOnInput();
      updateInventoryFormPreview();
    });
  });
  el.invQuantity.addEventListener("input", () => {
    resetInterlockIdleTimerOnInput();
    updateInventoryFormPreview();
  });
  el.invNotes.addEventListener("input", resetInterlockIdleTimerOnInput);
  el.formInventoryInterlock.addEventListener("submit", handleInventorySubmit);

  // E-STOP Modal + Telegram Alert
  const openEstopModal = () => {
    if (isMonitoringUser()) {
      playAlertBeep(440, 220);
      showToast("View Only: Monitoring account", true);
      return;
    }
    const active = state.system.emergency_stop;
    el.estopModalTitle.textContent = active ? "Release E-STOP" : "Confirm E-STOP";
    el.estopModalDesc.textContent = active
      ? "Release E-STOP and restore locker controls?"
      : "Engage E-STOP and lock all actuators?";
    el.estopModalConfirm.textContent = active ? "Release" : "Confirm";
    el.estopModal.classList.remove("hidden");
  };

  el.btnEstop.addEventListener("click", openEstopModal);
  el.estopBannerReleaseBtn.addEventListener("click", openEstopModal);
  el.estopModalCancel.addEventListener("click", () => el.estopModal.classList.add("hidden"));
  el.estopModalConfirm.addEventListener("click", async () => {
    el.estopModal.classList.add("hidden");
    const nextState = !state.system.emergency_stop;
    const updates = { "system/emergency_stop": nextState, "system/global_alarm": nextState };
    if (nextState) {
      LOCKER_IDS.forEach((id) => {
        updates[`lockers/${id}/control/unlock_cmd`] = false;
        updates[`lockers/${id}/control/manual_pwm`] = 0;
        if (canWriteAdminOrSensorRtdb()) {
          updates[`lockers/${id}/pid/output_pwm`] = 0;
        }
      });
    }
    await update(ref(db), updates);
    await push(ref(db, "logs/alarms"), {
      timestamp: Date.now(),
      locker_id: "SYSTEM",
      type: nextState ? "CRITICAL" : "INFO",
      message: nextState ? `E-STOP Engaged (${state.currentUser?.name || "Operator"})` : "E-STOP Released",
      acknowledged: !nextState
    });
    if (nextState) {
      sendTelegramAlert("system_estop", `CRITICAL — E-STOP ENGAGED by ${state.currentUser?.name || "Operator"}!`);
    }
  });

  // Admin: PID Tuning
  document.querySelectorAll(".pid-locker-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedPidLocker = btn.dataset.pidLocker;
      populatePidFormForSelectedLocker(true);
      updatePidChartView();
    });
  });

  el.formPidTuning.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.currentUser?.role !== "admin") return;
    const id = state.selectedPidLocker;
    const sp = Number(el.inputPidSp.value);
    const kp = Number(el.inputPidKp.value);
    const ki = Number(el.inputPidKi.value);
    const kd = Number(el.inputPidKd.value);
    const pv = Number(state.lockers[id]?.sensor?.temp ?? sp);
    const computedPwm = Math.min(100, Math.max(0, Math.round(Math.max(0, pv - sp) * kp)));

    try {
      await update(ref(db, `lockers/${id}/pid`), { setpoint: sp, kp, ki, kd, output_pwm: computedPwm });
      if (state.lockers[id]) {
        state.lockers[id].pid = { ...(state.lockers[id].pid || {}), setpoint: sp, kp, ki, kd, output_pwm: computedPwm };
      }
      populatePidFormForSelectedLocker(true);
      updatePidChartView();
      renderDashboardLockers();
      showToast(`PID Saved: ${id.toUpperCase()} (SP=${sp.toFixed(1)}°C)`);
    } catch (err) {
      playAlertBeep(440, 260);
      showToast(`PID Save Failed: ${err?.message || "Permission denied"}`, true);
    }
  });

  el.btnPidModeAuto.addEventListener("click", async () => {
    if (state.currentUser?.role !== "admin") return;
    const id = state.selectedPidLocker;
    const savedPwm = Number(state.lockers[id]?.control?.manual_pwm ?? 0);
    state.fanDraft[id] = { mode: "AUTO", pwm: savedPwm };
    try {
      await set(ref(db, `lockers/${id}/control/mode`), "AUTO");
      if (state.lockers[id]) {
        state.lockers[id].control = { ...(state.lockers[id].control || {}), mode: "AUTO" };
      }
      state.fanPendingEdit[id] = false;
      renderFanControlUi("AUTO", savedPwm);
      renderDashboardLockers();
      updatePidChartView();
      showToast(`${id.toUpperCase()} Mode: AUTO`);
    } catch (err) {
      showToast(`Mode Change Failed: ${err?.message || "Permission denied"}`, true);
    }
  });

  el.btnPidModeManual.addEventListener("click", () => {
    if (state.currentUser?.role !== "admin") return;
    const id = state.selectedPidLocker;
    const liveMode = String(state.lockers[id]?.control?.mode || "AUTO").toUpperCase() === "MANUAL" ? "MANUAL" : "AUTO";
    const livePwm = Number(state.lockers[id]?.control?.manual_pwm ?? 0);
    const currentSliderPwm = Number(el.sliderManualPwm.value);
    const nextPwm = state.fanPendingEdit[id] ? currentSliderPwm : livePwm;

    state.fanDraft[id] = { mode: "MANUAL", pwm: nextPwm };
    // Lock slider & mode UI until user clicks Apply (or reverts to AUTO)
    state.fanPendingEdit[id] = true;
    renderFanControlUi("MANUAL", nextPwm);
    showToast(`${id.toUpperCase()}: Adjust Manual PWM & click Apply`);
  });

  const beginFanSliderEdit = () => {
    if (state.currentUser?.role !== "admin") return;
    const id = state.selectedPidLocker;
    const pwm = Number(el.sliderManualPwm.value);
    state.fanPendingEdit[id] = true;
    state.fanDraft[id] = { mode: "MANUAL", pwm };
    renderFanControlUi("MANUAL", pwm);
  };

  el.sliderManualPwm.addEventListener("pointerdown", beginFanSliderEdit);
  el.sliderManualPwm.addEventListener("mousedown", beginFanSliderEdit);
  el.sliderManualPwm.addEventListener("touchstart", beginFanSliderEdit, { passive: true });
  el.sliderManualPwm.addEventListener("input", beginFanSliderEdit);

  el.btnApplyManualPwm.addEventListener("click", async () => {
    if (state.currentUser?.role !== "admin") return;
    const id = state.selectedPidLocker;
    const pwm = Math.min(100, Math.max(0, Math.round(Number(el.sliderManualPwm.value) || 0)));
    const patch = {
      "control/mode": "MANUAL",
      "control/manual_pwm": pwm
    };
    if (isDemoMode) {
      patch["sensor/fan_rpm"] = Math.round((pwm / 100) * 2800);
    }

    try {
      await update(ref(db, `lockers/${id}`), patch);
      if (state.lockers[id]) {
        state.lockers[id].control = {
          ...(state.lockers[id].control || {}),
          mode: "MANUAL",
          manual_pwm: pwm
        };
      }
      state.fanDraft[id] = { mode: "MANUAL", pwm };
      state.fanPendingEdit[id] = false;
      renderFanControlUi("MANUAL", pwm);
      renderDashboardLockers();
      updatePidChartView();
      showToast(`Manual PWM Applied: ${id.toUpperCase()} (${pwm}%)`);
    } catch (err) {
      showToast(`Manual PWM Failed: ${err?.message || "Permission denied"}`, true);
    }
  });

  // Admin: Assign Locker (with Batch No & Expiry Date) + Catalog
  el.assignLockerId.addEventListener("change", () => populateAssignLockerFields(false));
  el.assignMedicineId.addEventListener("change", () => {
    if (el.assignAutoSetpoint) el.assignAutoSetpoint.checked = true;
    updateAssignSetpointPreview();
  });

  el.formAssignMedicine.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.currentUser?.role !== "admin") {
      playAlertBeep(440, 260);
      showToast("Access Denied: Admin only.", true);
      return;
    }

    const lockerId = el.assignLockerId.value;
    const medId = el.assignMedicineId.value;
    const med = state.medicineCatalog[medId];
    if (!med) {
      showToast("Please select a valid medicine.", true);
      return;
    }

    const batchNo = el.assignBatchNo.value.trim();
    const expDate = el.assignExpiryDate.value.trim();
    const defaultSp = Number(med.default_setpoint_temp ?? med.setpoint ?? med.target_temp);
    const maxTemp = Number(med.max_temp_alarm ?? 28.0);
    const maxHum = Number(med.max_hum_alarm ?? 70.0);
    const minStock = Number(med.min_stock_alarm ?? 5);
    const syncSp = (el.assignAutoSetpoint ? el.assignAutoSetpoint.checked : true) && Number.isFinite(defaultSp);

    const updates = {
      [`lockers/${lockerId}/meta/medicine_id`]: medId,
      [`lockers/${lockerId}/meta/medicine_name`]: med.name,
      [`lockers/${lockerId}/meta/category`]: med.category || "Standard",
      [`lockers/${lockerId}/meta/max_temp_alarm`]: maxTemp,
      [`lockers/${lockerId}/meta/max_hum_alarm`]: maxHum,
      [`lockers/${lockerId}/meta/min_stock_alarm`]: minStock,
      [`lockers/${lockerId}/meta/batch_no`]: batchNo,
      [`lockers/${lockerId}/meta/expiry_date`]: expDate
    };
    if (syncSp) {
      updates[`lockers/${lockerId}/pid/setpoint`] = defaultSp;
      updates[`lockers/${lockerId}/control/setpoint`] = defaultSp;
    }

    try {
      await update(ref(db), updates);

      // Update local state immediately so Overview, PID Tuning & Charts reflect new SP without delay
      if (state.lockers[lockerId]) {
        state.lockers[lockerId].meta = {
          ...(state.lockers[lockerId].meta || {}),
          medicine_id: medId,
          medicine_name: med.name,
          category: med.category || "Standard",
          max_temp_alarm: maxTemp,
          max_hum_alarm: maxHum,
          min_stock_alarm: minStock,
          batch_no: batchNo,
          expiry_date: expDate
        };
        if (syncSp) {
          state.lockers[lockerId].pid = {
            ...(state.lockers[lockerId].pid || {}),
            setpoint: defaultSp
          };
          state.lockers[lockerId].control = {
            ...(state.lockers[lockerId].control || {}),
            setpoint: defaultSp
          };
        }
      }
      renderDashboardLockers();
      if (state.selectedPidLocker === lockerId) {
        if (syncSp) populatePidFormForSelectedLocker(true);
        updatePidChartView();
      }
      updateAssignSetpointPreview();

      const spSuffix = syncSp ? ` (SP: ${defaultSp.toFixed(1)}°C)` : "";
      showToast(`Assigned: ${med.name} -> ${lockerId.toUpperCase()}${spSuffix}`);
    } catch (err) {
      console.error("Assign locker update failed:", err);
      playAlertBeep(440, 280);
      showToast(`Assign Failed: ${err?.message || "Permission denied"}`, true);
    }
  });

  el.formAddMedicine.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.currentUser?.role !== "admin") {
      playAlertBeep(440, 260);
      showToast("Access Denied: Admin only.", true);
      return;
    }

    const name = el.medNewName.value.trim();
    const category = el.medNewCat.value.trim() || "Standard Room";
    const sp = Number(el.medNewSp.value);
    const maxT = Number(el.medNewMaxT.value);
    const maxH = Number(el.medNewMaxH.value);
    const minS = Math.max(0, Math.round(Number(el.medNewMinS.value) || 0));

    if (!name || !Number.isFinite(sp) || !Number.isFinite(maxT) || !Number.isFinite(maxH)) {
      playAlertBeep(440, 260);
      showToast("Invalid medicine parameters.", true);
      return;
    }

    const cleanSlugPart = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const slug = cleanSlugPart ? `med_${cleanSlugPart}` : `med_item_${Date.now()}`;
    const newItem = {
      name,
      category,
      default_setpoint_temp: sp,
      max_temp_alarm: maxT,
      max_hum_alarm: maxH,
      min_stock_alarm: minS
    };

    try {
      await set(ref(db, `medicine_catalog/${slug}`), newItem);
      state.medicineCatalog = {
        ...(state.medicineCatalog || {}),
        [slug]: newItem
      };
      renderMedicineCatalogAdmin(slug);
      el.assignMedicineId.value = slug;
      if (el.assignAutoSetpoint) el.assignAutoSetpoint.checked = true;
      updateAssignSetpointPreview();
      renderDashboardLockers();
      el.formAddMedicine.reset();
      showToast(`Added to Catalog: ${name} (SP: ${sp.toFixed(1)}°C)`);
    } catch (err) {
      console.error("Add medicine failed:", err);
      playAlertBeep(440, 280);
      showToast(`Add Medicine Failed: ${err?.message || "Permission denied"}`, true);
    }
  });

  // Admin: Add RFID User (with Per-Locker RBAC & RFID Scan-to-Fill)
  if (el.btnScanUserUid) {
    el.btnScanUserUid.addEventListener("click", startRfidCardEnrollment);
  }

  if (el.userNewRole) {
    el.userNewRole.addEventListener("change", () => {
      const selectedRole = el.userNewRole.value;
      const isMon = selectedRole === "monitoring";
      const isAdm = selectedRole === "admin";
      [el.userNewL1, el.userNewL2, el.userNewL3].forEach((cb) => {
        if (!cb) return;
        cb.checked = !isMon;
        cb.disabled = isMon || isAdm;
      });
    });
  }

  el.formAddUser.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isEnrollingCard) {
      stopRfidCardEnrollment("", "info");
    }
    setEnrollStatusMessage("", "info");
    const rfidUid = el.userNewUid.value.trim().toUpperCase();
    const fullName = el.userNewName.value.trim();
    const cleanUsername = el.userNewUsername.value.trim().toLowerCase();
    const rawPassword = el.userNewPassword.value;
    if (!cleanUsername && !rfidUid) return;

    const role = String(el.userNewRole.value || "operator").toLowerCase();
    const allowedLockers =
      role === "admin"
        ? { locker_1: true, locker_2: true, locker_3: true }
        : role === "monitoring"
          ? { locker_1: false, locker_2: false, locker_3: false }
          : {
              locker_1: el.userNewL1.checked,
              locker_2: el.userNewL2.checked,
              locker_3: el.userNewL3.checked
            };

    const userKey = cleanUsername
      ? `USER_${cleanUsername.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
      : rfidUid;

    if (isDemoMode) {
      await set(ref(db, `users/${userKey}`), {
        name: fullName || cleanUsername || rfidUid,
        username: cleanUsername || rfidUid.toLowerCase(),
        password: rawPassword,
        rfid_uid: rfidUid,
        role,
        active: true,
        allowed_lockers: allowedLockers
      });
    } else {
      // Production Mode: Register in Firebase Auth via REST (without displacing current Admin session),
      // store profile in /users WITHOUT plaintext password, and map RFID UID in /rfid_auth/<UID>
      const email = `${cleanUsername || rfidUid.toLowerCase()}@locker.local`;
      if (rawPassword && rawFirebaseConfig?.apiKey) {
        try {
          await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(rawFirebaseConfig.apiKey)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password: rawPassword, returnSecureToken: false })
            }
          );
        } catch (_) {}
      }

      await set(ref(db, `users/${userKey}`), {
        name: fullName || cleanUsername || rfidUid,
        username: cleanUsername || rfidUid.toLowerCase(),
        rfid_uid: rfidUid,
        role,
        active: true,
        allowed_lockers: allowedLockers
      });

      if (rfidUid && rawPassword) {
        await set(ref(db, `rfid_auth/${rfidUid}`), {
          email,
          password: rawPassword
        });
      }
    }

    el.formAddUser.reset();
    [el.userNewL1, el.userNewL2, el.userNewL3].forEach((cb) => {
      if (!cb) return;
      cb.checked = true;
      cb.disabled = false;
    });
    showToast(`Saved User: ${fullName || userKey}`);
  });

  // Admin: Telegram Alerts Save & Send Test
  el.formTelegramConfig.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cfg = {
      enabled: el.tgEnabled.checked,
      bot_token: el.tgBotToken.value.trim(),
      chat_id: el.tgChatId.value.trim(),
      cooldown_sec: Math.max(5, Number(el.tgCooldown.value || 60))
    };
    await set(ref(db, "system/telegram"), cfg);
    showToast("Telegram Config Saved");
  });

  el.btnTgSendTest.addEventListener("click", async () => {
    const tempCfg = {
      enabled: true,
      bot_token: el.tgBotToken.value.trim(),
      chat_id: el.tgChatId.value.trim(),
      cooldown_sec: 0
    };
    const res = await sendTelegramAlert("manual_test", "TEST ALERT — Smart Medicine Locker SCADA Online.", true, tempCfg);
    if (res.ok) {
      showToast("Telegram Test Sent!");
    } else {
      showToast(`Telegram Error: ${res.error || "Failed"}`, true);
    }
  });

  // Admin: Simulator Controls (V1 + V2 Fault & Expiry Triggers)
  el.btnSimOpenDoor.addEventListener("click", async () => {
    await set(ref(db, `lockers/${el.simLockerId.value}/sensor/door_open`), true);
  });

  el.btnSimCloseDoor.addEventListener("click", async () => {
    await update(ref(db, `lockers/${el.simLockerId.value}`), {
      "sensor/door_open": false,
      "alarm/door_left_open": false,
      "alarm/forced_entry": false
    });
  });

  el.btnSimOvertemp.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    await update(ref(db, `lockers/${id}`), { "sensor/temp": 30.5, "pid/output_pwm": 100, "sensor/fan_rpm": 2750 });
    showToast(`Simulated High Temp (30.5°C) on ${id.toUpperCase()}`);
  });

  el.btnSimNormalTemp.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    const sp = Number(state.lockers[id]?.pid?.setpoint ?? 25.0);
    await update(ref(db, `lockers/${id}`), { "sensor/temp": sp, "pid/output_pwm": 25, "sensor/fan_rpm": 950 });
    showToast(`Normal Temp (${sp.toFixed(1)}°C) on ${id.toUpperCase()}`);
  });

  el.btnSimFanFault.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    const label = state.lockers[id]?.meta?.name || id.toUpperCase();
    await update(ref(db, `lockers/${id}`), {
      "control/mode": "AUTO",
      "pid/output_pwm": 65,
      "sensor/fan_rpm": 0,
      "alarm/fan_fault": true,
      "alarm/acknowledged": false
    });
    await push(ref(db, "logs/alarms"), {
      timestamp: Date.now(),
      locker_id: id,
      type: "CRITICAL",
      message: `${label}: FAN FAULT (PWM 65%, 0 RPM)`,
      acknowledged: false
    });
    sendTelegramAlert(`${id}_fan_fault`, `FAN FAULT on ${label}: PWM 65% with 0 RPM`);
    showToast(`Simulated FAN FAULT on ${id.toUpperCase()}`, true);
  });

  el.btnSimForcedEntry.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    const label = state.lockers[id]?.meta?.name || id.toUpperCase();
    disarmLockerUnlock(id, false);
    state.runtime[id].lastAuthorizedUnlockAt = 0;
    await update(ref(db, `lockers/${id}`), {
      "sensor/door_open": true,
      "control/unlock_cmd": false,
      "alarm/forced_entry": true,
      "alarm/acknowledged": false
    });
    await push(ref(db, "logs/alarms"), {
      timestamp: Date.now(),
      locker_id: id,
      type: "CRITICAL",
      message: `${label}: FORCED ENTRY (Unauthorized door open)`,
      acknowledged: false
    });
    sendTelegramAlert(`${id}_forced_entry`, `CRITICAL — FORCED ENTRY detected on ${label}!`);
    playAlertBeep(980, 320);
    showToast(`Simulated FORCED ENTRY on ${id.toUpperCase()}`, true);
  });

  el.btnSimExpired.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    const yesterday = new Date(Date.now() - 86400000);
    const expStr = formatDateYmd(yesterday);
    await update(ref(db, `lockers/${id}`), {
      "meta/expiry_date": expStr,
      "alarm/expired_med": true,
      "alarm/acknowledged": false
    });
    showToast(`Set EXPIRED (${expStr}) on ${id.toUpperCase()}`, true);
  });

  el.btnSimClearFaults.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    const sp = Number(state.lockers[id]?.pid?.setpoint ?? 25.0);
    await update(ref(db, `lockers/${id}`), {
      "sensor/temp": sp,
      "sensor/door_open": false,
      "sensor/fan_rpm": 1200,
      "pid/output_pwm": 35,
      "meta/expiry_date": "2027-06-30",
      "alarm/over_temp": false,
      "alarm/high_hum": false,
      "alarm/door_left_open": false,
      "alarm/fan_fault": false,
      "alarm/forced_entry": false,
      "alarm/expired_med": false,
      "alarm/acknowledged": true
    });
    showToast(`Cleared Faults on ${id.toUpperCase()}`);
  });

  el.btnSimSendDht.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    const t = Number(el.simInputTemp.value);
    const h = Number(el.simInputHum.value);
    const sp = Number(state.lockers[id]?.pid?.setpoint ?? 25.0);
    const kp = Number(state.lockers[id]?.pid?.kp ?? 12.0);
    const pwm = Math.min(100, Math.max(15, Math.round(Math.max(0, t - sp) * kp + 20)));
    const rpm = Math.round((pwm / 100) * 2800);
    await update(ref(db, `lockers/${id}`), { "sensor/temp": t, "sensor/humidity": h, "pid/output_pwm": pwm, "sensor/fan_rpm": rpm });
    showToast(`Applied DHT22: ${t}°C, ${h}%`);
  });

  el.btnSimOfflineNode.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    await set(ref(db, `lockers/${id}/meta/status`), "offline");
    sendTelegramAlert(`${id}_offline`, `NODE OFFLINE: ${state.lockers[id]?.meta?.name || id.toUpperCase()}`);
    showToast(`${id.toUpperCase()}: OFFLINE`);
  });

  el.btnSimOnlineNode.addEventListener("click", async () => {
    const id = el.simLockerId.value;
    await update(ref(db, `lockers/${id}/meta`), { status: "online", heartbeat: Math.floor(Date.now() / 1000) });
    showToast(`${id.toUpperCase()}: ONLINE`);
  });

  el.btnResetRtdbSpec.addEventListener("click", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (isDemoMode) {
      const payload = structuredClone(DEFAULT_SPEC_DATA);
      LOCKER_IDS.forEach((id) => {
        payload.lockers[id].meta.heartbeat = nowSec;
        demoForcedOffline[id] = false;
      });
      await update(ref(db), payload);
      seedDemoModeInitialData();
      notifyDemoListeners("");
      showToast("Demo State Reset to Defaults");
      return;
    }

    // Production Mode (Admin Only): NEVER overwrite /users, /rfid_auth, or /system/telegram with DEMO_* data!
    if (!canWriteAdminOrSensorRtdb()) return;
    const safeUpdates = {
      "system/emergency_stop": false,
      "system/global_alarm": false,
      medicine_catalog: structuredClone(DEFAULT_SPEC_DATA.medicine_catalog),
      lockers: structuredClone(DEFAULT_SPEC_DATA.lockers)
    };
    LOCKER_IDS.forEach((id) => {
      safeUpdates.lockers[id].meta.heartbeat = nowSec;
    });
    await update(ref(db), safeUpdates);
    showToast("Lockers & Catalog Reset to Spec Defaults");
  });
}

// ============================================================================
// Periodic Timers (1s Watchdog + 3s HB Sim + 5m History Snapshot)
// ============================================================================
function startSystemTimers() {
  setInterval(() => {
    const nowStr = formatTime();
    el.clock.textContent = nowStr;
    if (el.loginFooterClock) el.loginFooterClock.textContent = formatDateTime();

    LOCKER_IDS.forEach((id) => {
      evaluateLockerAlarms(id);
      const rt = state.runtime[id];
      const locker = state.lockers[id];
      if (
        state.connected &&
        !state.heartbeatSimEnabled &&
        rt.lastHbVal !== null &&
        Date.now() - rt.lastHbTime > HEARTBEAT_TIMEOUT_MS &&
        String(locker?.meta?.status || "").toLowerCase() === "online"
      ) {
        locker.meta.status = "offline";
        if (canWriteOperationalRtdb()) {
          set(ref(db, `lockers/${id}/meta/status`), "offline").catch(() => {});
          sendTelegramAlert(`${id}_offline`, `NODE OFFLINE: ${locker?.meta?.name || id.toUpperCase()} (Heartbeat timeout)`);
        }
      }
    });
    renderDashboardLockers();
  }, 1000);

  setInterval(async () => {
    if (!state.connected) return;
    if (state.heartbeatSimEnabled) {
      const nowSec = Math.floor(Date.now() / 1000);
      const updates = {};
      LOCKER_IDS.forEach((id) => {
        state.runtime[id].lastHbTime = Date.now();
        updates[`lockers/${id}/meta/status`] = "online";
        updates[`lockers/${id}/meta/heartbeat`] = nowSec;
      });
      try {
        await update(ref(db), updates);
      } catch (_) {}
    } else {
      recordPidSample(state.selectedPidLocker);
    }
  }, 3000);

  // Automatic 5-Minute Historical Snapshot Logging to /history/locker_X
  setInterval(() => {
    logHistorySnapshots(false);
  }, HISTORY_INTERVAL_MS);

  // Interactive Demo Mode Virtual Plant Engine (1.5s Step)
  if (isDemoMode) {
    setInterval(() => {
      stepDemoVirtualPlant();
    }, DEMO_PLANT_TICK_MS);
  }
}

// ============================================================================
// Bootstrap
// ============================================================================
seedDemoModeInitialData();
buildLockerCards();
initPidChart();
initReportChart();
bindEvents();
startSystemTimers();

if (isDemoMode) {
  const savedDemoUser = loadSavedSession();
  if (savedDemoUser) {
    state.currentUser = savedDemoUser;
    navigateToView("dashboard");
  } else {
    navigateToView("login");
  }
  attachRtdbListeners();
  restorePendingInterlockIfAny();
} else if (isFirebaseConfigured && auth) {
  // Start on Login screen until Firebase Auth confirms either a real user session or anonymous login screen session
  navigateToView("login");
  onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) {
      detachProtectedUserListeners();
      if (state.currentUser) {
        clearSession();
      }
      navigateToView("login");
      await ensureAnonymousLoginScreenAuth();
      return;
    }

    // Attach base RTDB listeners once any Firebase Auth token (anonymous or user) is ready
    attachRtdbListeners();

    if (fbUser.isAnonymous) {
      detachProtectedUserListeners();
      if (state.currentUser) {
        clearSession();
      }
      navigateToView("login");
      attachRfidLoginListener();
      return;
    }

    // Authenticated non-anonymous user (restored on refresh or just signed in)
    const alreadyHadLocalSession = Boolean(state.currentUser);
    await resolveAndCompleteFirebaseLogin(fbUser, !alreadyHadLocalSession);
  });
}
