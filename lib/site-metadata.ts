import type { Metadata } from "next";

export const SITE_NAME = "Portfolio Tracker";
export const SITE_URL = new URL("https://your-app.vercel.app");
export const SITE_DESCRIPTION = "A live net worth dashboard showing where assets are held and how fresh each source is";
export const SOCIAL_IMAGE_ALT = "Portfolio Tracker dashboard preview";

const openGraphImage = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: SOCIAL_IMAGE_ALT
};

export function createPageMetadata(
  title: string,
  description: string,
  path: string
): Metadata {
  const socialTitle = `${title} | ${SITE_NAME}`;
  return {
    title,
    description,
    openGraph: {
      type: "website",
      url: path,
      siteName: SITE_NAME,
      title: socialTitle,
      description,
      images: [openGraphImage]
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: ["/twitter-image"]
    }
  };
}
