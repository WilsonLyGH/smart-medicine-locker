/**
 * ============================================================================
 * SMART MEDICINE LOCKER — MODULAR DCS EDGE CONTROLLER FIRMWARE (V2)
 * ============================================================================
 * Sinkron 100% dengan @UPGRADE_SPEC_V2.md, @WIRING_AND_PINOUT.md & Web HMI V2.
 *
 * Cara Konfigurasi per Board ESP32 (cukup ubah 3 baris #define di Bagian 1):
 *   - ESP 1 (38-Pin Master) : LOCKER_ID = 1, HAS_RFID = true,  HAS_OLED = false
 *   - ESP 2 (30-Pin OLED)   : LOCKER_ID = 2, HAS_RFID = false, HAS_OLED = true
 *   - ESP 3 (30-Pin Node)   : LOCKER_ID = 3, HAS_RFID = false, HAS_OLED = false
 *
 * Fitur Utama V2:
 *   1. Dual-Core FreeRTOS: Loop kontrol real-time (Core 1) terpisah dari
 *      sinkronisasi HTTPS Firebase, Telegram & History (Core 0).
 *   2. OLED 0.96" I2C SSD1306 (GPIO 21 SDA, GPIO 22 SCL, 0x3C/0x3D):
 *      Auto-rotate 4s (System Status <-> Local Detail) + Priority Override Screen.
 *   3. Predictive Maintenance (FAN FAULT): PWM > 30% > 5s & RPM == 0.
 *   4. Tamper Detection (FORCED ENTRY): Door false -> true di luar jendela 15s.
 *   5. True Offline Failsafe: NVS Preferences ("locker_cfg") + Store-and-Forward
 *      Ring Buffer (20 event alarm di RAM, otomatis kirim saat Wi-Fi pulih).
 *   6. Telegram Alert langsung via HTTPS + 5-Menit Historical Snapshot ke
 *      /history/locker_X (dibatasi maks 288 sampel / 24 jam).
 * ============================================================================
 */

// ============================================================================
// 1. MODULAR NODE CONFIGURATION (CUKUP UBAH LOCKER_ID = 1, 2, ATAU 3)
// ============================================================================
#define LOCKER_ID   1        // 1 = ESP 1 (Locker 01 + Master RFID), 2 = ESP 2 (Locker 02 + OLED), 3 = ESP 3 (Locker 03)

// Otomatis mengatur HAS_RFID & HAS_OLED berdasarkan LOCKER_ID agar tidak lupa saat pindah board:
#if LOCKER_ID == 1
  #define HAS_RFID  true     // ESP 1 (38-Pin): RFID RC522 Aktif
  #define HAS_OLED  false
#elif LOCKER_ID == 2
  #define HAS_RFID  false
  #define HAS_OLED  true     // ESP 2 (30-Pin): OLED 0.96" I2C Aktif (GPIO 21/22)
#elif LOCKER_ID == 3
  #define HAS_RFID  false
  #define HAS_OLED  false
#else
  #error "LOCKER_ID must be 1, 2, or 3"
#endif

#if HAS_RFID && HAS_OLED
  #error "Pin conflict: RFID RST (GPIO 21) conflicts with OLED SDA (GPIO 21). Enable HAS_OLED on ESP 2 or ESP 3 only."
#endif

// ============================================================================
// 2. INCLUDES & COMPATIBILITY MACROS
// ============================================================================
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>
#include <limits.h>
#include <esp_timer.h>
#include <soc/gpio_reg.h>

#if HAS_RFID
  #include <SPI.h>
  #include <MFRC522.h>
#endif

#if HAS_OLED
  #include <Wire.h>
  #include <Adafruit_GFX.h>
  #include <Adafruit_SSD1306.h>
#endif

#if ARDUINOJSON_VERSION_MAJOR >= 7
  #define MAKE_JSON_DOC(name, size) JsonDocument name
#else
  #define MAKE_JSON_DOC(name, size) DynamicJsonDocument name(size)
#endif

// ============================================================================
// 3. WI-FI, FIREBASE RTDB & NODE IDENTITY (LOADED FROM secrets.h)
// ============================================================================
#if __has_include("secrets.h")
  #include "secrets.h"
#elif __has_include("secrets.example.h")
  #include "secrets.example.h"
#endif

#ifndef SECRET_WIFI_SSID
  #define SECRET_WIFI_SSID         "YOUR_WIFI_SSID"
#endif
#ifndef SECRET_WIFI_PASSWORD
  #define SECRET_WIFI_PASSWORD     "YOUR_WIFI_PASSWORD"
#endif
#ifndef SECRET_FIREBASE_HOST
  #define SECRET_FIREBASE_HOST     "https://YOUR_PROJECT_ID-default-rtdb.YOUR_REGION.firebasedatabase.app"
#endif
#ifndef SECRET_DEFAULT_RFID_UIDS
  #define SECRET_DEFAULT_RFID_UIDS "RFID_ADMIN_01,RFID_OP_01"
#endif

const char* WIFI_SSID     = SECRET_WIFI_SSID;
const char* WIFI_PASSWORD = SECRET_WIFI_PASSWORD;
const char* RTDB_BASE_URL = SECRET_FIREBASE_HOST;

#if LOCKER_ID == 1
  const char* LOCKER_KEY   = "locker_1";
  const char* LOCKER_LABEL = "LOCKER 01";
  const char* ESP_LABEL    = "ESP 1";
#elif LOCKER_ID == 2
  const char* LOCKER_KEY   = "locker_2";
  const char* LOCKER_LABEL = "LOCKER 02";
  const char* ESP_LABEL    = "ESP 2";
#elif LOCKER_ID == 3
  const char* LOCKER_KEY   = "locker_3";
  const char* LOCKER_LABEL = "LOCKER 03";
  const char* ESP_LABEL    = "ESP 3";
#else
  #error "LOCKER_ID must be 1, 2, or 3"
#endif

// ============================================================================
// 4. GPIO PIN DEFINITIONS (SINKRON @WIRING_AND_PINOUT.md & @UPGRADE_SPEC_V2.md)
// ============================================================================
#define PIN_DHT         4    // DHT22 Data
#define PIN_DOOR_REED   27   // Magnetic Switch (INPUT_PULLUP: LOW = CLOSED, HIGH = OPEN)
#define PIN_RELAY_LOCK  26   // Active-LOW Relay (LOW = Unlock/ON, HIGH = Lock/OFF)
#define RELAY_PIN       PIN_RELAY_LOCK
#define PIN_FAN_PWM     25   // 4-Pin Fan PWM Control (25 kHz)
#define PIN_FAN_TACH    32   // 4-Pin Fan Tachometer Interrupt (INPUT_PULLUP)

#if HAS_RFID
  #define PIN_RFID_SS   5    // RC522 SDA / SS
  #define PIN_RFID_SCK  18   // RC522 SCK
  #define PIN_RFID_MISO 19   // RC522 MISO
  #define PIN_RFID_MOSI 23   // RC522 MOSI
  #define PIN_RFID_RST  21   // RC522 RST
#endif

#if HAS_OLED
  #define PIN_OLED_SDA       21
  #define PIN_OLED_SCL       22
  #define OLED_WIDTH         128
  #define OLED_HEIGHT        64
  #define OLED_ADDR_PRIMARY  0x3C
  #define OLED_ADDR_FALLBACK 0x3D
#endif

// Active-LOW Relay Polarity & Timing Constants
#define RELAY_ON                    LOW      // Active-LOW: LOW  = Relay Energized (Solenoid UNLOCKED)
#define RELAY_OFF                   HIGH     // Active-LOW: HIGH = Relay De-energized (Solenoid LOCKED)
#define RELAY_UNLOCK                RELAY_ON
#define RELAY_LOCK                  RELAY_OFF
#define BOOT_LOCK_GUARD_MS          4000UL   // Keep solenoid strictly LOCKED during initial boot & first RTDB sync
#define DOOR_DEBOUNCE_MS            150UL    // 150ms software debounce for normal door_open status
#define LOCK_WAIT_OPEN_TIMEOUT_MS   10000UL  // Max 10s waiting for door to open after Unlock
#define LOCK_MAX_OPEN_HOLD_MS       10000UL  // Max 10s solenoid hold while door is open
#define LOCK_CLOSING_CONFIRM_MS     2000UL   // 2s continuous CLOSED confirmation before relock
#define RELOCK_GRACE_MS             2000UL   // 2s post-relock grace period before FORCED ENTRY check
#define BOOT_GRACE_MS               3000UL   // 3s post-boot grace period before FORCED ENTRY check
#define FORCED_ENTRY_STABLE_MS      500UL    // Raw magnetic sensor must stay OPEN >= 500ms continuously
#define UNLOCK_RESET_RETRY_MS       1000UL   // Retry PATCH unlock_cmd=false every 1s if failed
#define FAN_FAULT_DELAY_MS          5000UL   // PWM > 30% & RPM == 0 for > 5s
#define CONTROL_LOOP_MS             2000UL   // DHT22 & PID interval (2s)
#define RTDB_SYNC_MS                2000UL   // Firebase telemetry/control sync (2s)
#define CATALOG_SYNC_MS        60000UL  // Medicine limits & RFID UID cache refresh (60s)
#define HISTORY_INTERVAL_MS    300000UL // 5-minute cold-chain snapshot interval
#define MAX_HISTORY_SAMPLES    288      // 24 hours at 5-min interval
#define RTDB_HTTP_TIMEOUT_MS   1800     // Short 1.8s HTTP timeout so OLED & sync never stall
#define WIFI_BOOT_TIMEOUT_MS   8000UL   // Never block offline failsafe at boot
#define WIFI_RECONNECT_MS      10000UL
#define ALARM_QUEUE_CAPACITY   20       // Store-and-Forward RAM ring buffer size

