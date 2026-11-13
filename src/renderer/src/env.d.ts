/// <reference types="vite/client" />
import type { AnyeApi } from '../../shared/api';

declare global {
  interface Window {
    anye: AnyeApi;
  }
}
