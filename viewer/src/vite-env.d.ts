/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_MODE?: "local" | "published";
  readonly VITE_DATA_RELEASE?: string;
}