#if HAS_OLED
  #define OLED_ROTATE_MS       3000UL   // Rotate Locker 1 -> 2 -> 3 every 3 seconds
  #define OLED_REMOTE_FETCH_MS 3000UL   // Fetch remote lockers every 3 seconds
  #define OLED_HB_TIMEOUT_MS   12000UL  // 12-second heartbeat watchdog timeout
  #define OLED_REFRESH_MS      250UL    // Fast non-blocking screen redraw (250ms)
#endif

#define PWM_FREQ               25000
#define PWM_RES                8
#define PWM_CHANNEL            0

// 4-Pin Fan Tachometer Filter (Spec kipas max ~4000 RPM)
#define FAN_PULSES_PER_REV     2        // Standar kipas 4-pin = 2 pulsa/putaran (ubah ke 4 jika tipe 4-PPR)
#define FAN_MAX_RPM_VALID      5000     // Batas atas valid (4000 RPM + margin)
#define TACH_MIN_LOW_US        400LL    // Tolak spike/crosstalk PWM 25 kHz (< 400 us)
#define TACH_MIN_PERIOD_US     (60000000LL / ((int64_t)FAN_MAX_RPM_VALID * FAN_PULSES_PER_REV))

// ============================================================================
// 5. GLOBAL OBJECTS, DATA STRUCTURES & SHARED STATE
// ============================================================================
DHT dht(PIN_DHT, DHT22);
Preferences prefs;
SemaphoreHandle_t stateMutex = NULL;

#if HAS_RFID
  MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
  String pendingRfidUid = "";
  volatile bool hasPendingRfid = false;
  bool rfidChipOnline = false;
  String cachedRfidUids = SECRET_DEFAULT_RFID_UIDS; // Persisted in NVS for offline auth
  unsigned long lastRfidCheckMs = 0;
#endif

#if HAS_OLED
  Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
  bool oledReady = false;
  unsigned long lastOledRefreshMs     = 0;
  unsigned long lastOledRotateMs      = 0;
  unsigned long lastOledBlinkMs       = 0;
  unsigned long lastRemoteOledFetchMs = 0;
  uint8_t oledSlideIndex = 0; // 0 = LOCKER 01, 1 = LOCKER 02, 2 = LOCKER 03
  bool oledBlinkState    = false;

  struct OledLockerNode {
    float temp;
    float hum;
    float sp;
    int   pwm;
    int   rpm;
    int   stock;
    bool  doorOpen;
    bool  overTemp;
    bool  fanFault;
    bool  forcedEntry;
    char  mode[8];
  };

  OledLockerNode oledNodes[3] = {
    { 25.0f, 58.0f, 25.0f, 0, 0, 0, false, false, false, false, "AUTO" },
    { 25.0f, 58.0f, 25.0f, 0, 0, 0, false, false, false, false, "AUTO" },
    { 25.0f, 58.0f, 25.0f, 0, 0, 0, false, false, false, false, "AUTO" }
  };

  uint64_t      lastHeartbeat[3]  = { 0ULL, 0ULL, 0ULL };
  unsigned long lastHbChangeMs[3] = { 0UL, 0UL, 0UL };
  bool          hbInitialized[3]  = { false, false, false };
#endif

// Store-and-Forward Alarm Ring Buffer (20 events)
struct QueuedAlarmEvent {
  char type[16];
  char message[128];
  uint64_t timestampMs;
};
QueuedAlarmEvent alarmQueue[ALARM_QUEUE_CAPACITY];
int queueHead  = 0;
int queueTail  = 0;
int queueCount = 0;

// Telegram Alert Slots (Cooldown-Protected)
enum TgAlertSlot {
  TG_OVER_TEMP = 0,
  TG_FORCED_ENTRY,
  TG_FAN_FAULT,
  TG_ESTOP,
  TG_SLOT_COUNT
};
struct PendingTgAlert {
  bool pending;
  char text[160];
  unsigned long lastSentMs;
};
PendingTgAlert tgAlerts[TG_SLOT_COUNT];

bool   tgEnabled     = false;
String tgBotToken    = "";
String tgChatId      = "";
unsigned long tgCooldownSec = 60;

// Tachometer ISR state (Pulse-Width + Period filter anti-crosstalk PWM 25 kHz)
volatile unsigned long tachPulses      = 0;
volatile int64_t       tachFallUs      = 0;
volatile int64_t       lastValidTachUs = 0;
volatile bool          tachIsLow       = false;

// Local Telemetry & Actuator State
volatile float currentTemp   = 25.0f;
volatile float currentHum    = 58.0f;
volatile bool  doorOpen      = false;
bool           prevDoorOpen  = false;
bool           lastRawDoor   = false;
unsigned long  lastDoorBounceMs = 0;
volatile int   currentRpm    = 0;
volatile int   outputPwm     = 0;
volatile int   currentStock  = 0;

// 4-Stage Solenoid Finite State Machine (FSM)
enum LockFsmState {
  LOCK_STATE_LOCKED = 0,
  LOCK_STATE_WAIT_OPEN,
  LOCK_STATE_DOOR_OPEN,
  LOCK_STATE_CLOSING_CONFIRM
};

volatile LockFsmState lockState                = LOCK_STATE_LOCKED;
volatile int          currentRelayLevel        = RELAY_OFF;
unsigned long         lockStateStartMs         = 0;
unsigned long         lockOpenStartMs          = 0;
unsigned long         closeStableStartMs       = 0;
unsigned long         lastRelockMs             = 0;
unsigned long         forcedOpenStartMs        = 0;
bool                  forcedLatchActive        = false;
bool                  authorizedDoorOpenActive = false; // True while door remains open from a valid Unlock

// Control & PID Parameters (Persisted in NVS "locker_cfg")
volatile bool  emergencyStop            = false;
bool           prevEmergencyStop        = false;
volatile bool  firebaseSynced           = false;
volatile bool  initialRtdbSyncComplete  = false; // Blocks stale unlock_cmd until initial boot RTDB read completes
volatile bool  remoteUnlockReq          = false;
volatile bool  clearUnlockFlagPending   = false;
volatile bool  waitUnlockFalseConfirm   = false;
volatile bool  immediateDoorPushPending = false;
unsigned long  lastUnlockResetTryMs     = 0;

String controlMode  = "AUTO";
int    manualPwm    = 0;
float  pidSetpoint  = 25.0f;
float  pidKp        = 12.0f;
float  pidKi        = 0.5f;
float  pidKd        = 2.0f;
float  pidIntegral  = 0.0f;
float  pidPrevErr   = 0.0f;
String medicineId   = "med_general";
float  maxTempAlarm = 28.0f;
float  maxHumAlarm  = 70.0f;

// Local Diagnostics & Security Alarm Flags
volatile bool alarmOverTemp     = false;
volatile bool alarmFanFault     = false;
volatile bool alarmForcedEntry  = false;
volatile bool alarmAcknowledged = true;
volatile bool alarmDirtyPending = false;
unsigned long fanZeroStartMs    = 0;
unsigned long lastControlLoopMs = 0;

// ============================================================================
// 6. INTERRUPTS, TIME, MUTEX & HARDWARE HELPERS
// ============================================================================
// Direct register read: 100% IRAM-safe even during NVS Flash writes on Core 0
static inline bool IRAM_ATTR fastReadGpio(int pin) {
  if (pin < 32) {
    return (REG_READ(GPIO_IN_REG) >> pin) & 0x1U;
  }
  return (REG_READ(GPIO_IN1_REG) >> (pin - 32)) & 0x1U;
}

void IRAM_ATTR onTachChange() {
  int64_t nowUs = esp_timer_get_time();
  bool level = fastReadGpio(PIN_FAN_TACH);

  if (!level) {
    // Falling edge: catat awal pulsa LOW Hall sensor
    if (!tachIsLow) {
      tachIsLow  = true;
      tachFallUs = nowUs;
    }
  } else {
    // Rising edge: validasi lebar pulsa LOW (>=400us) & periode antar pulsa
    // Pulsa crosstalk PWM 25kHz (<40us) & noise EMI otomatis dibuang!
    if (tachIsLow) {
      tachIsLow = false;
      int64_t lowWidthUs = nowUs - tachFallUs;
      if (lowWidthUs >= TACH_MIN_LOW_US && (nowUs - lastValidTachUs) >= TACH_MIN_PERIOD_US) {
        lastValidTachUs = nowUs;
        tachPulses++;
      }
    }
  }
}

uint64_t getEpochSec() {
  time_t nowSec = time(nullptr);
  return (nowSec > 1700000000L) ? (uint64_t)nowSec : 0ULL;
}

uint64_t getEpochMs() {
  uint64_t sec = getEpochSec();
  return (sec > 0ULL) ? (sec * 1000ULL) : 0ULL;
}

