// SPDX-License-Identifier: AGPL-3.0-only
import { type BackupStatusResponse, BackupStatusResponseSchema } from "@clubadmin/shared";
import { Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { CurrentAuthorization, type RequestAuthorization } from "../authorization/index.ts";
import { BackupsService } from "./backups.service.ts";

@Controller("ops")
export class BackupsController {
  private readonly backups: BackupsService;

  constructor(backups: BackupsService) {
    this.backups = backups;
  }

  @Endpoint({
    method: "GET",
    path: "backup-status",
    summary:
      "Last successful backups and restore verification, with warnings when they are too old (operators)",
    tags: ["ops"],
    access: { permission: "ops.backup.read", resource: "platform" },
    response: BackupStatusResponseSchema,
  })
  status(
    @CurrentAuthorization() authorization: RequestAuthorization,
  ): Promise<BackupStatusResponse> {
    return this.backups.status(authorization.context);
  }
}
