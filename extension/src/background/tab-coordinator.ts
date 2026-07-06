export function rememberSharedSource(args: {
  currentSharedTabId: number | null;
  tabId: number | undefined;
  url: string;
}): {
  sharedTabId: number | null;
  lastOpenedSharedUrl: string;
} {
  return {
    sharedTabId: args.tabId ?? args.currentSharedTabId,
    lastOpenedSharedUrl: args.url,
  };
}

export function decideSharedPlaybackTab(args: {
  tabId: number | undefined;
  sharedTabId: number | null;
  normalizedRoomUrl: string | null;
  normalizedPayloadUrl: string | null;
}): {
  accepted: boolean;
  nextSharedTabId: number | null;
  reason:
    | "missing-tab"
    | "accepted-first"
    | "accepted-current"
    | "room-mismatch"
    | "ignored-non-shared";
} {
  if (args.tabId === undefined) {
    return {
      accepted: false,
      nextSharedTabId: args.sharedTabId,
      reason: "missing-tab",
    };
  }

  if (args.sharedTabId === null) {
    if (
      args.normalizedRoomUrl &&
      args.normalizedPayloadUrl &&
      args.normalizedRoomUrl === args.normalizedPayloadUrl
    ) {
      return {
        accepted: true,
        nextSharedTabId: args.tabId,
        reason: "accepted-first",
      };
    }
    return {
      accepted: false,
      nextSharedTabId: null,
      reason: "ignored-non-shared",
    };
  }

  if (args.sharedTabId === args.tabId) {
    if (
      !args.normalizedRoomUrl ||
      !args.normalizedPayloadUrl ||
      args.normalizedRoomUrl !== args.normalizedPayloadUrl
    ) {
      return {
        accepted: false,
        nextSharedTabId: args.sharedTabId,
        reason: "room-mismatch",
      };
    }
    return {
      accepted: true,
      nextSharedTabId: args.sharedTabId,
      reason: "accepted-current",
    };
  }

  return {
    accepted: false,
    nextSharedTabId: args.sharedTabId,
    reason: "ignored-non-shared",
  };
}