// Hardware Relay Writer — Only calls digitalWrite when target level actually changes
void writeRelayLevel(int targetLevel) {
  if (currentRelayLevel == targetLevel) return;
  currentRelayLevel = targetLevel;
  digitalWrite(RELAY_PIN, targetLevel);
#if HAS_RFID
  // Re-init RC522 registers in case solenoid switching spike disturbed 3.3V bus
  rfid.PCD_Init();
  rfid.PCD_AntennaOn();
#endif
}

// Transition Solenoid FSM State (writes digitalWrite ONLY on actual state transitions)
void setLockFsmState(LockFsmState nextState, unsigned long now, const char* reason) {
  if (lockState == nextState) return;
  lockState = nextState;
  lockStateStartMs = now;
  forcedOpenStartMs = 0UL;

  if (nextState == LOCK_STATE_LOCKED) {
    writeRelayLevel(RELAY_OFF); // HIGH = Relay OFF (Solenoid Locked)
    lastRelockMs = now;
    Serial.printf("[SOLENOID FSM] -> LOCK_STATE_LOCKED (Relay HIGH/OFF) | %s\n", reason);
  } else {
    writeRelayLevel(RELAY_ON);  // LOW = Relay ON (Solenoid Unlocked)
    if (nextState == LOCK_STATE_WAIT_OPEN) {
      Serial.printf("[SOLENOID FSM] -> LOCK_STATE_WAIT_OPEN (Relay LOW/ON) | %s\n", reason);
    } else if (nextState == LOCK_STATE_DOOR_OPEN) {
      Serial.printf("[SOLENOID FSM] -> LOCK_STATE_DOOR_OPEN (Relay LOW/ON) | %s\n", reason);
    } else if (nextState == LOCK_STATE_CLOSING_CONFIRM) {
      Serial.printf("[SOLENOID FSM] -> LOCK_STATE_CLOSING_CONFIRM (2s close confirm) | %s\n", reason);
    }
  }
}

void writeFanPwm(int percent) {
  outputPwm = constrain(percent, 0, 100);
  int duty = map(outputPwm, 0, 100, 0, 255);
#if defined(ESP_ARDUINO_VERSION) && ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
  ledcWrite(PIN_FAN_PWM, duty);
#else
  ledcWrite(PWM_CHANNEL, duty);
#endif
}

int computeReverseActingPid(float pv, float sp, float dtSec) {
  float error = pv - sp;
  if (error <= 0.0f) {
    pidIntegral = 0.0f;
    pidPrevErr = error;
    return 0;
  }
  pidIntegral = constrain(pidIntegral + error * dtSec, 0.0f, 50.0f);
  float derivative = (dtSec > 0.0f) ? ((error - pidPrevErr) / dtSec) : 0.0f;
  pidPrevErr = error;
  float out = (pidKp * error) + (pidKi * pidIntegral) + (pidKd * derivative);
  return constrain((int)round(out), 0, 100);
}

// ============================================================================
// 7. STORE-AND-FORWARD ALARM QUEUE & TELEGRAM QUEUE (THREAD-SAFE)
// ============================================================================
void enqueueAlarmEvent(const char* type, const String& msg) {
  if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    if (queueCount >= ALARM_QUEUE_CAPACITY) {
      // Overwrite oldest event when ring buffer is full
      queueHead = (queueHead + 1) % ALARM_QUEUE_CAPACITY;
      queueCount--;
    }
    QueuedAlarmEvent& slot = alarmQueue[queueTail];
    strncpy(slot.type, type, sizeof(slot.type) - 1);
    slot.type[sizeof(slot.type) - 1] = '\0';
    strncpy(slot.message, msg.c_str(), sizeof(slot.message) - 1);
    slot.message[sizeof(slot.message) - 1] = '\0';
    slot.timestampMs = getEpochMs();

    queueTail = (queueTail + 1) % ALARM_QUEUE_CAPACITY;
    queueCount++;
    xSemaphoreGive(stateMutex);
    Serial.printf("[QUEUE +1] (%d/%d) [%s] %s\n", queueCount, ALARM_QUEUE_CAPACITY, type, msg.c_str());
  }
}

void requestTelegramAlert(TgAlertSlot slot, const String& text) {
  if (slot >= TG_SLOT_COUNT) return;
  if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    strncpy(tgAlerts[slot].text, text.c_str(), sizeof(tgAlerts[slot].text) - 1);
    tgAlerts[slot].text[sizeof(tgAlerts[slot].text) - 1] = '\0';
    tgAlerts[slot].pending = true;
    xSemaphoreGive(stateMutex);
  }
}

// ============================================================================
// 8. NVS FLASH PERSISTENCE (TRUE OFFLINE FAILSAFE — NAMESPACE "locker_cfg")
// ============================================================================
void loadConfigFromNvs() {
  prefs.begin("locker_cfg", true); // read-only
  pidSetpoint  = prefs.getFloat("sp", 25.0f);
  pidKp        = prefs.getFloat("kp", 12.0f);
  pidKi        = prefs.getFloat("ki", 0.5f);
  pidKd        = prefs.getFloat("kd", 2.0f);
  controlMode  = prefs.getString("mode", "AUTO");
  manualPwm    = prefs.getInt("mpwm", 0);
  maxTempAlarm = prefs.getFloat("max_t", 28.0f);
  maxHumAlarm  = prefs.getFloat("max_h", 70.0f);
  medicineId   = prefs.getString("med_id", "med_general");
  currentStock = prefs.getInt("stock", 0);
#if HAS_RFID
  cachedRfidUids = prefs.getString("rfid_uids", SECRET_DEFAULT_RFID_UIDS);
#endif
  prefs.end();

  Serial.printf("[NVS LOAD] SP=%.1f Kp=%.2f Ki=%.2f Kd=%.2f Mode=%s ManPWM=%d MaxT=%.1f\n",
                pidSetpoint, pidKp, pidKi, pidKd, controlMode.c_str(), manualPwm, maxTempAlarm);
}

void saveConfigToNvsIfChanged(float sp, float kp, float ki, float kd,
                              const String& mode, int mpwm,
                              float maxT, float maxH, const String& medId, int stock) {
  prefs.begin("locker_cfg", false);
  if (fabsf(prefs.getFloat("sp", -999.0f) - sp) > 0.01f)     prefs.putFloat("sp", sp);
  if (fabsf(prefs.getFloat("kp", -999.0f) - kp) > 0.01f)     prefs.putFloat("kp", kp);
  if (fabsf(prefs.getFloat("ki", -999.0f) - ki) > 0.001f)    prefs.putFloat("ki", ki);
  if (fabsf(prefs.getFloat("kd", -999.0f) - kd) > 0.01f)     prefs.putFloat("kd", kd);
  if (prefs.getString("mode", "") != mode)                   prefs.putString("mode", mode);
  if (prefs.getInt("mpwm", -1) != mpwm)                      prefs.putInt("mpwm", mpwm);
  if (fabsf(prefs.getFloat("max_t", -999.0f) - maxT) > 0.01f) prefs.putFloat("max_t", maxT);
  if (fabsf(prefs.getFloat("max_h", -999.0f) - maxH) > 0.01f) prefs.putFloat("max_h", maxH);
  if (prefs.getString("med_id", "") != medId)                prefs.putString("med_id", medId);
  if (prefs.getInt("stock", -1) != stock)                    prefs.putInt("stock", stock);
  prefs.end();
}

#if HAS_RFID
void saveRfidCacheToNvs(const String& uidList) {
  if (uidList.length() == 0) return;
  prefs.begin("locker_cfg", false);
  if (prefs.getString("rfid_uids", "") != uidList) {
    prefs.putString("rfid_uids", uidList);
    Serial.printf("[NVS RFID] Cached UIDs updated: %s\n", uidList.c_str());
  }
  prefs.end();
}

bool isUidInOfflineCache(const String& uid) {
  bool found = false;
  if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
    String haystack = "," + cachedRfidUids + ",";
    String needle   = "," + uid + ",";
    found = (haystack.indexOf(needle) >= 0);
    xSemaphoreGive(stateMutex);
  }
  return found;
}

void checkAndRecoverRfidReader() {
  byte v      = rfid.PCD_ReadRegister(rfid.VersionReg);
  byte txAsk  = rfid.PCD_ReadRegister(rfid.TxASKReg);
  byte txCtrl = rfid.PCD_ReadRegister(rfid.TxControlReg);

  if (v == 0x00 || v == 0xFF) {
    rfidChipOnline = false;
    Serial.printf("[RFID WARN] RC522 tidak terdeteksi (Reg=0x%02X). Cek 3.3V/GND/SPI/RST(GPIO21)\n", v);
    rfid.PCD_Init();
  } else {
    // Also detect internal register reset caused by relay/solenoid EMI brownout (TxASKReg resets from 0x40 to 0x00)
    if (!rfidChipOnline || txAsk != 0x40 || (txCtrl & 0x03) != 0x03) {
      rfid.PCD_Init();
      rfid.PCD_AntennaOn();
      rfidChipOnline = true;
      Serial.printf("[RFID OK] RC522 Initialized & Antenna Active (Ver=0x%02X). Siap tap kartu.\n", v);
    } else {
      rfid.PCD_AntennaOn();
    }
  }
}
#endif

