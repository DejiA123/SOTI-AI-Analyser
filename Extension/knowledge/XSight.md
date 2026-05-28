**Log Sources**: XSight Service logs, Collector logs, Agent telemetry data, Event pipeline logs, Elasticsearch/data store logs.
**Service Architecture**: XSight Collectors -> Data Pipeline -> XSight Analytics Engine -> Dashboard/Alerts.
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

**MSI Installer Heuristics (When troubleshooting an install log)**:
When parsing an MSI installer log, to find the fatal error that caused the rollback, hunt for:
1. `Return value 3` = This indicates a failure. The line just above this is usually the exact action that failed!
2. `Error 1603` = A generic fatal error during installation. Look *before* this line for the root cause.
3. `MainEngineThread is returning` = Summary exit code at the end.
4. `CustomAction ConfigureChatService returned actual error code 1603` = Note this may not be 100% accurate if translation happened inside the sandbox. Look few lines above for clues.
5. Example sequence:
   - `Closing MSIHANDLE (1000) of type 790536 for thread 6480`
   - *(Note: Look at the few lines above this for clues on the error!)*
   - `Action ended 8:07:18: InstallFinalize. Return value 3.`
