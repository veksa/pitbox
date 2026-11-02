// Doctor: failure signatures with remedies. A rule checks one thing and may carry a fix, so a problem
// someone solved once is solved by a tool the next time instead of rediscovered.

import type {PitboxConfig} from '../config/schema.ts';
import type {AndroidDriver} from '../drivers/android/driver.ts';
import type {ServiceManager} from '../stand/services.ts';

export type Severity = 'error' | 'warn' | 'info';

export type Finding = {
  rule: string;
  severity: Severity;
  message: string;
  /** What to do about it, in one line. */
  hint?: string;
  /** Applies the remedy; returns what it did. */
  fix?: () => Promise<string>;
};

export type DoctorContext = {
  root: string;
  config: PitboxConfig;
  services: ServiceManager;
  /** Undefined when adb is not installed. */
  android?: AndroidDriver;
  exposedPorts: number[];
  /** Whether each device's forwards really carry data, and through what. */
  forwardHealth?: () => Promise<{serial: string; via: 'reverse' | 'relay'; carries: boolean}[]>;
  /** Moves an emulator's forwards onto the runner relay. */
  useRelay?: (serial: string) => Promise<string>;
  /** System dialogs on top of each device ("… isn't responding"), and a way to dismiss one. */
  systemDialogs?: () => Promise<{serial: string; title: string}[]>;
  dismissDialog?: (serial: string) => Promise<string>;
};

export type Rule = {
  id: string;
  title: string;
  check: (ctx: DoctorContext) => Promise<Finding[]>;
};
