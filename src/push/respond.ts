// Notification responses on an iOS simulator: a delivered notification's tap, dismissal or custom action, answered
// through the app's debug-only hook (`PitboxNotifications` in the connect library), which calls the app's
// UNUserNotificationCenter delegate with the response the system would build. The exchange is the one the Live
// Activity hook uses (liveactivity.ts `deliverToHook`):
//
//   pitbox → app   Library/Caches/pitbox/notification/in/<id>.json, then the Darwin notification
//                  `dev.pitbox.notification.<bundle id>`; the hook also drains the folder whenever the app becomes active
//   app → pitbox   out/<id>.json with the outcome

import path from 'node:path';

export const notificationDir = (container: string) => path.join(container, 'Library', 'Caches', 'pitbox', 'notification');
export const notificationNotice = (bundleId: string) => `dev.pitbox.notification.${bundleId}`;

/** The hook's answer (out/<id>.json). */
export type NotificationResponseOutcome = {
  ok: boolean;
  /** The request identifier and the title of the notification answered. */
  notification?: string;
  title?: string;
  category?: string;
  /** The action identifier handed to the delegate (the system's own for open and dismiss). */
  action?: string;
  /** The response brings the app to the front (the tap, a foreground action). */
  foreground?: boolean;
  /** The delegate called its completion handler. */
  completed?: boolean;
  /** The category's actions, `identifier "title"` each. */
  actions?: string[];
  error?: string;
};
