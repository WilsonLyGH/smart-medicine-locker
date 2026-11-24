#pragma once

/**
 * Template for ESP32 Wi-Fi, Firebase RTDB & Firebase Auth Credentials
 *
 * Instructions:
 *   1. Copy this file to `secrets.h` in the same folder.
 *   2. Replace the placeholder values below with your actual Wi-Fi and Firebase credentials.
 *   3. `secrets.h` is automatically ignored by `.gitignore`.
 */
#define SECRET_WIFI_SSID          "YOUR_WIFI_SSID"
#define SECRET_WIFI_PASSWORD      "YOUR_WIFI_PASSWORD"
#define SECRET_FIREBASE_HOST      "https://YOUR_PROJECT_ID-default-rtdb.YOUR_REGION.firebasedatabase.app"
#define FIREBASE_API_KEY          "YOUR_FIREBASE_WEB_API_KEY"
#define ESP_AUTH_EMAIL            "esp32@locker.local"
#define ESP_AUTH_PASSWORD         "YOUR_ESP32_AUTH_PASSWORD"
#define SECRET_DEFAULT_RFID_UIDS  "RFID_ADMIN_01,RFID_OP_01"
