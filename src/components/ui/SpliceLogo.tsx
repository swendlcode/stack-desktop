interface SpliceLogoProps {
  size?: number | string;
  /** Any CSS colour; `currentColor` lets it follow the surrounding text. */
  color?: string;
  className?: string;
  /**
   * Accepted for signature parity with the iconsax icons so this can sit in
   * the same nav-item list. The mark has one weight, so it is ignored.
   */
  variant?: string;
}

/**
 * Splice's own mark, used to label the Splice library — their trademark, shown
 * to refer to their service, not as a Stack asset. Single-weight and drawn in
 * `currentColor` so it tints like every other nav icon.
 */
export function SpliceLogo({
  size = 16,
  color = 'currentColor',
  className,
}: SpliceLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="m9.81197 14.5865c0 .0992-.07619.1809-.17298.1908-.15058.0163-.30346.0247-.45837.0247-2.3885 0-4.32474-1.9326-4.32474-4.3167 0-1.19203.48404-2.27122 1.26667-3.05234l4.59855-4.59006c.5218-.5208 1.2426-.8429 2.0387-.8429 1.5924 0 2.8832 1.28846 2.8832 2.87784 0 .79488-.3229 1.51444-.8448 2.03525l-5.27782 5.26801c-.56296.5619-.56296 1.473 0 2.0349l.23519.2347c.03488.0348.0564.0828.0564.1358z" />
      <path d="m14.3398 8.72642c.1505-.01617.3038-.02561.4587-.02567 2.3885.00006 4.3247 1.93265 4.3247 4.31665 0 1.1926-.4845 2.2722-1.2677 3.0533l-5.0957 5.0865c-.5217.5207-1.2425.8428-2.0387.8428-1.59232 0-2.88311-1.2884-2.88311-2.8778 0-.7947.3227-1.5141.84447-2.0349l5.77624-5.7656c.563-.5619.563-1.47299 0-2.03491l-.2351-.23469c-.0349-.03475-.0564-.08277-.0564-.1358 0-.0992.0757-.17994.1726-.18988z" />
    </svg>
  );
}
