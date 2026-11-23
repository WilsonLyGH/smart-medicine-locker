# Smart Medicine Locker — DCS/SCADA System & Hardware Specification

## 1. System Overview & DCS Architecture
Sistem ini adalah **Smart Medicine Locker** berbasis **Distributed Control System (DCS)** dan **SCADA Web HMI** menggunakan **Firebase Realtime Database (RTDB)**. Terdapat **3 kompartemen loker identik** yang masing-masing dikontrol secara independen oleh 1 mikrokontroler ESP32 agar sistem bersifat *fault-tolerant* (jika 1 node offline, 2 loker lain tetap menjalankan kontrol PID lokal secara normal).

### Pembagian Node ESP32
| Node ID | Loker | Input (Sensor) | Output (Aktuator) | Tugas Lokal (Edge) |
| :--- | :--- | :--- | :--- | :--- |
| **ESP 1** | `locker_1` (Master Access) | 1× RFID Reader (Passkey utama), 1× DHT22, 1× Magnetic Door Switch | 1× Relay + Solenoid Lock 12V, 1× 4-Pin PWM Fan | Membaca UID RFID & mengirim ke `/auth/rfid_scan` untuk login HMI, kontrol PID Fan Loker 1, baca RPM & status pintu |
| **ESP 2** | `locker_2` | 1× DHT22, 1× Magnetic Door Switch | 1× Relay + Solenoid Lock 12V, 1× 4-Pin PWM Fan | Kontrol PID Fan Loker 2 mandiri, kontrol solenoid, baca RPM & status pintu |
| **ESP 3** | `locker_3` | 1× DHT22, 1× Magnetic Door Switch | 1× Relay + Solenoid Lock 12V, 1× 4-Pin PWM Fan | Kontrol PID Fan Loker 3 mandiri, kontrol solenoid, baca RPM & status pintu |

### Spesifikasi Hardware Kunci
* **DHT22:** Mengukur suhu (°C) dan kelembapan (%RH). Sampling rate maksimal 0.5 Hz (interval pembacaan ≥ 2 detik).
* **Magnetic Door Switch (Reed Switch):** Mendeteksi status pintu (`door_open: true` = OPEN, `false` = CLOSED).
* **Relay + Solenoid Lock (3 unit):** 1 relay mengendalikan 1 solenoid per loker. Menggunakan logika *auto-relock* di sisi ESP32 (pulse buka 3–5 detik atau langsung off saat pintu terdeteksi `OPEN` agar koil tidak panas).
* **4-Pin PWM Fan (3 unit):** Menggunakan kontrol PWM (25 kHz pada ESP32) sebagai *Manipulated Variable* (`0–100%`) dari algoritma **Reverse-Acting PID** ($\text{Error} = T_{\text{aktual}} - T_{\text{setpoint}}$), serta membaca pin *Tachometer* untuk menampilkan kecepatan aktual dalam **RPM**.
* **RFID Reader (1 unit di ESP 1):** Berfungsi sebagai *passkey* terpusat untuk login ke HMI tanpa perlu mengetik username/password.

---

## 2. Firebase Realtime Database (RTDB) Schema
Gunakan struktur JSON berikut sebagai skema tunggal (*single source of truth*) antara Web HMI dan 3 ESP32:

