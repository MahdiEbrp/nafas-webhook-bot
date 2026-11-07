import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Backend-only project: no <Image>, no font pipeline, no i18n routing.
  reactStrictMode: true,
  poweredByHeader: false,
  logging: {
    fetches: { fullUrl: false },
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
