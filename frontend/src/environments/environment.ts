export const environment = {
  production: false,
  /** Backend API base (00 §12). The backend allows this origin via CORS; no dev-server proxy is used. */
  apiBaseUrl: 'http://localhost:3100/api',
  /** Prefix for `/artifacts/...` image URLs returned by the API (00 §12). */
  artifactBaseUrl: 'http://localhost:3100',
};
