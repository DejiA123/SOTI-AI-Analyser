# SOTI XSight — Product Overview
Source: https://www.soti.net/sotixsight/

SOTI XSight is the diagnostic, remote-support and operational-intelligence product of the SOTI ONE Platform. It gives technicians powerful remote support tools to diagnose and solve problems on customer mobile devices, collects device telemetry for analytics, and presents operational-intelligence dashboards. SOTI XSight is a separate product from SOTI MobiControl and must be installed before it can be used; once it is set up, initiating a remote-control session from the SOTI MobiControl console opens SOTI XSight in a new browser tab or window.

# SOTI XSight — Architecture Overview
Source: https://soti.net/sotixsight/help/v2024.0/en/architecture_overview.html

Server-side services:
- SOTI XSight Service: a Windows service that hosts the SOTI XSight web console.
- Tunnel Service: enables terminal and web-console access on Linux devices.
- SOTI XSight Agent Service: communicates with the mobile agents to receive data and distribute configurations.
- SOTI XSight Services (cloud-hosted): provides licensing and remote-control device skins.

Client-side:
- SOTI XSight Agent: a mobile application that collects device data and performs analysis.
- OEM plugins (e.g. an XT/Smart Battery plugin): OEM-specific plugins for collecting extra data such as battery health.

Data storage (multiple databases):
- SOTI XSight Database: incident management, configurations, user preferences and authorisation data.
- SOTI XSight "Cook" Database: agent-collected data and device reference information.
- SOTI XSight DW (data warehouse) Database: processed data for the operational-intelligence dashboards.
- SOTI XSight Chat Database: chat and live-support service data.

# SOTI XSight — Network Ports and Communications
Source: https://soti.net/sotixsight/help/v2024.0/en/architecture_overview.html

Key port requirements:
- TCP 5493: inbound agent connections from mobile clients to the XSight Agent Service.
- TCP 1433: outbound to the SQL databases.
- 443 (HTTPS / WebSocket): web console and chat/live-support services. Remote control uses a WebSocket over 443, so a closed/blocked WebSocket breaks remote-control sessions.
- TCP 5494: outbound from the Tunnel Service to the MobiControl Deployment Server.
Because XSight uses several databases on SQL Server, a SQL connectivity or permissions problem can affect incidents, collected data, dashboards and chat at the same time.

# SOTI XSight — Integration with SOTI MobiControl
Source: https://soti.net/sotixsight/help/v2024.0/en/architecture_overview.html

SOTI XSight integrates with SOTI MobiControl for license management, authentication, role management, user lookups, device-information retrieval, remote-control setup, and data-collection processes. Remote-control sessions are launched from the MobiControl console, which hands off to XSight. If the integration credential or token expires, device data stops syncing and remote control fails to launch even though MobiControl itself is healthy.

# SOTI XSight — Remote Control
Source: https://www.soti.net/sotixsight/help/v2024.0/en/remote_control/

SOTI XSight remote control lets technicians diagnose and resolve problems on a device. Capabilities include taking control of the device, capturing screenshots, recording video and audio of the session, drawing on the device screen (whiteboard), downloading diagnostic files, and file management. Sessions are typically opened from a submitted incident/ticket on the XSight Incident page, and sessions can be recorded.

Device support:
- Android Enterprise devices require an Android Enterprise plugin to support remote control.
- Zebra Android Enterprise devices do not require a plugin.
- Android Enterprise work-profile (managed profile) devices and iOS devices can be remote viewed only — the user operates the device while the administrator watches.
- Linux and Zebra devices have dedicated remote-control support.

# SOTI XSight — Remote Control Server URL / FQDN Configuration
Source: https://pulse.soti.net/support/soti-xsight/help/

For remote control to work, the SOTI XSight server URL must be configured to a fully-qualified domain name (FQDN) that the technician's browser can resolve and reach over HTTPS/WebSocket (443). A very common failure is the remote-control page redirecting to an internal/backend hostname (for example the server's local machine FQDN such as srv66.domsopil.local) instead of the public address (for example soti.sopil.fr). When this happens the browser cannot reach the internal name, so the session fails to connect, even though manually forcing the correct external URL works. Resolve it by verifying the configured FQDN/server URL in the SOTI XSight admin/utility tool and in the MobiControl utility, ensuring the certificate matches that external FQDN and its chain is trusted, and confirming DNS resolves the external name from the client. A mismatch between the configured server URL and the externally-resolvable FQDN is the root cause of the redirect-to-wrong-host symptom.

# SOTI XSight — Installation and Requirements
Source: https://www.soti.net/sotixsight/help/v2024.0/en/

SOTI XSight is installed separately from SOTI MobiControl. Installation provisions the XSight services and the multiple databases, and configures the integration with MobiControl. Most install/upgrade failures are CustomAction failures (for example a SQL script or a prerequisite check) rather than file-copy failures — in an MSI/installer log the true cause is the action immediately before the first "Return value 3" / error 1603, not the rollback itself. Review system requirements for the server, SQL Server, and the data store before installing.

# SOTI XSight — Common Issues and Troubleshooting
Source: https://pulse.soti.net/support/soti-xsight/help/

High-value symptoms and where to look:
- Remote control fails to connect / "WebSocket closed": check that 443 WebSocket traffic is allowed end to end, that the configured server URL/FQDN is externally resolvable, and that the certificate matches that FQDN. The redirect-to-internal-hostname symptom is an FQDN/server-URL misconfiguration (see the dedicated topic above).
- Data collection: "Collector heartbeat lost", "Telemetry ingestion failed", "Agent reporting gap detected" — check the XSight Agent Service and the agent-to-device path (port 5493 inbound).
- Pipeline/processing: "Event queue overflow", "Processing pipeline backlog", "Message deserialization error", "Schema validation failed" — pipeline congestion or format issues.
- Storage: "Index write blocked", "Disk watermark exceeded", "cluster red", "MongoDB/SQL connection timeout" — storage capacity or connectivity; this stalls dashboards and stops alerts.
- Dashboards/reporting: "Report generation timeout", "Widget data source unavailable", "Aggregation query failed" — usually downstream of a storage problem.
- Integration: "MobiControl API connection refused", "SSO token expired", "Cross-product sync failed" — check the MobiControl integration credential and network path.

Domino patterns:
- SQL/storage problem → incidents, collected data, dashboards and chat all degrade together (shared databases).
- Integration credential expired → device data stops syncing and remote control won't launch, while MobiControl stays healthy.
- FQDN/server-URL mismatch → remote control redirects to the internal hostname and fails to connect, though the rest of XSight works.
