export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={className}>
      <span style={{ color: "var(--brand-navy)" }}>Stock</span>
      <span style={{ color: "var(--brand-orange)" }}>Master</span>
    </div>
  );
}
