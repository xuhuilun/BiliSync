import type { AdminSession } from "./admin/types.js";

export type AdminSessionStore = {
  save: (tokenId: string, session: AdminSession) => Promise<void>;
  get: (tokenId: string) => Promise<AdminSession | null>;
  delete: (tokenId: string) => Promise<void>;
};
