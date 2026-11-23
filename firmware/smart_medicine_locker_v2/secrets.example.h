#pragma once

/**
 * Template for ESP32 Wi-Fi & Firebase RTDB Credentials
 *
 * Instructions:
 *   1. Copy this file to `secrets.h` in the same folder.
 *   2. Replace the placeholder values below with your actual Wi-Fi and Firebase credentials.
 *   3. `secrets.h` is automatically ignored by `.gitignore`.
 */
#define SECRET_WIFI_SSID          "YOUR_WIFI_SSID"
#define SECRET_WIFI_PASSWORD      "YOUR_WIFI_PASSWORD"
#define SECRET_FIREBASE_HOST      "https://YOUR_PROJECT_ID-default-rtdb.YOUR_REGION.firebasedatabase.app"
#define SECRET_DEFAULT_RFID_UIDS  "RFID_ADMIN_01,RFID_OP_01"
