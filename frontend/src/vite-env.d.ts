/// <reference types="vite/client" />

interface Window {
  __callbackSmartSpectraDiagnostics?: {
    onMessage(callback: (entry: { level: string; message: string }) => void): () => void;
  };
}
