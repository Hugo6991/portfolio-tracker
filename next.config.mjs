/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: import.meta.dirname,
  async headers() {
    return [{
      source: "/api/:path*",
      headers: [{
        key: "X-Robots-Tag",
        value: "noindex, nofollow, noarchive"
      }]
    }];
  }
};

export default nextConfig;
