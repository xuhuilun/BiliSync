import type { BackgroundToContentMessage } from "../shared/messages";

export async function notifyContentTabs(
  message: BackgroundToContentMessage,
  urlPatterns: string[],
): Promise<void> {
  const tabs = await chrome.tabs.query({ url: urlPatterns });
  await Promise.all(
    tabs
      .filter((tab) => tab.id !== undefined)
      .map(async (tab) => {
        try {
          await chrome.tabs.sendMessage(tab.id!, message);
        } catch {
          // Ignore tabs without a ready content script.
        }
      }),
  );
}
