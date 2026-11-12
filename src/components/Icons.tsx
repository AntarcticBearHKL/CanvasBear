import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...props }: IconProps) {
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
      {children}
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5h6l2 3h9v11H3z" />
      <path d="M12 11v5M9.5 13.5 12 16l2.5-2.5" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12 4.5 4.5L19 7" />
    </Svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </Svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </Svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16z" />
      <path d="m14.5 6.5 3 3" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="m6.5 7 1 13h9l1-13" />
      <path d="M10 11v5M14 11v5" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8" y="8" width="11" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8.5h16M4 15.5h16" />
      <circle cx="9" cy="8.5" r="2" />
      <circle cx="15" cy="15.5" r="2" />
    </Svg>
  );
}

export function MinimizeIcon() {
  return (
    <Svg size={16}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function MaximizeIcon() {
  return (
    <Svg size={15}>
      <path d="M5 5h14v14H5z" />
    </Svg>
  );
}

export function CloseIcon() {
  return (
    <Svg size={16}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function ChevronIcon({ open = false, ...props }: IconProps & { open?: boolean }) {
  return (
    <Svg {...props}>
      <path d={open ? "m6 15 6-6 6 6" : "m9 6 6 6-6 6"} />
    </Svg>
  );
}


// SVG paths copied from the Rust Slint icon set
// (`crates/app/ui/components/icons.slint`). The canvas dock and hover bar use
// these instead of Unicode glyphs so the Electron toolbar matches the native
// app.
const CANVAS_ICON_PATHS: Record<string, string> = {
  "panel-left": "M 3 4 L 21 4 L 21 20 L 3 20 Z M 9 4 L 9 20",
  undo: "M 9 14 L 4 9 L 9 4 M 4 9 L 14.5 9 A 5.5 5.5 0 0 1 14.5 20 L 11 20",
  redo: "M 15 14 L 20 9 L 15 4 M 20 9 L 9.5 9 A 5.5 5.5 0 0 0 9.5 20 L 13 20",
  sparkles: "M 12 3 L 13.7 9.3 L 20 11 L 13.7 12.7 L 12 19 L 10.3 12.7 L 4 11 L 10.3 9.3 Z",
  image: "M 3 4 L 21 4 L 21 20 L 3 20 Z M 3 16 L 9 11 L 14 16 L 17 13 L 21 16 M 9 9.4 A 1.4 1.4 0 1 1 8.99 9.4 Z",
  images: "M 6 3 L 19 3 L 19 16 M 3 6 L 16 6 L 16 19 L 3 19 Z M 3 15.5 L 7 12 L 10 14.5 L 12 12.5 L 16 15.5",
  "folder-input": "M 3 5 L 9 5 L 11 8 L 20 8 L 20 19 L 3 19 Z M 9 14 L 15 14 M 12 11 L 15 14 L 12 17",
  "smart-canvas": "M 3 6 L 21 6 L 21 20 L 3 20 Z M 3 16.5 L 8.5 11.5 L 13.5 16 L 16.5 13 L 21 17 M 18.5 2 L 19.3 4.2 L 21.5 5 L 19.3 5.8 L 18.5 8 L 17.7 5.8 L 15.5 5 L 17.7 4.2 Z",
  svg: "M 3 3 L 21 3 L 21 21 L 3 21 Z M 6 18 C 9 8, 15 18, 18 7 M 6 21 L 6 18 M 18 7 L 18 4",
  trash: "M 3 6 L 21 6 M 8 6 L 8 4 L 16 4 L 16 6 M 5 6 L 6 21 L 18 21 L 19 6 M 10 10 L 10 17 M 14 10 L 14 17",
  settings: "M 4 8.5 L 20 8.5 M 4 15.5 L 20 15.5 M 9 8.5 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0 M 15 15.5 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0",
  info: "M 12 2.4 A 9.6 9.6 0 1 1 11.99 2.4 Z M 12 6.4 A 1.6 1.6 0 1 1 11.99 6.4 Z M 12 10.6 L 12 17.6",
  copy: "M 9 9 L 21 9 L 21 21 L 9 21 Z M 5 15 L 3 15 L 3 3 L 15 3 L 15 5",
  layers: "M 12 2 L 2 7 L 12 12 L 22 7 Z M 2 12 L 12 17 L 22 12 M 2 17 L 12 22 L 22 17",
  grid: "M 3 3 L 10 3 L 10 10 L 3 10 Z M 14 3 L 21 3 L 21 10 L 14 10 Z M 3 14 L 10 14 L 10 21 L 3 21 Z M 14 14 L 21 14 L 21 21 L 14 21 Z",
  compass: "M 12 2 A 10 10 0 1 1 11.99 2 Z M 16.2 7.8 L 14.2 14.2 L 7.8 16.2 L 9.8 9.8 Z",
  "file-text": "M 14 2 L 6 2 L 6 22 L 18 22 L 18 6 Z M 14 2 L 14 6 L 18 6 M 9 12 L 15 12 M 9 16 L 13 16",
  wand: "M 15 4 L 15 7 M 13.5 5.5 L 16.5 5.5 M 6 15 L 13 8 M 14 9 L 17.5 12.5 M 9 19 L 5 15 M 5 15 L 3 21 L 9 19 Z",
  circle: "M 12 3 A 9 9 0 1 1 11.99 3 Z",
  home: "M 3 11 L 12 3 L 21 11 M 5 10 L 5 21 L 19 21 L 19 10 M 10 21 L 10 15 L 14 15 L 14 21",
  maximize: "M 8 3 L 3 3 L 3 8 M 21 8 L 21 3 L 16 3 M 3 16 L 3 21 L 8 21 M 16 21 L 21 21 L 21 16",
};

export function CanvasIcon({ name, size = 18, ...props }: IconProps & { name: string }) {
  return (
    <Svg size={size} {...props}>
      <path d={CANVAS_ICON_PATHS[name] ?? CANVAS_ICON_PATHS.image} />
    </Svg>
  );
}
