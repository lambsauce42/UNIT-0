/// <reference types="vite/client" />

import type { UnitApi } from "../shared/types";

declare global {
  interface Window {
    unitApi: UnitApi;
  }
}
