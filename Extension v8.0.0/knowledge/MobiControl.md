**Log Sources**: MS.log (Management Service), DS.log (Deployment Server), DSE.log (DS Extension), AgentManager.log, Device DDR (Debug Report), HAR (browser network traces), Windows Event Logs, MCSetup/MSI installer logs.
**Service Architecture**: Management Service (MS) -> SQL Database -> Deployment Server (DS) -> Device Agent. Console (web) talks to MS; devices talk to DS; MS and DS both depend on the SQL database.
**Windows Services**: "SOTI MobiControl Management Service" (MS), "SOTI MobiControl Deployment Server" (DS, one per DS instance), "SOTI MobiControl Search Server" (search/indexing). If MS is stopped the console is down; if a DS is stopped only devices on that DS lose connectivity.
**Default Log Locations**: Server logs live under the MobiControl installation directory (e.g. `...\SOTI\MobiControl\` — MS.log, DS.log, DSE.log alongside their services). Device-side logs come from the agent's Device Debug Report (DDR). Installer/upgrade logs are MSI logs (look for `Return value 3`).
**Port Matrix (defaults)**:
- 443 (HTTPS): console, enrollment, modern agent communication, APIs.
- 5494 (TCP): legacy device <-> DS communication channel.
- 1433 (TCP): MS/DS -> SQL Server database.
- 389 / 636: LDAP / LDAPS directory lookups (user auth, enrollment rules).
- 2195-2197: legacy APNs (Apple push); modern APNs uses 443/2197 to api.push.apple.com.
- 5228-5230 (outbound): Google FCM push for Android agents.
- 13131: agent notification/signal channel.
**Key Error Signatures to Hunt**:
- **SQL/Database**: "SqlException", "Timeout expired", "Deadlock", "Login failed for user", "Cannot open database", "Connection pool exhausted", "Transaction was deadlocked", "ALTER DATABASE", "RECOVERY SIMPLE" — indicates DB performance, permissions, or connectivity issues. SQL errors during install/upgrade usually mean the installing account lacks sysadmin/dbo rights or the SQL host/port is unreachable.
- **MS <-> DS Communication**: "Handshake failed", "Certificate error", "Port 5494 connection refused", "SSL/TLS error", "The remote certificate is invalid" — indicates broken MS-DS trust or certificate expiry.
- **Enrollment Failures**: "DeviceEnrollmentException", "AFW provisioning failed", "QR code invalid", "EMM token expired", "Device already enrolled", "COPE/COBO provisioning error", "Enrollment rule not found", "Add Devices Rule disabled" — check enrollment mode vs device state and rule configuration.
- **Agent Communication**: "Signal connection lost (port 13131)", "Check-in failed", "Push notification timeout", "APNS certificate expired", "FCM registration failed", "Device marked offline" — indicates agent-to-server connectivity issues.
- **Profile/Policy Deployment**: "Profile deployment failed", "Policy conflict", "OEMConfig parse error", "Application Run Control violation", "Package deployment failed", "Script execution failed" — check profile targeting, package dependencies, and device compatibility.
- **Certificate Issues**: "Certificate chain incomplete", "Root CA not trusted", "CRL check failed", "SCEP enrollment failed", "Certificate template not found", "OCSP unreachable" — check certificate configuration and CA trust chains.
- **Console/Web UI**: "HTTP 500", "HTTP 502 Bad Gateway", "Service Unavailable", "SOTI Management Service stopped" — check MS service status and SQL connectivity. NEVER mention IIS.
- **Authentication/Identity**: "SAML assertion invalid", "SSO token expired", "Clock skew detected", "LDAP server unreachable", "Invalid credentials for directory user" — check SOTI Identity / IdP configuration, time sync, and directory connectivity.
- **Upgrade/Migration**: "Schema migration failed", "Version mismatch between MS and DS", "Plugin incompatible", "Database version is newer than the installer" — check upgrade sequence (all MS nodes first, then DS) and that the same build is used everywhere.
- **Installer (MSI)**: "Return value 3", "1603", "CustomAction ... returned actual error code 1603" — the true cause is in the lines IMMEDIATELY ABOVE the first "Return value 3"; ignore "Closing MSIHANDLE", "Note: 1: 2265", and policy-value noise.
**Domino Patterns**:
  - SQL Timeout -> MS API failure -> DS sync failure -> Device policy not updated
  - Certificate expiry -> MS-DS handshake break -> All device check-ins fail
  - DNS resolution failure -> Agent cannot reach DS -> Enrollment stuck at "Connecting"
  - SQL permissions missing during upgrade -> CustomAction SQL script fails -> Return value 3 -> full MSI rollback (the SQL line above the 1603 is the root cause)
  - LDAP/Identity outage -> directory-user logins fail console-wide -> local admin accounts still work (distinguishes IdP issue from MS outage)