```json
{
  "system": {
    "emergency_stop": false,
    "global_alarm": false
  },
  "auth": {
    "rfid_scan": {
      "uid": "",
      "timestamp": 0,
      "processed": true
    }
  },
  "users": {
    "RFID_ADMIN_01": {
      "name": "Administrator",
      "role": "admin",
      "username": "admin",
      "password": "<REDACTED_PASSWORD>",
      "active": true
    },
    "RFID_OP_01": {
      "name": "Operator Farmasi",
      "role": "operator",
      "username": "operator",
      "password": "<REDACTED_PASSWORD>",
      "active": true
    }
  },
  "medicine_catalog": {
    "med_general": {
      "name": "Obat Umum (General)",
      "category": "Standard Room",
      "default_setpoint_temp": 25.0,
      "max_temp_alarm": 28.0,
      "max_hum_alarm": 70.0,
      "min_stock_alarm": 5
    },
    "med_antibiotic": {
      "name": "Antibiotik Kapsul",
      "category": "Cool Dry",
      "default_setpoint_temp": 22.0,
      "max_temp_alarm": 25.0,
      "max_hum_alarm": 60.0,
      "min_stock_alarm": 10
    },
    "med_syrup": {
      "name": "Sirup & Larutan",
      "category": "Controlled Room",
      "default_setpoint_temp": 23.0,
      "max_temp_alarm": 26.0,
      "max_hum_alarm": 65.0,
      "min_stock_alarm": 5
    },
    "med_heat_sensitive": {
      "name": "Obat Sensitif Panas",
      "category": "Cool Storage",
      "default_setpoint_temp": 18.0,
      "max_temp_alarm": 21.0,
      "max_hum_alarm": 60.0,
      "min_stock_alarm": 5
    }
  },
  "lockers": {
    "locker_1": {
      "meta": {
        "name": "Locker 1",
        "esp_id": "esp_1",
        "status": "online",
        "heartbeat": 1700000000,
        "medicine_id": "med_general",
        "medicine_name": "Obat Umum (General)",
        "stock": 20
      },
      "sensor": {
        "temp": 25.4,
        "humidity": 58.0,
        "door_open": false,
        "fan_rpm": 1200
      },
      "control": {
        "unlock_cmd": false,
        "mode": "AUTO",
        "manual_pwm": 0
      },
      "pid": {
        "setpoint": 25.0,
        "kp": 12.0,
        "ki": 0.5,
        "kd": 2.0,
        "output_pwm": 35
      },
      "alarm": {
        "over_temp": false,
        "high_hum": false,
        "door_left_open": false,
        "low_stock": false,
        "acknowledged": true
      }
    },
    "locker_2": {
      "meta": {
        "name": "Locker 2",
        "esp_id": "esp_2",
        "status": "online",
        "heartbeat": 1700000000,
        "medicine_id": "med_general",
        "medicine_name": "Obat Umum (General)",
        "stock": 15
      },
      "sensor": {
        "temp": 24.8,
        "humidity": 56.5,
        "door_open": false,
        "fan_rpm": 950
      },
      "control": {
        "unlock_cmd": false,
        "mode": "AUTO",
        "manual_pwm": 0
      },
      "pid": {
        "setpoint": 25.0,
        "kp": 12.0,
        "ki": 0.5,
        "kd": 2.0,
        "output_pwm": 20
      },
      "alarm": {
        "over_temp": false,
        "high_hum": false,
        "door_left_open": false,
        "low_stock": false,
        "acknowledged": true
      }
    },
    "locker_3": {
      "meta": {
        "name": "Locker 3",
        "esp_id": "esp_3",
        "status": "online",
        "heartbeat": 1700000000,
        "medicine_id": "med_general",
        "medicine_name": "Obat Umum (General)",
        "stock": 10
      },
      "sensor": {
        "temp": 26.1,
        "humidity": 61.0,
        "door_open": false,
        "fan_rpm": 1650
      },
      "control": {
        "unlock_cmd": false,
        "mode": "AUTO",
        "manual_pwm": 0
      },
      "pid": {
        "setpoint": 25.0,
        "kp": 12.0,
        "ki": 0.5,
        "kd": 2.0,
        "output_pwm": 55
      },
      "alarm": {
        "over_temp": false,
        "high_hum": false,
        "door_left_open": false,
        "low_stock": false,
        "acknowledged": true
      }
    }
  },
  "logs": {
    "transactions": {},
    "alarms": {}
  }
}
```

---

## 3. UI/UX Design & Multi-Page HMI Architecture
Gunakan tema **Industrial Dark SCADA HMI** (`slate-950` / `slate-900`, border tipis `slate-700`, font monospace untuk seluruh pembacaan numerik sensor/PID/RPM, aksen warna standar industri: Hijau = Normal/Running, Kuning = Warning/Door Open, Merah = Alarm/Emergency Stop, Biru/Cyan = Setpoint/Info).

### Page 1: Login Page (Dual Authentication)
1. **Mode Utama — Tap Kartu RFID:**
   * Menampilkan animasi indikator *"Waiting for RFID Card Tap..."* yang memantau `/auth/rfid_scan` secara real-time.
   * Jika `processed === false` dan `uid` cocok dengan data aktif di `/users/{uid}`, sistem langsung mengeset `processed: true` dan otomatis login sesuai `role` (`admin` atau `operator`).
   * Jika UID tidak terdaftar, tampilkan notifikasi *"Kartu RFID Tidak Terdaftar / Akses Ditolak"*.
2. **Mode Fallback — Login Manual (Username & Password):**
   * Tab/toggle kecil untuk login manual menggunakan akun pada `/users` (berguna untuk kontrol jarak jauh/remote demo tanpa reader RFID fisik).

### Page 2: Main SCADA Dashboard (Akses: Operator & Administrator)
1. **Top Navigation & Global Status Bar:**
   * Nama sistem, jam real-time, info user yang sedang login (`Name` + badge `ADMIN` / `OPERATOR`), tombol Logout.
   * Tombol navigasi ke **PID Tuning & Config Page** (hanya muncul & dapat diakses jika role === `admin`).
   * Tombol **Emergency Stop** (dengan modal konfirmasi): mengeset `/system/emergency_stop = true`, menonaktifkan seluruh kontrol aktuator, dan menampilkan banner merah di bagian atas.
