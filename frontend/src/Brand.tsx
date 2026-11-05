/** The name beside the mark provides its accessible label. */
export function BrandMark({ className = "brand-icon" }: { className?: string }) {
  return (
    <img
      className={className}
      src="/branding/streamhive-mark.svg"
      width="32"
      height="32"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
