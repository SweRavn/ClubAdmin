// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the audit module (P1.9, ADR 0042).
export { AuditModule, createHistoryDatabase, HISTORY_DATABASE } from "./audit.module.ts";
export { HistoryService } from "./history.service.ts";
