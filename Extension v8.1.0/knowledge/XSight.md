**Log Sources**: XSight Service logs, Collector logs, Agent telemetry data, Event pipeline logs, Elasticsearch/data store logs, SetupSOTIXSight MSI installer logs.
**Service Architecture**: XSight Collectors -> Data Pipeline -> XSight Analytics Engine -> Dashboard/Alerts. XSight integrates tightly with MobiControl (device data, remote control) and uses its own SQL database plus a search/analytics store.
**Windows Services**: services are prefixed "SOTI XSight". The installer (SetupSOTIXSight-<version>.exe / MSI) configures the database, services, and integrations via CustomActions — most install failures are CustomAction failures, not file-copy failures.
**Default Log Locations**: under the SOTI XSight installation directory (service + collector logs); installer logs are MSI logs in %TEMP% or alongside the setup executable. Remote-control session issues also leave evidence in the MobiControl agent DDR.
**Port Matrix (defaults)**:
- 443 (HTTPS): dashboard, APIs, MobiControl integration.
- 1433 (TCP): XSight -> SQL Server database.
- Collector -> device protocols: SNMP 161, WMI/RPC 135 + dynamic, depending on what is monitored.
**Key Error Signatures to Hunt**:
- **Data Collection**: "Collector heartbeat lost", "Telemetry ingestion failed", "Agent reporting gap detected", "SNMP timeout", "WMI access denied" — indicates collector-to-device communication issues.
- **Pipeline/Processing**: "Event queue overflow", "Processing pipeline backlog", "Message deserialization error", "Schema validation failed" — indicates data pipeline congestion or format issues.
- **Storage/Database**: "Elasticsearch cluster red", "Index write blocked", "Disk watermark exceeded", "Shard allocation failed", "MongoDB connection timeout" — indicates storage capacity or connectivity issues.
- **Dashboard/Reporting**: "Report generation timeout", "Widget data source unavailable", "Aggregation query failed", "Dashboard rendering error" — usually downstream of storage issues.
- **Alerts/Rules**: "Alert rule evaluation failed", "Notification delivery failed", "SMTP connection refused", "Webhook timeout" — check alert configuration and notification channel connectivity.
- **Integration**: "MobiControl API connection refused", "SSO token expired", "Cross-product sync failed" — check inter-product integration credentials and network.

**Domino Patterns**:
  - Disk full -> Elasticsearch write block -> Pipeline backlog -> Dashboard shows stale data -> Alerts stop firing
  - Collector offline -> Data gap -> XSight reports inaccurate device health -> False "healthy" status
  - Network firewall change -> Collector cannot reach devices -> Telemetry gaps -> Compliance reports incorrect
  - SQL CustomAction fails during install (missing rights / unreachable Azure SQL host) -> Return value 3 -> full rollback (the SQL/exception line above the 1603 is the root cause, NOT the rollback itself)
  - MobiControl integration credential expired -> device data stops syncing -> XSight dashboards empty while MobiControl itself is healthy

**MSI INSTALLER HEURISTICS (CRITICAL FOR XSIGHT INSTALL/UPGRADE LOGS)**:
When analyzing an XSight MSI installer log (`SetupSOTIXSight`, etc.), the actual cause of a rollback is almost never at the very bottom of the file. You **MUST** hunt for the following specific forensic signatures to find the true root cause:

1. **`Return value 3`** (Highest Priority)
   - **Meaning**: `Return value 3 = failure`. This is the exact moment the installation failed and triggered a rollback.
   - **Action**: **The line just above this is the action that failed**. Focus your analysis entirely on the action directly preceding this value.

2. **`Error 1603`**
   - **Meaning**: A generic Windows Installer fatal error during installation. 
   - **Action**: This is a symptom. You must scroll *up* (before this line) to find the actual custom action or SQL script that failed.

3. **`MainEngineThread is returning`**
   - **Meaning**: This is just the summary exit code at the very end of the log. Do not cite this as the root cause.

4. **`CustomAction [ActionName] returned actual error code 1603`**
   - **Meaning**: A specific custom action (e.g., `ConfigureChatService`) failed.
   - **Action**: *(Note: This may not be 100% accurate if translation happened inside the sandbox).* You must look a few lines **above** this for clues on the exact error (e.g., a missing prerequisite, a failed SQL query, or a permissions issue).

5. **The "Closing MSIHANDLE" Pattern**
   - **Signature**: `Closing MSIHANDLE (1000) of type 790536 for thread 6480`
   - **Action**: **NOTE: Look at the few lines above this for clues on the error!**
   - **Example Sequence**:
     ```text
     (Look here for the actual error!)
     MSI (s) (04:60) [08:07:18:182]: Closing MSIHANDLE (1000) of type 790536 for thread 6480
     Action ended 8:07:18: InstallFinalize. Return value 3.
     ```

**Ultimate MSI Rule for AI**: Never tell the user "The installation failed with Error 1603". You must tell them *why* it threw Error 1603 by finding the custom action or database script that executed immediately prior to the `Return value 3` or `Closing MSIHANDLE` event.
