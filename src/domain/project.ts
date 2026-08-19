import type { ProjectId } from "./ids.js";
import type { Timestamp } from "./time.js";

export interface Project {
  readonly id: ProjectId;
  readonly key: string;
  readonly name: string;
  readonly createdAt: Timestamp;
}