// ============================================================================
// 9. OLED 0.96" I2C SSD1306 LOCAL HMI (3-LOCKER 3s ROTATION + HB WATCHDOG)
// ============================================================================
#if HAS_OLED
void initOledDisplay() {
  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  oledReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR_PRIMARY);
  if (!oledReady) {
    oledReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR_FALLBACK);
  }
  if (oledReady) {
    display.clearDisplay();
    display.setTextWrap(false);
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(4, 14);
    display.print("SMART MEDICINE LOCKER");
    display.setCursor(22, 30);
    display.printf("%s (%s)", LOCKER_LABEL, ESP_LABEL);
    display.setCursor(16, 46);
    display.print("Booting SCADA V2...");
    display.display();
    Serial.println("[OLED OK] SSD1306 128x64 initialized on GPIO 21/22.");
  } else {
    Serial.println("[OLED WARN] SSD1306 not detected at 0x3C or 0x3D.");
  }
}

void renderOledScreen() {
  if (!oledReady) return;

  unsigned long now = millis();
  if (now - lastOledBlinkMs >= 500UL) {
    lastOledBlinkMs = now;
    oledBlinkState = !oledBlinkState;
  }

  bool wifiOk      = (WiFi.status() == WL_CONNECTED);
  bool localOnline = wifiOk && firebaseSynced;
  bool pEstop      = emergencyStop;

  OledLockerNode snap[3];
  unsigned long  hbChangeSnap[3];

  if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(30)) == pdTRUE) {
    memcpy(snap, oledNodes, sizeof(snap));
    memcpy(hbChangeSnap, lastHbChangeMs, sizeof(hbChangeSnap));
    xSemaphoreGive(stateMutex);
  } else {
    memcpy(snap, oledNodes, sizeof(snap));
    memcpy(hbChangeSnap, lastHbChangeMs, sizeof(hbChangeSnap));
  }

  // Local node (ESP 2 / LOCKER_ID - 1) always uses real-time local sensor & PID state
  const int localIdx = LOCKER_ID - 1;
  snap[localIdx].temp        = currentTemp;
  snap[localIdx].hum         = currentHum;
  snap[localIdx].sp          = pidSetpoint;
  snap[localIdx].pwm         = pEstop ? 0 : outputPwm;
  snap[localIdx].rpm         = pEstop ? 0 : currentRpm;
  snap[localIdx].stock       = currentStock;
  snap[localIdx].doorOpen    = doorOpen;
  snap[localIdx].overTemp    = alarmOverTemp;
  snap[localIdx].fanFault    = alarmFanFault;
  snap[localIdx].forcedEntry = alarmForcedEntry;

  // Evaluate ONLINE / OFFLINE per node (12s Heartbeat Watchdog for remote nodes)
  bool nodeOnline[3];
  for (int i = 0; i < 3; i++) {
    if (i == localIdx) {
      nodeOnline[i] = localOnline;
    } else {
      nodeOnline[i] = localOnline &&
                      (hbChangeSnap[i] != 0UL) &&
                      ((now - hbChangeSnap[i]) <= OLED_HB_TIMEOUT_MS);
    }
  }

  uint8_t slideIdx = oledSlideIndex % 3;
  bool isLocalSlide = (slideIdx == (uint8_t)localIdx);
  const OledLockerNode& cur = snap[slideIdx];

  display.clearDisplay();
  display.setTextWrap(false);
  display.setTextSize(1);

  // ==========================================================================
  // TOP HEADER ZONE (y = 0..14, Horizontal Divider at y = 15)
  // ==========================================================================
  if (pEstop) {
    if (oledBlinkState) {
      display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
    } else {
      display.drawRect(0, 0, 128, 14, SSD1306_WHITE);
      display.setTextColor(SSD1306_WHITE);
    }
    display.setCursor(4, 3);
    display.print("!! EMERGENCY STOP !!");
  } else if (!wifiOk) {
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 3);
    display.print("LOCAL MODE (NO WIFI)");
  } else {
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 3);
    display.printf("1:%s 2:%s 3:%s   %d/3",
                   nodeOnline[0] ? "ON" : "OF",
                   nodeOnline[1] ? "ON" : "OF",
                   nodeOnline[2] ? "ON" : "OF",
                   slideIdx + 1);
  }
  display.drawFastHLine(0, 15, 128, SSD1306_WHITE);

  // ==========================================================================
  // MAIN BODY ZONE (y = 18..63) — SLIDE 1 / 2 / 3 (3s Auto-Rotation)
  // ==========================================================================
  display.setTextColor(SSD1306_WHITE);

  if (isLocalSlide || nodeOnline[slideIdx]) {
    // --- ONLINE NODE (or ESP 2 Local Failsafe Mode) ---
    const char* alarmTag = nullptr;
    if (cur.forcedEntry)   alarmTag = "[FORCED!]";
    else if (cur.fanFault) alarmTag = "[FAN FAULT]";
    else if (cur.overTemp) alarmTag = "[OVER TEMP]";

    // Row 1 (y = 18): LOCKER 0X + Status or Inverted Alarm Tag
    display.setCursor(0, 18);
    if (alarmTag != nullptr) {
      display.printf("LOCKER 0%d", slideIdx + 1);
      int tagLen = (int)strlen(alarmTag);
      int badgeW = (tagLen * 6) + 2;
      int badgeX = 128 - badgeW;
      display.fillRect(badgeX, 17, badgeW, 10, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
      display.setCursor(badgeX + 1, 18);
      display.print(alarmTag);
      display.setTextColor(SSD1306_WHITE);
    } else if (isLocalSlide && !localOnline) {
      display.printf("LOCKER 0%d    [LOCAL]", slideIdx + 1);
    } else {
      display.printf("LOCKER 0%d   [ONLINE]", slideIdx + 1);
    }

    // Row 2 (y = 30): Temp & Setpoint
    display.setCursor(0, 30);
    display.printf("T:%4.1fC  SP:%4.1fC", cur.temp, cur.sp);

    // Row 3 (y = 42): Humidity & Door State
    display.setCursor(0, 42);
    display.printf("H:%2.0f%%    DOOR:%s",
                   cur.hum,
                   cur.doorOpen ? "OPEN" : "LOCK");

    // Row 4 (y = 54): PWM, RPM & Stock
    display.setCursor(0, 54);
    display.printf("P:%d%% %dR STK:%d", cur.pwm, cur.rpm, cur.stock);
  } else {
    // --- REMOTE NODE OFFLINE VIEW ---
    // Row 1 (y = 18)
    display.setCursor(0, 18);
    display.printf("LOCKER 0%d  [OFFLINE]", slideIdx + 1);

    // Center (TextSize 2, y = 32)
    display.setTextSize(2);
    display.setCursor(22, 32);
    if (!localOnline) {
      display.print("NO WIFI");
    } else {
      display.print("OFFLINE");
    }

    // Row 4 (TextSize 1, y = 54)
    display.setTextSize(1);
    display.setCursor(0, 54);
    if (!localOnline) {
      display.print("ESP2 NET DISCONNECTED");
    } else {
      display.print("NO HEARTBEAT >12s");
    }
  }

  display.display();
}
#endif

// ============================================================================
// 10. FIREBASE RTDB & TELEGRAM HTTPS HELPERS (RUN ON CORE 0)
// ============================================================================
bool rtdbRequest(WiFiClientSecure& client, HTTPClient& http, const char* method,
                 const String& path, const String& payload, String* outResp = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return false;
  String url = String(RTDB_BASE_URL) + path + ".json";
  http.setTimeout(RTDB_HTTP_TIMEOUT_MS);
  if (!http.begin(client, url)) return false;
  if (payload.length() > 0) {
    http.addHeader("Content-Type", "application/json");
  }
  int code = http.sendRequest(method, payload);
  if (outResp && code >= 200 && code < 300) {
    *outResp = http.getString();
  }
  http.end();
  return (code >= 200 && code < 300);
}

