/// <reference types="vite/client" />

import type { SenseFrameApi } from '../electron/preload';

declare global {
  interface Window {
    senseframe?: SenseFrameApi;
  }
}
