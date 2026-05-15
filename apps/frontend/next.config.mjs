function readEnv(name) {
  const value = process.env[name];
  return value === undefined || value === null ? "" : String(value).trim();
}

function validateUrl(name, protocols, errors) {
  const value = readEnv(name);
  if (!value) {
    errors.push(`${name} is required`);
    return;
  }

  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) {
      errors.push(`${name} must use one of: ${protocols.join(", ")}`);
    }
  } catch {
    errors.push(`${name} must be a valid URL`);
  }
}

function validateOptionalPositiveInteger(name, errors) {
  const value = readEnv(name);
  if (!value) return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`${name} must be a positive integer`);
  }
}

function validateFrontendEnv() {
  const errors = [];
  validateUrl("NEXT_PUBLIC_BACKEND_URL", ["http:", "https:"], errors);
  validateUrl("NEXT_PUBLIC_API_URL", ["http:", "https:"], errors);
  validateUrl("NEXT_PUBLIC_EVENT_SERVICE_URL", ["http:", "https:"], errors);
  validateUrl("NEXT_PUBLIC_WS_URL", ["ws:", "wss:"], errors);
  validateOptionalPositiveInteger("NEXT_PUBLIC_MARKET_FLUSH_MS", errors);
  validateOptionalPositiveInteger("NEXT_PUBLIC_MAX_SYMBOLS", errors);

  if (errors.length > 0) {
    console.error("[frontend] Configuration error:");
    for (const error of errors) {
      console.error(`[frontend] - ${error}`);
    }
    process.exit(1);
  }
}

validateFrontendEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
};

export default nextConfig;
