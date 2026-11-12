import type { SVGProps } from "react";

const PATHS: Record<string, string> = {
  home: "M 3 11 L 12 3 L 21 11 M 5 10 L 5 21 L 19 21 L 19 10 M 10 21 L 10 15 L 14 15 L 14 21",
  hand: "M 8 12 L 8 5 A 1.5 1.5 0 0 1 11 5 L 11 11 M 11 11 L 11 4 A 1.5 1.5 0 0 1 14 4 L 14 11 M 14 11 L 14 5 A 1.5 1.5 0 0 1 17 5 L 17 14 A 7 7 0 0 1 10 21 A 7 7 0 0 1 3 14 L 3 12 A 1.5 1.5 0 0 1 6 12 L 6 13",
  pen: "M 12 19 L 5 19 L 5 12 L 13.5 3.5 A 2.1 2.1 0 0 1 16.5 6.5 L 12 19 Z M 12 19 L 16 15 M 11 10 L 14 13",
  "direct-select": "M 5 3 L 5 19 L 9.5 14.5 L 12.5 21 L 15.5 19.5 L 12.5 13 L 18 13 Z",
  marquee: "M 4 4 L 8 4 M 12 4 L 16 4 M 20 4 L 20 8 M 20 12 L 20 16 M 20 20 L 16 20 M 12 20 L 8 20 M 4 20 L 4 16 M 4 12 L 4 8",
  "ellipse-marquee": "M 12 3 A 9 9 0 0 1 18.4 5.6 M 21 12 A 9 9 0 0 1 18.4 18.4 M 12 21 A 9 9 0 0 1 5.6 18.4 M 3 12 A 9 9 0 0 1 5.6 5.6",
  lasso: "M 12 4 A 7 5 0 1 1 11.99 4 Z M 12 14 C 10.5 17 10.5 19 12 20 C 13.5 19 13.5 17 12 14",
  "polygon-lasso": "M 5 6 L 12 3 L 19 7 L 17 15 L 9 20 L 4 14 Z M 9 20 C 8 22 6 22 5 21",
  wand: "M 15 4 L 15 7 M 13.5 5.5 L 16.5 5.5 M 6 15 L 13 8 M 14 9 L 17.5 12.5 M 9 19 L 5 15 M 5 15 L 3 21 L 9 19 Z",
  "quick-select": "M 12 4 A 8 8 0 0 1 20 12 M 20 12 A 8 8 0 0 1 12 20 M 12 20 A 8 8 0 0 1 4 12 M 4 12 A 8 8 0 0 1 12 4 M 18 5 L 21 2 M 19 2 L 21 2 L 21 4",
  brush: "M 14 4 L 20 10 L 12 18 L 7 19 L 6 14 Z M 7 19 L 4 20 L 5 17 M 14 4 L 17 7",
  eraser: "M 3 20 L 21 20 M 8 20 L 4 16 L 13.5 6.5 L 18.5 11.5 L 10 20 M 13.5 6.5 L 16 4 L 21 9 L 18.5 11.5",
  bucket: "M 11 4 L 19 12 L 11.5 19.5 A 2 2 0 0 1 8.7 19.5 L 4 14.8 A 2 2 0 0 1 4 12 L 11 4 Z M 8 7 L 15 7",
  gradient: "M 4 4 L 20 4 L 20 20 L 4 20 Z M 4 20 L 20 4",
  shape: "M 4 4 L 10 4 L 10 10 L 4 10 Z M 14 14 L 20 14 L 20 20 L 14 20 Z M 17 4 L 20 7 M 20 4 L 17 7",
  eyedropper: "M 14 5 L 7 12 L 4 20 L 12 17 L 19 10 M 14 5 L 16 3 A 2.8 2.8 0 0 1 21 8 L 19 10 Z",
  "zoom-in": "M 11 4 A 7 7 0 1 1 10.99 4 Z M 16 16 L 21 21 M 8 11 L 14 11 M 11 8 L 11 14",
  "zoom-out": "M 11 4 A 7 7 0 1 1 10.99 4 Z M 16 16 L 21 21 M 8 11 L 14 11",
  sparkle: "M 12 3 L 13.8 8.2 L 19 10 L 13.8 11.8 L 12 17 L 10.2 11.8 L 5 10 L 10.2 8.2 Z M 19 15 L 19.8 17.2 L 22 18 L 19.8 18.8 L 19 21 L 18.2 18.8 L 16 18 L 18.2 17.2 Z",
};

export function StudioIcon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={PATHS[name] ?? PATHS.pen} />
    </svg>
  );
}
