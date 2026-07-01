import { LogoMark } from './LogoMark';
import { DEFAULT_FOLDER_COLOR } from '../../utils/colorUtils';

interface FolderIconProps {
  /** Fill color — a stack's chosen color, or neutral gray by default. */
  color?: string;
  size?: number;
  className?: string;
  /** Show the Stack logo mark centered inside the folder. */
  showMark?: boolean;
}

/**
 * Folder glyph adapted from stack-assets/folder.svg — the original's baked-in
 * blue gradients/mask/blur are dropped so a single `color` prop can tint it
 * (needed for per-stack coloring). The dark overlay path fakes the front
 * panel's depth that the original achieved with gradients. The Stack logo
 * mark sits centered inside as a light watermark. The viewBox is cropped
 * tightly to the folder's own bounds (the source asset reserved extra
 * canvas below for a blur filter we don't use) so the tab isn't squeezed
 * down by unused padding.
 */
export function FolderIcon({
  color = DEFAULT_FOLDER_COLOR,
  size = 40,
  className,
  showMark = true,
}: FolderIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="79.8916 0 413.0004 373"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M146.468 0C109.699 0 79.8916 29.8072 79.8916 66.5763V145.522V153.369V266.478C79.8916 303.764 79.8916 322.407 87.148 336.649C93.5309 349.176 103.716 359.361 116.243 365.744C130.484 373 149.127 373 186.414 373H386.369C423.656 373 442.299 373 456.54 365.744C469.067 359.361 479.252 349.176 485.635 336.649C492.892 322.407 492.892 303.764 492.892 266.478V145.522C492.892 108.236 492.892 89.5928 485.635 75.3513C479.252 62.8242 469.067 52.6393 456.54 46.2564C442.299 39 423.656 39 386.369 39H341.684C307.321 39 274.309 0 239.946 0H146.468Z"
        fill={color}
      />
      <path
        d="M79.8915 200C79.8915 162.663 79.6312 143.261 86.8915 129C93.278 116.456 103.358 106.392 115.892 100C130.141 92.7338 149.585 93 186.892 93H385.892C423.198 93 442.642 92.7338 456.892 100C469.426 106.392 479.505 116.456 485.892 129C493.152 143.261 492.892 162.663 492.892 200V266C492.892 303.337 493.152 322.739 485.892 337C479.505 349.544 469.426 359.608 456.892 366C442.642 373.266 423.198 373 385.892 373H186.892C149.585 373 130.141 373.266 115.892 366C103.358 359.608 93.278 349.544 86.8915 337C79.6312 322.739 79.8915 303.337 79.8915 266V200Z"
        fill="#000000"
        fillOpacity={0.18}
      />
      {showMark && (
        <g transform="translate(206 153)">
          <LogoMark size={160} color="#fff" opacity={0.85} />
        </g>
      )}
    </svg>
  );
}