#if HAS_OLED
void fetchRemoteLockersForOled(WiFiClientSecure& client, HTTPClient& http) {
  String locResp;
  if (!rtdbRequest(client, http, "GET", "/lockers", "", &locResp)) {
    return;
  }

  MAKE_JSON_DOC(filter, 640);
  for (int i = 1; i <= 3; i++) {
    String k = "locker_" + String(i);
    filter[k]["meta"]["heartbeat"]     = true;
    filter[k]["meta"]["stock"]         = true;
    filter[k]["sensor"]["temp"]        = true;
    filter[k]["sensor"]["humidity"]    = true;
    filter[k]["sensor"]["door_open"]   = true;
    filter[k]["sensor"]["fan_rpm"]     = true;
    filter[k]["pid"]["setpoint"]       = true;
    filter[k]["pid"]["output_pwm"]     = true;
    filter[k]["control"]["mode"]       = true;
    filter[k]["control"]["manual_pwm"] = true;
    filter[k]["alarm"]["over_temp"]    = true;
    filter[k]["alarm"]["fan_fault"]    = true;
    filter[k]["alarm"]["forced_entry"] = true;
  }

  MAKE_JSON_DOC(doc, 2048);
  if (deserializeJson(doc, locResp, DeserializationOption::Filter(filter))) {
    return;
  }

  unsigned long nowMs = millis();
  if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    for (int i = 0; i < 3; i++) {
      String k = "locker_" + String(i + 1);
      JsonObject lo = doc[k];
      if (lo.isNull()) continue;

      uint64_t hb = lo["meta"]["heartbeat"] | 0ULL;
      if (!hbInitialized[i]) {
        hbInitialized[i]  = true;
        lastHeartbeat[i]  = hb;
        lastHbChangeMs[i] = 0UL; // Wait for first heartbeat change to confirm live node
      } else if (hb != lastHeartbeat[i]) {
        lastHeartbeat[i]  = hb;
        lastHbChangeMs[i] = nowMs;
      }

      oledNodes[i].temp        = lo["sensor"]["temp"]      | oledNodes[i].temp;
      oledNodes[i].hum         = lo["sensor"]["humidity"]  | oledNodes[i].hum;
      oledNodes[i].doorOpen    = lo["sensor"]["door_open"] | false;
      oledNodes[i].rpm         = lo["sensor"]["fan_rpm"]   | 0;
      oledNodes[i].sp          = lo["pid"]["setpoint"]     | 25.0f;
      oledNodes[i].stock       = lo["meta"]["stock"]       | 0;
      oledNodes[i].overTemp    = lo["alarm"]["over_temp"]    | false;
      oledNodes[i].fanFault    = lo["alarm"]["fan_fault"]    | false;
      oledNodes[i].forcedEntry = lo["alarm"]["forced_entry"] | false;

      const char* mStr = lo["control"]["mode"] | "AUTO";
      strncpy(oledNodes[i].mode, mStr, sizeof(oledNodes[i].mode) - 1);
      oledNodes[i].mode[sizeof(oledNodes[i].mode) - 1] = '\0';

      if (strcmp(oledNodes[i].mode, "MANUAL") == 0) {
        oledNodes[i].pwm = lo["control"]["manual_pwm"] | 0;
      } else {
        oledNodes[i].pwm = lo["pid"]["output_pwm"] | 0;
      }
    }
    xSemaphoreGive(stateMutex);
  }
}
#endif

bool sendTelegramMessageNow(const String& botToken, const String& chatId, const String& text) {
  if (WiFi.status() != WL_CONNECTED || botToken.length() < 10 || chatId.length() == 0) {
    return false;
  }
  WiFiClientSecure tgClient;
  tgClient.setInsecure();
  HTTPClient tgHttp;
  tgHttp.setTimeout(6000);

  String url = "https://api.telegram.org/bot" + botToken + "/sendMessage";
  if (!tgHttp.begin(tgClient, url)) return false;
  tgHttp.addHeader("Content-Type", "application/json");

  MAKE_JSON_DOC(doc, 384);
  doc["chat_id"] = chatId;
  doc["text"]    = String("[SMART MEDICINE LOCKER - ") + ESP_LABEL + "]\n" + text;
  String body;
  serializeJson(doc, body);

  int code = tgHttp.POST(body);
  tgHttp.end();
  if (code >= 200 && code < 300) {
    Serial.printf("[TELEGRAM OK] Sent: %s\n", text.c_str());
    return true;
  }
  Serial.printf("[TELEGRAM ERR] HTTP %d\n", code);
  return false;
}

void processPendingTelegramAlerts() {
  bool enabledLocal = false;
  String tokenLocal, chatLocal;
  unsigned long cooldownMs = 60000UL;
  unsigned long now = millis();

  for (int i = 0; i < TG_SLOT_COUNT; i++) {
    bool shouldSend = false;
    String msgText;

    if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
      enabledLocal = tgEnabled;
      tokenLocal   = tgBotToken;
      chatLocal    = tgChatId;
      cooldownMs   = max(5UL, tgCooldownSec) * 1000UL;

      if (tgAlerts[i].pending) {
        if (!enabledLocal || tokenLocal.length() < 10 || chatLocal.length() == 0) {
          tgAlerts[i].pending = false;
        } else if (tgAlerts[i].lastSentMs == 0 || (now - tgAlerts[i].lastSentMs >= cooldownMs)) {
          msgText = String(tgAlerts[i].text);
          tgAlerts[i].pending = false;
          tgAlerts[i].lastSentMs = now;
          shouldSend = true;
        } else {
          // Inside cooldown window -> suppress spam
          tgAlerts[i].pending = false;
        }
      }
      xSemaphoreGive(stateMutex);
    }

    if (shouldSend) {
      sendTelegramMessageNow(tokenLocal, chatLocal, msgText);
    }
  }
}

void flushAlarmQueue(WiFiClientSecure& client, HTTPClient& http) {
  while (WiFi.status() == WL_CONNECTED) {
    QueuedAlarmEvent ev;
    bool hasItem = false;

    if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
      if (queueCount > 0) {
        ev = alarmQueue[queueHead];
        hasItem = true;
      }
      xSemaphoreGive(stateMutex);
    }
    if (!hasItem) break;

    MAKE_JSON_DOC(doc, 256);
    uint64_t ts = (ev.timestampMs > 0ULL) ? ev.timestampMs : getEpochMs();
    if (ts > 0ULL) {
      doc["timestamp"] = ts;
    } else {
#if ARDUINOJSON_VERSION_MAJOR >= 7
      JsonObject sv = doc["timestamp"].to<JsonObject>();
#else
      JsonObject sv = doc.createNestedObject("timestamp");
#endif
      sv[".sv"] = "timestamp";
    }
    doc["locker_id"]    = LOCKER_KEY;
    doc["type"]         = ev.type;
    doc["message"]      = ev.message;
    doc["acknowledged"] = false;

    String body;
    serializeJson(doc, body);
    if (rtdbRequest(client, http, "POST", "/logs/alarms", body)) {
      if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        if (queueCount > 0) {
          queueHead = (queueHead + 1) % ALARM_QUEUE_CAPACITY;
          queueCount--;
        }
        xSemaphoreGive(stateMutex);
      }
      Serial.printf("[STORE-FORWARD] Flushed alarm -> /logs/alarms: %s\n", ev.message);
    } else {
      break; // Keep remaining events safely in RAM until next cycle
    }
  }
}

void pushHistorySnapshotAndPrune(WiFiClientSecure& client, HTTPClient& http) {
  uint64_t epochSec = getEpochSec();
  if (epochSec == 0ULL) return; // Wait until NTP provides valid Unix time

  float tNow  = roundf(currentTemp * 10.0f) / 10.0f;
  float hNow  = roundf(currentHum * 10.0f) / 10.0f;
  float spNow = roundf(pidSetpoint * 10.0f) / 10.0f;
  int   pwmNow = emergencyStop ? 0 : outputPwm;
  bool  excursion = (tNow > maxTempAlarm);

  MAKE_JSON_DOC(doc, 192);
  doc["temp"]      = tNow;
  doc["hum"]       = hNow;
  doc["pwm"]       = pwmNow;
  doc["sp"]        = spNow;
  doc["excursion"] = excursion;

  String body;
  serializeJson(doc, body);
  String histPath = String("/history/") + LOCKER_KEY + "/" + String((unsigned long)epochSec);
  if (rtdbRequest(client, http, "PUT", histPath, body)) {
    Serial.printf("[HISTORY 5M] Logged %s -> T:%.1fC H:%.1f%% PWM:%d%% Exc:%s\n",
                  histPath.c_str(), tNow, hNow, pwmNow, excursion ? "YES" : "NO");

    // Lightweight shallow prune if > 288 samples (24h)
    String shallowUrl = String(RTDB_BASE_URL) + "/history/" + LOCKER_KEY + ".json?shallow=true";
    http.setTimeout(5000);
    if (http.begin(client, shallowUrl)) {
      if (http.GET() == 200) {
        String keysJson = http.getString();
        int count = 0;
        unsigned long minKey = ULONG_MAX;
        int idx = 0;
        while ((idx = keysJson.indexOf('"', idx)) >= 0) {
          int endIdx = keysJson.indexOf('"', idx + 1);
          if (endIdx < 0) break;
          String k = keysJson.substring(idx + 1, endIdx);
          unsigned long kv = strtoul(k.c_str(), nullptr, 10);
          if (kv > 1700000000UL) {
            count++;
            if (kv < minKey) minKey = kv;
          }
          idx = endIdx + 1;
        }
        http.end();
        if (count > MAX_HISTORY_SAMPLES && minKey != ULONG_MAX) {
          rtdbRequest(client, http, "DELETE",
                      String("/history/") + LOCKER_KEY + "/" + String(minKey), "");
        }
      } else {
        http.end();
      }
    }
  }
}

void syncCatalogAndRfidCache(WiFiClientSecure& client, HTTPClient& http) {
  String medIdCopy;
  if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    medIdCopy = medicineId;
    xSemaphoreGive(stateMutex);
  }
  if (medIdCopy.length() > 0) {
    String resp;
    if (rtdbRequest(client, http, "GET", "/medicine_catalog/" + medIdCopy, "", &resp)) {
      MAKE_JSON_DOC(doc, 384);
      if (!deserializeJson(doc, resp)) {
        float mT = doc["max_temp_alarm"] | maxTempAlarm;
        float mH = doc["max_hum_alarm"]  | maxHumAlarm;
        if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
          maxTempAlarm = mT;
          maxHumAlarm  = mH;
          xSemaphoreGive(stateMutex);
        }
      }
    }
  }

