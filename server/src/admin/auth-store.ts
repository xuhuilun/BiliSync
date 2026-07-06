import type { AdminSession } from "./types.js";
import type { AdminSessionStore } from "../admin-session-store.js";

export type AuthStore = AdminSessionStore;

export function createInMemoryAdminSessionStore(): AuthStore {
  const sessions = new Map<string, AdminSession>();

  return {
    async save(tokenId, session) {
      sessions.set(tokenId, { ...session });
    },
    async get(tokenId) {
      const session = sessions.get(tokenId);
      return session ? { ...session } : null;
    },
    async delete(tokenId) {
      sessions.delete(tokenId);
    },
  };
}

export const createInMemoryAuthStore = createInMemoryAdminSessionStore;
