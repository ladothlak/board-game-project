import path from "path";
import { fileURLToPath } from "url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  poweredByHeader: false,
  experimental: {
    // Allow large PDF uploads (up to 100 MB) on API routes.
    middlewareClientMaxBodySize: "100mb",
  },
};

export default nextConfig;