#if HAS_RFID
  String usersResp;
  if (rtdbRequest(client, http, "GET", "/users", "", &usersResp)) {
    MAKE_JSON_DOC(uDoc, 1536);
    if (!deserializeJson(uDoc, usersResp)) {
      String uidList = "";
      JsonObject root = uDoc.as<JsonObject>();
      for (JsonPair kv : root) {
        bool active = kv.value()["active"] | true;
        if (active) {
          if (uidList.length() > 0) uidList += ",";
          uidList += String(kv.key().c_str());
        }
      }
      if (uidList.length() > 0) {
        if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
          cachedRfidUids = uidList;
          xSemaphoreGive(stateMutex);
        }
        saveRfidCacheToNvs(uidList);
      }
    }
  }
#endif
}

// ============================================================================
// 11. CORE 0 BACKGROUND TASK: FIREBASE SYNC, STORE-AND-FORWARD & TELEGRAM
// ============================================================================
void firebaseSyncTask(void* parameter) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setReuse(true);

  bool ntpConfigured          = false;
  bool bootUnlockPurged       = false;
  unsigned long lastFullSync  = 0;
  unsigned long lastCatSync   = 0;
  unsigned long lastHistoryMs = 0;
  unsigned long lastWifiTryMs = 0;

  for (;;) {
    unsigned long now = millis();

    // Auto-reconnect Wi-Fi without blocking Core 1 local PID
    if (WiFi.status() != WL_CONNECTED) {
      firebaseSynced = false;
      if (now - lastWifiTryMs >= WIFI_RECONNECT_MS) {
        lastWifiTryMs = now;
        Serial.println("[WIFI] Reconnecting...");
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
      vTaskDelay(500 / portTICK_PERIOD_MS);
      continue;
    }

    if (!ntpConfigured) {
      configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com", "time.nist.gov");
      ntpConfigured = true;
    }

    // 0. Boot Safety Handshake: Proactively clear any stale unlock_cmd=true in RTDB before first read
    if (!bootUnlockPurged) {
      if (rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/control",
                      "{\"unlock_cmd\":false}")) {
        bootUnlockPurged = true;
        Serial.println("[BOOT GUARD] Initial RTDB unlock_cmd=false handshake confirmed.");
      }
    }

#if HAS_RFID
    // 1. High-Priority: Push tapped RFID UID to /auth/rfid_scan
    if (hasPendingRfid) {
      String uidToSend;
      if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        uidToSend = pendingRfidUid;
        hasPendingRfid = false;
        xSemaphoreGive(stateMutex);
      }
      MAKE_JSON_DOC(doc, 192);
      doc["uid"] = uidToSend;
      uint64_t ts = getEpochMs();
      doc["timestamp"] = (ts > 0ULL) ? ts : (uint64_t)millis();
      doc["processed"] = false;
      String body;
      serializeJson(doc, body);
      if (rtdbRequest(client, http, "PATCH", "/auth/rfid_scan", body)) {
        Serial.printf("[RFID -> RTDB] UID %s sent to /auth/rfid_scan\n", uidToSend.c_str());
      }
    }
#endif

    // 2. High-Priority: Reset unlock_cmd = false in Firebase (Retry every 1s if PATCH failed)
    if (clearUnlockFlagPending && (now - lastUnlockResetTryMs >= UNLOCK_RESET_RETRY_MS)) {
      lastUnlockResetTryMs = now;
      if (rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/control",
                      "{\"unlock_cmd\":false}")) {
        clearUnlockFlagPending = false;
        Serial.println("[RTDB] unlock_cmd confirmed reset to false");
      }
    }

    // 3. High-Priority: Push Door Open/Close transition immediately
    if (immediateDoorPushPending) {
      bool dNow = doorOpen;
      if (rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/sensor",
                      String("{\"door_open\":") + (dNow ? "true" : "false") + "}")) {
        immediateDoorPushPending = false;
      }
    }

    // 4. High-Priority: Push local alarm flag updates (FAN FAULT / FORCED ENTRY / OVER TEMP)
    if (alarmDirtyPending) {
      MAKE_JSON_DOC(aDoc, 256);
      aDoc["over_temp"]    = (bool)alarmOverTemp;
      aDoc["fan_fault"]    = (bool)alarmFanFault;
      aDoc["forced_entry"] = (bool)alarmForcedEntry;
      if (!alarmAcknowledged) {
        aDoc["acknowledged"] = false;
      }
      String aBody;
      serializeJson(aDoc, aBody);
      if (rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/alarm", aBody)) {
        alarmDirtyPending = false;
      }
    }

    // 4. Flush Store-and-Forward Alarm Queue & Send Telegram Alerts
    flushAlarmQueue(client, http);
    processPendingTelegramAlerts();

    // 5. Periodic Full Sync every 2000ms
    if (now - lastFullSync >= RTDB_SYNC_MS) {
      lastFullSync = now;

      // A. Read /system (emergency_stop + telegram config)
      String sysResp;
      if (rtdbRequest(client, http, "GET", "/system", "", &sysResp)) {
        MAKE_JSON_DOC(sysDoc, 512);
        if (!deserializeJson(sysDoc, sysResp)) {
          bool eNow = sysDoc["emergency_stop"] | false;
          emergencyStop = eNow;

          if (eNow && !prevEmergencyStop) {
#if LOCKER_ID == 1
            requestTelegramAlert(TG_ESTOP, "CRITICAL - E-STOP ENGAGED! All locker actuators halted.");
#endif
          }
          prevEmergencyStop = eNow;

          if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            tgEnabled     = sysDoc["telegram"]["enabled"] | false;
            tgBotToken    = String((const char*)(sysDoc["telegram"]["bot_token"] | ""));
            tgChatId      = String((const char*)(sysDoc["telegram"]["chat_id"]   | ""));
            tgCooldownSec = (unsigned long)(sysDoc["telegram"]["cooldown_sec"]   | 60);
            xSemaphoreGive(stateMutex);
          }
        }
      }

      // B. Read Local Locker Control & PID Config
      String locResp;
      if (rtdbRequest(client, http, "GET", String("/lockers/") + LOCKER_KEY, "", &locResp)) {
        MAKE_JSON_DOC(filter, 256);
        filter["meta"]["stock"]         = true;
        filter["meta"]["medicine_id"]   = true;
        filter["control"]               = true;
        filter["pid"]                   = true;
        filter["alarm"]["forced_entry"] = true;
        filter["alarm"]["acknowledged"] = true;

        MAKE_JSON_DOC(doc, 1024);
        if (!deserializeJson(doc, locResp, DeserializationOption::Filter(filter))) {
          JsonObject selfObj = doc.as<JsonObject>();
          if (!selfObj.isNull()) {
            String newMode = String((const char*)(selfObj["control"]["mode"] | "AUTO"));
            int    newMan  = selfObj["control"]["manual_pwm"] | 0;
            bool   unlock  = selfObj["control"]["unlock_cmd"] | false;
            float  newSp   = selfObj["pid"]["setpoint"] | pidSetpoint;
            float  newKp   = selfObj["pid"]["kp"] | pidKp;
            float  newKi   = selfObj["pid"]["ki"] | pidKi;
            float  newKd   = selfObj["pid"]["kd"] | pidKd;
            int    newStk  = selfObj["meta"]["stock"] | (int)currentStock;
            String newMed  = String((const char*)(selfObj["meta"]["medicine_id"] | medicineId.c_str()));
            bool   remFE   = selfObj["alarm"]["forced_entry"] | false;
            bool   remAck  = selfObj["alarm"]["acknowledged"] | true;

            if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
              controlMode  = newMode;
              manualPwm    = newMan;
              pidSetpoint  = newSp;
              pidKp        = newKp;
              pidKi        = newKi;
              pidKd        = newKd;
              currentStock = newStk;
              medicineId   = newMed;
              xSemaphoreGive(stateMutex);
            }

            // Respect Web HMI ACK / Clear Faults once door is safely closed
            if (!doorOpen && !remFE && alarmForcedEntry && !alarmDirtyPending) {
              alarmForcedEntry = false;
            }
            if (remAck && !alarmDirtyPending) {
              alarmAcknowledged = true;
            }

            // Boot Lock Guard & Anti Re-Trigger unlock_cmd:
            // 1. On initial boot sync (!initialRtdbSyncComplete) or inside BOOT_LOCK_GUARD_MS,
            //    NEVER unlock; purge any stale unlock_cmd=true sitting in Firebase from before boot.
            // 2. After boot sync is complete, ONLY accept unlock_cmd=true when FSM is in LOCK_STATE_LOCKED
            //    and previous unlock_cmd has been confirmed false.
            if (!initialRtdbSyncComplete) {
              initialRtdbSyncComplete = true;
              remoteUnlockReq = false;
              if (unlock) {
                Serial.println("[BOOT GUARD] Purging stale unlock_cmd=true at startup (Solenoid stays LOCKED)");
                clearUnlockFlagPending = true;
                waitUnlockFalseConfirm = true;
                lastUnlockResetTryMs   = now;
                if (rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/control",
                                "{\"unlock_cmd\":false}")) {
                  clearUnlockFlagPending = false;
                  waitUnlockFalseConfirm = false;
                }
              }
            } else if (!unlock) {
              waitUnlockFalseConfirm = false;
            } else if (!emergencyStop && now >= BOOT_LOCK_GUARD_MS) {
              if (lockState == LOCK_STATE_LOCKED &&
                  !remoteUnlockReq &&
                  !clearUnlockFlagPending &&
                  !waitUnlockFalseConfirm) {
                waitUnlockFalseConfirm = true;
                clearUnlockFlagPending = true;
                remoteUnlockReq        = true;
                lastUnlockResetTryMs   = now;
                if (rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/control",
                                "{\"unlock_cmd\":false}")) {
                  clearUnlockFlagPending = false;
                  waitUnlockFalseConfirm = false;
                }
              } else {
                // Ignore duplicate unlock_cmd while FSM is active, but ensure RTDB flag is cleared
                clearUnlockFlagPending = true;
              }
            } else if (unlock) {
              // Inside boot guard window or E-STOP -> keep locked and clear RTDB flag
              clearUnlockFlagPending = true;
            }

            saveConfigToNvsIfChanged(newSp, newKp, newKi, newKd, newMode, newMan,
                                     maxTempAlarm, maxHumAlarm, newMed, newStk);
          }
        }
      }

      // C. Patch Heartbeat, Sensor & PID Output to RTDB
      uint64_t ep = getEpochSec();
      unsigned long hbVal = (ep > 0ULL) ? (unsigned long)ep : (millis() / 1000UL);
      rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/meta",
                  String("{\"status\":\"online\",\"heartbeat\":") + hbVal + "}");

      MAKE_JSON_DOC(sensorDoc, 256);
      sensorDoc["temp"]      = roundf(currentTemp * 10.0f) / 10.0f;
      sensorDoc["humidity"]  = roundf(currentHum * 10.0f) / 10.0f;
      sensorDoc["door_open"] = (bool)doorOpen;
      sensorDoc["fan_rpm"]   = (int)currentRpm;
      String sensorBody;
      serializeJson(sensorDoc, sensorBody);
      bool okSensor = rtdbRequest(client, http, "PATCH",
                                  String("/lockers/") + LOCKER_KEY + "/sensor", sensorBody);
      firebaseSynced = okSensor;

      rtdbRequest(client, http, "PATCH", String("/lockers/") + LOCKER_KEY + "/pid",
                  String("{\"output_pwm\":") + outputPwm + "}");

      String faultStr = "";
      if (alarmOverTemp)    faultStr += "OT ";
      if (alarmFanFault)    faultStr += "FF ";
      if (alarmForcedEntry) faultStr += "FE ";
      faultStr.trim();
      if (faultStr.length() == 0) faultStr = "OK";

      Serial.printf("[%s] T:%.1fC(SP:%.1fC) H:%.1f%% Door:%s Fan:%d%%(%dRPM) Fault:%s RTDB:%s\n",
                    ESP_LABEL, currentTemp, pidSetpoint, currentHum,
                    doorOpen ? "OPEN" : "CLSD",
                    outputPwm, currentRpm,
                    faultStr.c_str(),
                    okSensor ? "SYNC" : "ERR");
    }

    // 6. Periodic 3-Second Remote Lockers Fetch for OLED Watchdog (#if HAS_OLED)
