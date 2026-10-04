export function Icon({
  name,
}: {
  name: "team" | "profile" | "gatherings" | "brand";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === "team" ? (
        <>
          <path d="M8 3h8v6a4 4 0 0 1-8 0V3Z" />
          <path d="M8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-6-3h4l2 3H8l2-3Z" />
        </>
      ) : name === "profile" ? (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </>
      ) : name === "gatherings" ? (
        <>
          <path d="M8 7h8a4 4 0 0 1 4 3l1 7a2 2 0 0 1-3 2l-4-3h-4l-4 3a2 2 0 0 1-3-2l1-7a4 4 0 0 1 4-3Z" />
          <path d="M7 10v4m-2-2h4m6-1h.01m3 3h.01" />
        </>
      ) : (
        <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />
      )}
    </svg>
  );
}
