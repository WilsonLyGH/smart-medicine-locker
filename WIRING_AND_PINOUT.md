# Smart Medicine Locker — Hardware Wiring & GPIO Pinout Guide

Panduan perakitan hardware untuk **1× ESP32 38-Pin (`ESP 1` Master)** dan **2× ESP32 30-Pin (`ESP 2` & `ESP 3`)** sesuai [HARDWARE_SPEC.md](file:///c:/Users/alidz/OneDrive/Documents/00%20Teori/DCS/scada-medicine-locker/HARDWARE_SPEC.md).

---

## 1. Pembagian Board ESP32
| Node | Board Fisik | Target RTDB | Komponen yang Terpasang |
| :--- | :--- | :--- | :--- |
| **ESP 1 (Master)** | **ESP32 38-Pin (1 Pcs)** | `/lockers/locker_1` & `/auth/rfid_scan` | 1× **RFID-RC522**, 1× DHT22, 1× Magnetic Door Switch, 1× Relay Active-LOW + Solenoid 12V, 1× 4-Pin PWM Fan 12V |
| **ESP 2 (OLED HMI)** | **ESP32 30-Pin (Pcs #1)** | `/lockers/locker_2` | 1× **OLED 0.96" I2C (SSD1306)**, 1× DHT22, 1× Magnetic Door Switch, 1× Relay Active-LOW + Solenoid 12V, 1× 4-Pin PWM Fan 12V |
| **ESP 3** | **ESP32 30-Pin (Pcs #2)** | `/lockers/locker_3` | 1× DHT22, 1× Magnetic Door Switch, 1× Relay Active-LOW + Solenoid 12V, 1× 4-Pin PWM Fan 12V |

---

## 2. Tabel Pinout GPIO Terpadu (Sama untuk 30-Pin & 38-Pin)
Seluruh pin di bawah dipilih agar **identik di board 30-pin maupun 38-pin**, memiliki resistor *internal pull-up*, dan tidak bentrok dengan *strapping pins* saat boot:

### A. Sensor & Aktuator Loker (Dipasang di `ESP 1`, `ESP 2`, dan `ESP 3`)
| Komponen | Pin Komponen | Pin ESP32 | Tegangan / Catatan |
| :--- | :--- | :--- | :--- |
| **DHT22 Sensor** | `VCC` (+) | `3V3` (3.3V) | Gunakan 3.3V agar level data aman untuk GPIO ESP32 |
| | `DATA` (Out) | **`GPIO 4`** | Tambahkan resistor pull-up `4.7kΩ–10kΩ` ke `3V3` jika memakai DHT22 bare (4 kaki) |
| | `GND` (−) | `GND` | Common Ground |
| **Magnetic Door Switch** | Kabel 1 | **`GPIO 27`** | Menggunakan `INPUT_PULLUP` internal (`LOW` = Tertutup, `HIGH` = Terbuka) |
| *(Reed Switch)* | Kabel 2 | `GND` | Tidak perlu resistor tambahan |
| **Relay Active-LOW (30V DC)** | `VCC` / `DC+` | `VIN` (5V) | Ambil 5V dari pin `VIN` ESP32 atau Buck Converter 5V |
| | `GND` / `DC-` | `GND` | Common Ground dengan ESP32 |
| | `IN` (Signal) | **`GPIO 26`** | **Active-LOW**: `LOW` = Relay ON (Solenoid Buka), `HIGH` = Relay OFF (Solenoid Kunci) |
| **4-Pin PWM Fan 12V** | Pin 1 (`GND` - Hitam) | `GND` (12V & ESP32) | **Wajib Common GND** antara PSU 12V dan GND ESP32 |
| | Pin 2 (`+12V` - Kuning/Merah) | `+12V` PSU | Langsung ke adaptor 12V |
| | Pin 3 (`TACH / Sense` - Hijau) | **`GPIO 32`** | Open-collector tachometer (`INPUT_PULLUP`; disarankan pull-up eksternal `4.7kΩ–10kΩ` ke `3V3` jika kabel panjang/noise PWM) |
| | Pin 4 (`PWM Control` - Biru) | **`GPIO 25`** | Sinyal PWM 25 kHz dari ESP32 (`0–100%` duty cycle) |

### B. Modul RFID-RC522 (HANYA Dipasang di `ESP 1` — Board 38-Pin)
> **PERINGATAN PENTING:** Pin `3.3V` pada RFID-RC522 **WAJIB** dihubungkan ke **`3V3` (3.3V)** ESP32. Jangan hubungkan ke 5V (`VIN`) karena chip MFRC522 akan rusak.

| Pin RFID-RC522 | Pin ESP32 (`ESP 1`) | Fungsi SPI |
| :--- | :--- | :--- |
| `SDA (SS)` | **`GPIO 5`** | SPI Chip Select |
| `SCK` | **`GPIO 18`** | SPI Clock |
| `MOSI` | **`GPIO 23`** | SPI MOSI |
| `MISO` | **`GPIO 19`** | SPI MISO |
| `IRQ` | *(Tidak dihubungkan)* | Kosongkan |
| `GND` | **`GND`** | Ground |
| `RST` | **`GPIO 21`** | Reset RC522 |
| `3.3V` | **`3V3`** | Power 3.3V |

### C. Modul OLED 0.96" I2C SSD1306 (Default di `ESP 2` — `#define HAS_OLED true`)
> **Catatan:** Jangan aktifkan `HAS_OLED` bersamaan dengan `HAS_RFID` pada ESP 1 karena `GPIO 21` dipakai bersama oleh `RST` RC522. Dapat juga dipindah ke `ESP 3` cukup dengan mengubah `#define HAS_OLED true`.

| Pin OLED SSD1306 | Pin ESP32 (`ESP 2` / `ESP 3`) | Keterangan |
| :--- | :--- | :--- |
| `VCC` | **`3V3`** | Tegangan 3.3V (aman untuk SSD1306) |
| `GND` | **`GND`** | Common Ground |
| `SDA` | **`GPIO 21`** | Default Hardware I2C SDA (Alamat `0x3C`, fallback `0x3D`) |
| `SCL` | **`GPIO 22`** | Default Hardware I2C SCL |

---

## 3. Wiring Kontak Relay & Proteksi Solenoid 12V
```text
[Adaptor +12V] ───────► [Pin COM Relay]
                        [Pin NO (Normally Open) Relay] ───┬───► [Kabel (+) Solenoid 12V]
                                                          │
                                                     [Katoda |<| Anoda]  (Dioda 1N4007 Flyback - Sangat Disarankan)
                                                          │
[Adaptor GND ] ◄──────────────────────────────────────────┴───◄ [Kabel (-) Solenoid 12V]
      │
      └───────────────► [GND ESP32] (WAJIB COMMON GROUND)
```
* Gunakan terminal **`COM`** dan **`NO` (Normally Open)** pada relay agar saat sistem mati atau *standby*, solenoid tidak dialiri arus (tetap terkunci dan tidak panas).
* Firmware sudah dilengkapi proteksi **Auto-Relock (4 detik)**, langsung memutus relay begitu pintu terdeteksi terbuka (`door_open == true`), serta **Tamper Detection (`FORCED ENTRY`)** di luar jendela 15 detik.

---

## 4. Library Arduino IDE yang Dibutuhkan (V2)
Buka **Arduino IDE → Sketch → Include Library → Manage Libraries...**, lalu instal 5 library berikut:
1. **`DHT sensor library`** oleh *Adafruit* (pilih *"Install All"* agar `Adafruit Unified Sensor` ikut terpasang).
2. **`MFRC522`** oleh *GithubCommunity* (untuk RFID-RC522 di ESP 1).
3. **`ArduinoJson`** oleh *Benoit Blanchon* (versi 6.x maupun 7.x — firmware sudah mendukung keduanya).
4. **`Adafruit SSD1306`** oleh *Adafruit* (untuk OLED 0.96" I2C di ESP 2).
5. **`Adafruit GFX Library`** oleh *Adafruit* (pilih *"Install All"* agar `Adafruit BusIO` ikut terpasang).

*(Library bawaan ESP32 Core — tidak perlu diinstal manual: `WiFi.h`, `WiFiClientSecure.h`, `HTTPClient.h`, `Preferences.h`, `SPI.h`, `Wire.h`, `time.h`).*