#if HAS_OLED
    if (lastRemoteOledFetchMs == 0 || (now - lastRemoteOledFetchMs >= OLED_REMOTE_FETCH_MS)) {
      lastRemoteOledFetchMs = now;
      fetchRemoteLockersForOled(client, http);
    }
#endif

    // 7. Periodic Catalog Limits & RFID Offline Cache Sync (Every 60s)
    if (lastCatSync == 0 || (now - lastCatSync >= CATALOG_SYNC_MS)) {
      lastCatSync = now;
      syncCatalogAndRfidCache(client, http);
    }

    // 7. Periodic 5-Minute Historical Snapshot to /history/locker_X
    if (now - lastHistoryMs >= HISTORY_INTERVAL_MS) {
      if (getEpochSec() > 0ULL) {
        lastHistoryMs = now;
        pushHistorySnapshotAndPrune(client, http);
      }
    }

    vTaskDelay(40 / portTICK_PERIOD_MS);
  }
}

// ============================================================================
// 12. SETUP & REAL-TIME LOCAL CONTROL LOOP (CORE 1)
// ============================================================================
void setup() {
  // 1. IMMEDIATE Safe Relay Boot Init (Active-LOW -> RELAY_OFF / HIGH = Solenoid LOCKED)
  // MUST execute at microsecond 0 BEFORE Serial.begin() or any delay() so GPIO 26 never glitches LOW
  digitalWrite(RELAY_PIN, RELAY_OFF);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);
  currentRelayLevel = RELAY_OFF;
  lockState         = LOCK_STATE_LOCKED;

  Serial.begin(115200);
  delay(300);
  Serial.println("\n=======================================================");
  Serial.printf("SMART MEDICINE LOCKER V2 — %s (%s)\n", ESP_LABEL, LOCKER_LABEL);
  Serial.printf("Modules: RFID=%s | OLED=%s\n", HAS_RFID ? "ON" : "OFF", HAS_OLED ? "ON" : "OFF");
  Serial.println("=======================================================");

  stateMutex = xSemaphoreCreateMutex();
  memset(tgAlerts, 0, sizeof(tgAlerts));

  // 2. Door Switch & Fan Tachometer
  pinMode(PIN_DOOR_REED, INPUT_PULLUP);
  bool initialDoor = (digitalRead(PIN_DOOR_REED) == HIGH);
  doorOpen                 = initialDoor;
  prevDoorOpen             = initialDoor;
  lastRawDoor              = initialDoor;
  forcedLatchActive        = initialDoor;
  authorizedDoorOpenActive = initialDoor;

  pinMode(PIN_FAN_TACH, INPUT_PULLUP);
  tachIsLow = !fastReadGpio(PIN_FAN_TACH);
  attachInterrupt(digitalPinToInterrupt(PIN_FAN_TACH), onTachChange, CHANGE);

  // 3. 25 kHz PWM Fan Init (ESP32 Arduino Core 2.x & 3.x compatible)
#if defined(ESP_ARDUINO_VERSION) && ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
  ledcAttach(PIN_FAN_PWM, PWM_FREQ, PWM_RES);
#else
  ledcSetup(PWM_CHANNEL, PWM_FREQ, PWM_RES);
  ledcAttachPin(PIN_FAN_PWM, PWM_CHANNEL);
#endif
  writeFanPwm(0);

  // 4. Load Last Known Config from NVS Flash FIRST (True Offline Failsafe)
  loadConfigFromNvs();
  dht.begin();

#if HAS_OLED
  initOledDisplay();
#endif

#if HAS_RFID
  pinMode(PIN_RFID_SS, OUTPUT);
  digitalWrite(PIN_RFID_SS, HIGH);
  SPI.begin(PIN_RFID_SCK, PIN_RFID_MISO, PIN_RFID_MOSI, PIN_RFID_SS);
  rfid.PCD_Init();
  delay(50);
  checkAndRecoverRfidReader();
#endif

  // 5. Bounded Non-Blocking Wi-Fi Connect (Max 8s -> continue in Offline Failsafe if down)
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WIFI] Connecting to %s ", WIFI_SSID);
  unsigned long bootWifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - bootWifiStart < WIFI_BOOT_TIMEOUT_MS)) {
    delay(400);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WIFI] Offline at boot -> Running NVS Local PID Failsafe Mode!");
  }

  // 6. Launch Core 0 Network Task (16 KB Stack for TLS + JSON + Telegram)
  xTaskCreatePinnedToCore(
    firebaseSyncTask,
    "FirebaseSyncTask",
    16384,
    NULL,
    1,
    NULL,
    0
  );
}

void loop() {
  unsigned long now = millis();

#if HAS_RFID
  // 1. Instant RFID Card Polling (Core 1 — Zero Wi-Fi Lag)
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uidStr = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      if (rfid.uid.uidByte[i] < 0x10) uidStr += "0";
      uidStr += String(rfid.uid.uidByte[i], HEX);
    }
    uidStr.toUpperCase();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("\n>>> [RFID TAP] UID: %s (Sending to Firebase) <<<\n", uidStr.c_str());
      if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        pendingRfidUid = uidStr;
        hasPendingRfid = true;
        xSemaphoreGive(stateMutex);
      }
    } else {
      bool validOffline = isUidInOfflineCache(uidStr);
      Serial.printf("\n>>> [RFID OFFLINE CACHE] UID: %s -> %s <<<\n",
                    uidStr.c_str(), validOffline ? "AUTHORIZED" : "DENIED");
    }

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  // Periodic RC522 health check & auto-recovery (every 3s)
  if (now - lastRfidCheckMs >= 3000UL) {
    lastRfidCheckMs = now;
    checkAndRecoverRfidReader();
  }
