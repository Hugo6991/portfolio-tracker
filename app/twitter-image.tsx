import { renderSocialCard } from "@/lib/social-card";
import { SOCIAL_IMAGE_ALT } from "@/lib/site-metadata";

export const alt = SOCIAL_IMAGE_ALT;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return renderSocialCard();
}
