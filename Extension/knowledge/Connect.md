**Log Sources**: Connect Management Service logs, Data/Processing Service logs, Protocol Adapter logs (one per protocol family), MQTT broker logs, API gateway logs, Integration pipeline logs, MSI installer logs.
**Service Architecture**: IoT Devices (printers, scanners, sensors) -> Protocol Adapter / MQTT broker -> SOTI Connect Services (management + data processing) -> SQL Database -> Dashboard/API -> Integration (MobiControl/XSight).
**Windows Services**: services are prefixed "SOTI Connect" (management service, data service, and one service per installed Protocol Adapter, e.g. for Zebra Link-OS printers). A stopped Protocol Adapter takes ALL devices of that protocol offline at once. The MQTT broker runs as its own service/dependency.
**Default Log Locations**: under the SOTI Connect installation directory, one log folder per service/adapter. Device-side evidence is limited — most troubleshooting evidence is in adapter + broker logs.
**Port Matrix (defaults)**:
- 1883 (MQTT) / 8883 (MQTT over TLS): device <-> broker communication.
- 443 (HTTPS): console/web UI and REST API.
- 1433 (TCP): Connect services -> SQL Server database.
- 161/162 (SNMP): printer/device discovery and supply telemetry.
**Key Error Signatures to Hunt**:
- **Device Connectivity**: "Device connection timeout", "MQTT broker unreachable", "Protocol negotiation failed", "TLS handshake error", "Device certificate rejected", "Heartbeat missed", "CONNACK refused" — check network, certificates, broker health, and protocol compatibility.
- **Connector/Adapter**: "Connector offline", "Protocol Adapter stopped", "Gateway resource exhausted", "Connection pool depleted", "Proxy authentication failed", "Upstream timeout" — check adapter service status and resource allocation.
- **Data Processing**: "Payload parse error", "Data transformation failed", "Schema mismatch for device type", "Unsupported firmware response", "Command execution timeout" — check device driver/template (device type definition) compatibility with the device firmware.
- **Printer/IoT-Specific**: "SNMP community string mismatch", "Print queue stuck", "Firmware update failed", "Supply level read error", "PJL command rejected", "Link-OS response malformed" — check device-specific configuration, firmware version, and driver/template version.
- **API/Integration**: "REST API rate limit exceeded", "Webhook delivery failed", "MobiControl integration credential expired", "Batch operation timeout" — check API configuration and inter-product credentials.
- **Discovery**: "Network scan timeout", "IP range scan incomplete", "Device type not recognized", "Auto-discovery conflict with existing device" — check network scan configuration and device driver availability.
- **Database**: "SqlException", "Login failed for user", "Timeout expired", "Cannot open database" — Connect services share one SQL database; DB issues surface in EVERY service log at the same timestamps.
- **Installer (MSI)**: "Return value 3", "1603" — root cause is in the lines immediately above the first "Return value 3" (typically a SQL CustomAction or a prerequisite check).
**Domino Patterns**:
  - Connector/adapter offline -> All managed devices in that segment unreachable -> Stale data in dashboard -> Alerts for "all devices offline" (but it's the adapter, not the devices)
  - Certificate expired on broker/gateway -> TLS handshake fails -> Devices cannot report -> Connect shows "unknown" status
  - Driver/template update -> Existing devices report schema mismatch -> Data processing errors -> Dashboard shows partial data
  - MQTT broker down -> every device LWT (last-will) fires at once -> mass offline alerts with identical timestamps (look for the broker restart, not device faults)
  - SQL outage -> all Connect services log connection errors simultaneously -> UI down + devices stale (root cause is the database, not Connect itself)