#endif

  // 2. 150ms Software Debounce for Door Magnetic Switch (GPIO 27)
  bool rawDoorOpen = (digitalRead(PIN_DOOR_REED) == HIGH);
  if (rawDoorOpen != lastRawDoor) {
    lastRawDoor = rawDoorOpen;
    lastDoorBounceMs = now;
  }
  if ((now - lastDoorBounceMs) >= DOOR_DEBOUNCE_MS && rawDoorOpen != doorOpen) {
    doorOpen = rawDoorOpen;
    immediateDoorPushPending = true;
    Serial.printf("[DOOR] GPIO 27 (150ms debounced) -> %s\n", doorOpen ? "OPEN" : "CLOSED");

    // When an authorized open door is finally closed, start 2s post-close grace & re-arm security
    if (!doorOpen && authorizedDoorOpenActive) {
      authorizedDoorOpenActive = false;
      lastRelockMs = now;
      forcedOpenStartMs = 0UL;
      forcedLatchActive = false;
    }
  }

  // 3. E-STOP Override & 4-Stage Solenoid Finite State Machine (FSM)
  if (emergencyStop) {
    remoteUnlockReq   = false;
    forcedOpenStartMs = 0UL;
    if (lockState != LOCK_STATE_LOCKED) {
      setLockFsmState(LOCK_STATE_LOCKED, now, "E-STOP Override");
    }
  } else {
    switch (lockState) {
      case LOCK_STATE_LOCKED:
        if (remoteUnlockReq && initialRtdbSyncComplete && (now >= BOOT_LOCK_GUARD_MS)) {
          remoteUnlockReq = false;
          authorizedDoorOpenActive = true;
          setLockFsmState(LOCK_STATE_WAIT_OPEN, now, "Unlock command accepted");
        } else if (remoteUnlockReq && (!initialRtdbSyncComplete || (now < BOOT_LOCK_GUARD_MS))) {
          // Discard any premature unlock request during boot guard window
          remoteUnlockReq = false;
        }
        break;

      case LOCK_STATE_WAIT_OPEN:
        forcedOpenStartMs = 0UL;
        authorizedDoorOpenActive = true;
        if (doorOpen) {
          lockOpenStartMs = now;
          setLockFsmState(LOCK_STATE_DOOR_OPEN, now, "Door opened");
        } else if ((now - lockStateStartMs) >= LOCK_WAIT_OPEN_TIMEOUT_MS) {
          authorizedDoorOpenActive = false;
          setLockFsmState(LOCK_STATE_LOCKED, now, "Wait-open timeout (10s, door never opened)");
        }
        break;

      case LOCK_STATE_DOOR_OPEN:
        forcedOpenStartMs = 0UL;
        authorizedDoorOpenActive = true;
        if ((now - lockOpenStartMs) >= LOCK_MAX_OPEN_HOLD_MS) {
          // Turn off solenoid coil after 10s to prevent overheating,
          // but keep authorizedDoorOpenActive = true until door is actually closed!
          setLockFsmState(LOCK_STATE_LOCKED, now, "Max open hold 10s (coil off, door still authorized open)");
        } else if (!doorOpen) {
          closeStableStartMs = now;
          setLockFsmState(LOCK_STATE_CLOSING_CONFIRM, now, "Door closed detected");
        }
        break;

      case LOCK_STATE_CLOSING_CONFIRM:
        forcedOpenStartMs = 0UL;
        if (doorOpen) {
          // Re-opened before 2s confirm finished -> return to DOOR_OPEN without resetting lockOpenStartMs
          authorizedDoorOpenActive = true;
          setLockFsmState(LOCK_STATE_DOOR_OPEN, now, "Door re-opened before 2s confirm");
        } else if (((now - closeStableStartMs) >= LOCK_CLOSING_CONFIRM_MS) ||
                   ((now - lockOpenStartMs) >= LOCK_MAX_OPEN_HOLD_MS)) {
          authorizedDoorOpenActive = false;
          setLockFsmState(LOCK_STATE_LOCKED, now, "Door closed confirmed (2s)");
        }
        break;
    }
  }

  // 4. Anti-Glitch FORCED ENTRY Detection (Requires 500ms Continuous Raw OPEN in LOCKED state)
  // Never triggers if door is still open from a previous authorized Unlock (authorizedDoorOpenActive)!
  bool canEvaluateForcedEntry =
    (lockState == LOCK_STATE_LOCKED) &&
    (!authorizedDoorOpenActive) &&
    (now > BOOT_GRACE_MS) &&
    (lastRelockMs == 0UL || (now - lastRelockMs) > RELOCK_GRACE_MS);

  if (!canEvaluateForcedEntry) {
    forcedOpenStartMs = 0UL;
    if (!rawDoorOpen) {
      forcedLatchActive = false;
    }
  } else {
    if (rawDoorOpen) {
      if (forcedOpenStartMs == 0UL) {
        forcedOpenStartMs = now;
      } else if (((now - forcedOpenStartMs) >= FORCED_ENTRY_STABLE_MS) && !forcedLatchActive) {
        forcedLatchActive = true;
        if (!alarmForcedEntry) {
          alarmForcedEntry  = true;
          alarmAcknowledged = false;
          alarmDirtyPending = true;
          String msg = String(LOCKER_LABEL) + ": FORCED ENTRY (Unauthorized door open)";
          enqueueAlarmEvent("CRITICAL", msg);
          requestTelegramAlert(TG_FORCED_ENTRY, String("CRITICAL - FORCED ENTRY on ") + LOCKER_LABEL + "!");
          Serial.println("[SECURITY] !!! FORCED ENTRY DETECTED (Stable >= 500ms) !!!");
        }
      }
    } else {
      // Sensor returned to CLOSED before 500ms (glitch/EMI) or door closed after incident
      forcedOpenStartMs = 0UL;
      forcedLatchActive = false;
    }
  }
  prevDoorOpen = doorOpen;

  // 5. Local Edge PID, DHT22, Tachometer, FAN FAULT & OVER TEMP Loop (Every 2.0s)
  if (now - lastControlLoopMs >= CONTROL_LOOP_MS) {
    float dtSec = (now - lastControlLoopMs) / 1000.0f;
    lastControlLoopMs = now;

    // Tachometer RPM (RPM = pulses * 60 / (PPR * dtSec), clamp <= FAN_MAX_RPM_VALID)
    noInterrupts();
    unsigned long pulses = tachPulses;
    tachPulses = 0;
    interrupts();
    int rawRpm = (dtSec > 0.0f)
                   ? (int)roundf((pulses * 60.0f) / ((float)FAN_PULSES_PER_REV * dtSec))
                   : 0;
    if (rawRpm > FAN_MAX_RPM_VALID) rawRpm = FAN_MAX_RPM_VALID;
    if (rawRpm == 0 || currentRpm == 0) {
      currentRpm = rawRpm;
    } else {
      currentRpm = (int)roundf((currentRpm * 0.35f) + (rawRpm * 0.65f));
    }

    // Read DHT22
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t) && !isnan(h)) {
      currentTemp = t;
      currentHum  = h;
    }

    // Read mode safely and compute Reverse-Acting PID
    String modeCopy = "AUTO";
    int    manCopy  = 0;
    float  spCopy   = 25.0f;
    float  maxTCopy = 28.0f;
    if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      modeCopy = controlMode;
      manCopy  = manualPwm;
      spCopy   = pidSetpoint;
      maxTCopy = maxTempAlarm;
      xSemaphoreGive(stateMutex);
    }

    if (emergencyStop) {
      writeFanPwm(0);
    } else if (modeCopy == "MANUAL") {
      writeFanPwm(manCopy);
    } else {
      writeFanPwm(computeReverseActingPid(currentTemp, spCopy, dtSec));
    }

    // Predictive Maintenance: FAN FAULT (PWM > 30% for > 5s & RPM == 0 while !E-STOP)
    if (!emergencyStop && outputPwm > 30 && currentRpm == 0) {
      if (fanZeroStartMs == 0) {
        fanZeroStartMs = now;
      } else if ((now - fanZeroStartMs >= FAN_FAULT_DELAY_MS) && !alarmFanFault) {
        alarmFanFault     = true;
        alarmAcknowledged = false;
        alarmDirtyPending = true;
        String msg = String(LOCKER_LABEL) + ": FAN FAULT (PWM " + String(outputPwm) + "%, 0 RPM)";
        enqueueAlarmEvent("CRITICAL", msg);
        requestTelegramAlert(TG_FAN_FAULT, msg);
        Serial.println("[DIAG] !!! FAN FAULT DETECTED !!!");
      }
    } else {
      fanZeroStartMs = 0;
      if (alarmFanFault) {
        alarmFanFault     = false;
        alarmDirtyPending = true;
        Serial.println("[DIAG] Fan Fault cleared.");
      }
    }

    // Local OVER TEMP Alarm (Works both Online & Offline!)
    bool isOverTemp = (currentTemp > maxTCopy);
    if (isOverTemp && !alarmOverTemp) {
      alarmOverTemp     = true;
      alarmAcknowledged = false;
      alarmDirtyPending = true;
      String msg = String(LOCKER_LABEL) + ": OVER TEMP (" + String(currentTemp, 1) +
                   "C > " + String(maxTCopy, 1) + "C)";
      enqueueAlarmEvent("CRITICAL", msg);
      requestTelegramAlert(TG_OVER_TEMP, msg);
    } else if (!isOverTemp && alarmOverTemp) {
      alarmOverTemp     = false;
      alarmDirtyPending = true;
    }
  }

#if HAS_OLED
  // 6. Non-Blocking OLED 3-Slide Auto-Rotation (3000ms) & Redraw (250ms)
  if (now - lastOledRotateMs >= OLED_ROTATE_MS) {
    lastOledRotateMs = now;
    oledSlideIndex = (oledSlideIndex + 1) % 3;
  }
  if (now - lastOledRefreshMs >= OLED_REFRESH_MS) {
    lastOledRefreshMs = now;
    renderOledScreen();
  }
#endif

  delay(15);
}
