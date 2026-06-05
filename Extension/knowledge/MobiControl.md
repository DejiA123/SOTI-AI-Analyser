**Log Sources**: MS.log (Management Service), DS.log (Deployment Server), DSE.log (DS Extension), AgentManager.log, Device DDR (Debug Report), HAR (browser network traces), Windows Event Logs.
**Service Architecture**: Management Service (MS) -> SQL Database -> Deployment Server (DS) -> Device Agent.
**Key Error Signatures to Hunt**:
- **SQL/Database**: "SqlException", "Timeout expired", "Deadlock", "Login failed for user", "Cannot open database", "Connection pool exhausted", "Transaction was deadlocked" — indicates DB performance or connectivity issues.
- **MS <-> DS Communication**: "Handshake failed", "Certificate error", "Port 5494 connection refused", "SSL/TLS error", "The remote certificate is invalid" — indicates broken MS-DS trust or certificate expiry.
- **Enrollment Failures**: "DeviceEnrollmentException", "AFW provisioning failed", "QR code invalid", "EMM token expired", "Device already enrolled", "COPE/COBO provisioning error" — check enrollment mode vs device state.
- **Agent Communication**: "Signal connection lost (port 13131)", "Check-in failed", "Push notification timeout", "APNS certificate expired (port 2197)" — indicates agent-to-server connectivity issues.
- **Profile/Policy Deployment**: "Profile deployment failed", "Policy conflict", "OEMConfig parse error", "Application Run Control violation" — check profile targeting and device compatibility.
- **Certificate Issues**: "Certificate chain incomplete", "Root CA not trusted", "CRL check failed", "SCEP enrollment failed" — check certificate configuration and CA trust chains.
- **Console/Web UI**: "HTTP 500", "HTTP 502 Bad Gateway", "Service Unavailable", "SOTI Management Service stopped" — check MS service status and SQL connectivity. NEVER mention IIS.
- **Upgrade/Migration**: "Schema migration failed", "Version mismatch between MS and DS", "Plugin incompatible" — check upgrade sequence (MS first, then DS).
**Domino Patterns**:
  - SQL Timeout -> MS API failure -> DS sync failure -> Device policy not updated
  - Certificate expiry -> MS-DS handshake break -> All device check-ins fail
  - DNS resolution failure -> Agent cannot reach DS -> Enrollment stuck at "Connecting"

**Android Enterprise Work Managed Enrollment**:
A device enrolled as Work Managed (Device Owner mode) is completely controlled by IT. The device MUST be factory reset before starting.
[LLM INSTRUCTION: You MUST list all 3 of the following methods in your response. Do not summarize.]
Method 1 - QR Code Enrollment:
- Factory reset the device and power it on to the Welcome screen.
- Tap the screen 6 times in the exact same spot to trigger the QR reader.
- Connect to Wi-Fi.
- Scan the Enrollment QR code provided by the MDM (SOTI MobiControl).
- Accept prompts to let the device download the management app and complete setup.

Method 2 - Token Enrollment (afw#mobicontrol):
- Factory reset the device.
- Proceed through the setup wizard. When asked for a Google account, type `afw#mobicontrol` (legacy) or `afw#setup`.
- The device will download the SOTI MobiControl agent. Enter your Enrollment ID when prompted.

Method 3 - Zero-Touch / KME:
- For bulk deployments. The device MAC/IMEI is added to the Google Zero-Touch or Samsung KME portal by the reseller.
- The user powers on the device, connects to Wi-Fi, and it automatically installs the MDM agent during setup.

**Apple iOS / iPadOS Enrollment**:
1. **Automated Device Enrollment (ADE / DEP)**:
   - Device must be purchased through Apple Business Manager (ABM) or added via Apple Configurator.
   - Assign the device to the SOTI MobiControl MDM server within the ABM portal.
   - Power on a factory-reset device, connect to Wi-Fi. It will prompt for "Remote Management".
   - Proceed through setup; the SOTI profile is installed automatically.
2. **Device Enrollment (Manual Profile)**:
   - Open Safari on the iOS device and navigate to the MobiControl Enrollment URL.
   - Enter the Enrollment ID.
   - Safari will prompt to download a Configuration Profile.
   - Go to Settings -> "Profile Downloaded" -> Install. The device is now enrolled.
3. **User Enrollment (BYOD)**:
   - Designed for personal devices. Requires Managed Apple IDs.
   - User downloads the SOTI MobiControl app from the App Store or goes to the enrollment URL.
   - Enrolls using their Managed Apple ID; personal data remains strictly separate from corporate data.

**Windows Modern Device Enrollment**:
1. **Windows Autopilot**:
   - Device hardware hash is registered in the Autopilot portal and assigned to SOTI MobiControl.
   - User powers on a new/reset Windows 10/11 device, connects to Wi-Fi.
   - The device recognizes the corporate assignment and forces MDM enrollment during the OOBE (Out-Of-Box Experience).
2. **Manual Enrollment (Work or School Account)**:
   - On the Windows device, go to Settings -> Accounts -> Access work or school.
   - Click "Connect" -> "Enroll only in device management".
   - Enter the corporate email (if auto-discovery is set up) or the MDM server URL/Enrollment ID.
   - Authenticate to complete the MDM profile installation.
3. **SOTI Classic Windows Agent (.msi)**:
   - For legacy or rugged Windows PC devices.
   - Download the MobiControl Windows Agent installer.
   - Run the installer and input the Enrollment ID or Server IP.
