**Log Sources**: Connect Service logs, Connector/Gateway logs, Device communication logs, API gateway logs, Integration pipeline logs.
**Service Architecture**: IoT Devices -> SOTI Connect Gateway/Connector -> Connect Service -> Data Processing -> Dashboard/API -> Integration (MobiControl/XSight).
**Key Error Signatures to Hunt**:
- **Device Connectivity**: "Device connection timeout", "MQTT broker unreachable", "Protocol negotiation failed", "TLS handshake error", "Device certificate rejected", "Heartbeat missed" — check network, certificates, and protocol compatibility.
- **Connector/Gateway**: "Connector offline", "Gateway resource exhausted", "Connection pool depleted", "Proxy authentication failed", "Upstream timeout" — check connector health and resource allocation.
- **Data Processing**: "Payload parse error", "Data transformation failed", "Schema mismatch for device type", "Unsupported firmware response", "Command execution timeout" — check device driver/template compatibility.
- **Printer/IoT-Specific**: "SNMP community string mismatch", "Print queue stuck", "Firmware update failed", "Supply level read error", "PJL command rejected" — check device-specific configuration and driver version.
- **API/Integration**: "REST API rate limit exceeded", "Webhook delivery failed", "MobiControl integration credential expired", "Batch operation timeout" — check API configuration and inter-product credentials.
- **Discovery**: "Network scan timeout", "IP range scan incomplete", "Device type not recognized", "Auto-discovery conflict with existing device" — check network scan configuration and device driver availability.
**Domino Patterns**:
  - Connector offline -> All managed devices in that segment unreachable -> Stale data in dashboard -> Alerts for "all devices offline" (but it's the connector, not the devices)
  - Certificate expired on gateway -> TLS handshake fails -> Devices cannot report -> Connect shows "unknown" status
  - Driver template update -> Existing devices report schema mismatch -> Data processing errors -> Dashboard shows partial data
