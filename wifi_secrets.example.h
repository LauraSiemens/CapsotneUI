/**
 * WiFi credentials for bmv.ino (station + WebSocket broadcast).
 *
 * Copy this file to wifi_secrets.h in the same folder as bmv.ino:
 *   cp wifi_secrets.example.h wifi_secrets.h
 * Then edit WIFI_SSID and WIFI_PASSWORD. wifi_secrets.h is gitignored.
 *
 * Optional: #define WIFI_WEBSOCKET_PORT 8766  (default; matches dashboard + serial bridge)
 */
#pragma once

#define WIFI_SSID "your_network_name"
#define WIFI_PASSWORD "your_wifi_password"