2. **Visualisasi 3 Unit Loker (Grid 3 Kolom Sejajar):**
   * Setiap kartu loker merepresentasikan lemari fisik yang berisi:
     * **Header:** Nama Loker, jenis obat aktif (`medicine_name`), badge `ONLINE` / `OFFLINE` (otomatis `OFFLINE` jika `heartbeat` tidak berubah > 10 detik), dan badge mode (`AUTO PID` / `MANUAL`).
     * **Visual Pintu & Solenoid:** Indikator grafis status pintu (`OPEN` / `CLOSED`), status kunci (`LOCKED` / `UNLOCKED`), dan tombol **UNLOCK LOCKER** (mengirim `unlock_cmd: true`).
     * **Telemetry Lingkungan:** Angka besar **Suhu (°C)** vs **Setpoint (°C)**, **Kelembapan (%RH)**, serta **Status Fan** (bar persentase **PWM 0–100%** + animasi ikon kipas berputar sesuai kecepatan + nilai **RPM**).
     * **Inventaris Obat:** Jumlah stok obat saat ini (dengan indikator peringatan jika di bawah `min_stock_alarm`).
3. **Alarm Management Panel (ISA-18.2 Style):**
   * Menampilkan alarm aktif: *Over-Temp*, *High Humidity*, *Door Left Open (> 30 detik)*, dan *Low Stock*.
   * Alarm baru berkedip (*Unacknowledged*) hingga operator menekan tombol **ACK (Acknowledge)**.
4. **Audit Trail / Riwayat Transaksi Obat:**
   * Tabel real-time dari `/logs/transactions` berisi: `Waktu | User (Nama & UID) | Loker | Obat | Aksi (Ambil/Simpan/Inspeksi) | Jumlah | Stok Akhir | Catatan`.

### Page 3: Mandatory Inventory Pop-up Modal (Hard Interlock)
* **Trigger:** Muncul otomatis segera setelah pintu loker terdeteksi terbuka (`door_open` berubah `false -> true`) atau setelah tombol `UNLOCK LOCKER` ditekan.
* **Aturan Ketat (Non-Dismissible):**
  * Modal **tidak boleh punya tombol Close (`X`)**, tidak bisa ditutup dengan tombol `ESC`, dan tidak bisa ditutup dengan mengklik area di luar modal.
  * Simpan status modal aktif di `localStorage` sehingga jika user me-refresh halaman sebelum input, pop-up langsung muncul kembali.
  * **Peringatan jika diabaikan:** Jika user mencoba mengklik area luar modal atau membiarkan modal terbuka tanpa input > 15 detik, tampilkan **banner peringatan merah berkedip + pesan audio/visual**: *"PERINGATAN: Anda wajib memasukkan data pengambilan/penyimpanan obat sebelum melanjutkan akses HMI!"*
* **Isi Form Pop-up:**
  * Info loker yang dibuka, nama obat, dan stok sebelum transaksi.
  * Pilihan Aksi: **Ambil Obat (-)**, **Simpan Obat (+)**, atau **Cek Fisik / Inspeksi (0 — wajib isi catatan)**.
  * Input jumlah obat (angka bulat positif; validasi agar pengambilan tidak melebihi stok).
  * Tombol **Submit & Konfirmasi**: otomatis memperbarui `/lockers/{id}/meta/stock`, mencatat ke `/logs/transactions`, dan membuka kembali akses HMI.

### Page 4: PID Tuning & System Configuration (Akses: ADMINISTRATOR ONLY)
Halaman terpisah yang diproteksi *role guard* (jika `operator` mencoba membuka, langsung alihkan kembali ke Dashboard dengan peringatan akses ditolak). Terdiri dari 3 tab/bagian:
1. **PID Tuning & Real-Time Response Monitor (Per Loker 1, 2, 3):**
   * Selector untuk memilih Loker 1, Loker 2, atau Loker 3.
   * **Real-Time Multi-Line Chart (Chart.js):** Menampilkan 3 garis sekaligus secara live (30 titik data terakhir): **Setpoint ($SP$)**, **Suhu Aktual ($PV$)**, dan **Fan PWM Output ($MV\%$)** pada sumbu Y sekunder.
   * **Form Parameter PID:** Input numerik untuk `Setpoint (°C)`, `Kp`, `Ki`, `Kd` + tombol **Apply to ESP32** (menulis ke `/lockers/{id}/pid`).
   * **Mode Override:** Toggle **AUTO (PID)** vs **MANUAL (PWM Slider 0–100%)** untuk pengetesan langsung 4-pin fan.
2. **Medicine Catalog & Locker Assignment:**
   * Form untuk memilih jenis obat tiap loker dari daftar `/medicine_catalog` (dengan opsi checkbox *"Otomatis terapkan Setpoint Suhu dari Preset Obat"*).
   * Form **Tambah Jenis Obat Baru** (Nama obat, kategori, target suhu default, batas suhu max, batas kelembapan max, batas stok minimum) yang langsung tersimpan ke `/medicine_catalog`.
3. **RFID User Management & Hardware Simulator (Opsional untuk Testing):**
   * Daftar user RFID (`/users`) dengan fitur tambah/hapus kartu dan atur role (`admin`/`operator`).
   * Panel kecil **Test / Simulation Helper** (tersembunyi di toggle khusus Admin) untuk mensimulasikan tap kartu RFID atau mengubah status pintu/suhu saat demo tanpa perangkat fisik.