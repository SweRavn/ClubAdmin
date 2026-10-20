import { clubsService } from "../clubs/index.ts";
import { secretTable } from "../clubs/clubs.repository.ts";

export const groups = [clubsService, secretTable];
